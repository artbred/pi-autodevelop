import { complete, StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { isGoalMutationCommand } from "./lib/bash-guard.js";
import {
	BACKLOG_KINDS,
	ITEM_STATUSES,
	LOOP_PHASES,
	LOOP_SKILL_COMMAND,
	QUALITY_HARDENING_PRIORITY,
	QUALITY_OBJECTIVE_NAMES,
	QUALITY_OBJECTIVE_STATUSES,
	RESEARCH_SCOPES,
} from "./lib/constants.js";
import {
	createGoalScaffoldContent,
	makeGoalReadOnly,
	readGoalSnapshot,
	scaffoldGoalFile,
	verifyGoalSnapshot,
} from "./lib/goal.js";
import { probeResearchProviders, runResearchAction } from "./lib/research.js";
import {
	applyStateAction,
	allEnabledQualityObjectivesResolved,
	buildLoopContext,
	cloneLoopState,
	createInitialLoopState,
	formatLoopStateMarkdown,
	getRecentResearchArtifacts,
	getUnresolvedQualityObjectives,
	getUnresolvedResearchBlockers,
	isLoopRunning,
	nextRunnablePhase,
	reconstructStateFromEntries,
} from "./lib/state-machine.js";
import { buildToolProfile } from "./lib/tool-profiles.js";
import { detectUncertaintyMarker } from "./lib/uncertainty.js";
import {
	createVerificationRequest,
	ensureVerifierPaths,
	isVerificationReportStale,
	persistVerificationReport,
	persistVerificationRequest,
	resolveVerifierBackend,
	runVerifierWithFallback,
} from "./lib/verifier.js";

const BacklogItemSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable item id. Omit to auto-generate." })),
	title: Type.String({ description: "Short actionable title." }),
	kind: StringEnum(BACKLOG_KINDS),
	status: Type.Optional(StringEnum(ITEM_STATUSES)),
	notes: Type.Optional(Type.String({ description: "Progress, findings, or constraints." })),
	acceptanceCriteria: Type.Optional(Type.String({ description: "What proves the item is done." })),
	objectiveRefs: Type.Optional(
		Type.Array(StringEnum(QUALITY_OBJECTIVE_NAMES), {
			description: "Quality objectives advanced by this item, such as scalability or reliability.",
		}),
	),
	researchRequired: Type.Optional(Type.Boolean({ description: "Whether this item is blocked on explicit research evidence." })),
	evidenceRefs: Type.Optional(Type.Array(Type.String({ description: "Research artifact ids that justify this item." }))),
	dependsOnResearchItemIds: Type.Optional(
		Type.Array(Type.String({ description: "Research item ids that must complete before this item can complete." })),
	),
	verificationRequired: Type.Optional(Type.Boolean({ description: "Whether this item requires verifier approval before completion." })),
});

const BacklogItemPatchSchema = Type.Partial(
	Type.Object({
		title: Type.String(),
		kind: StringEnum(BACKLOG_KINDS),
		status: StringEnum(ITEM_STATUSES),
		notes: Type.String(),
		acceptanceCriteria: Type.String(),
		objectiveRefs: Type.Array(StringEnum(QUALITY_OBJECTIVE_NAMES)),
		researchRequired: Type.Boolean(),
		evidenceRefs: Type.Array(Type.String()),
		dependsOnResearchItemIds: Type.Array(Type.String()),
		verificationRequired: Type.Boolean(),
	}),
);

const AutoDevelopStateSchema = Type.Object({
	action: StringEnum([
		"get",
		"replace_plan",
		"update_item",
		"set_phase",
		"update_objective",
		"flag_uncertainty",
		"request_verification",
		"block",
		"complete",
	]),
	items: Type.Optional(Type.Array(BacklogItemSchema)),
	itemId: Type.Optional(Type.String()),
	patch: Type.Optional(BacklogItemPatchSchema),
	phase: Type.Optional(StringEnum(LOOP_PHASES)),
	currentItemId: Type.Optional(Type.String()),
	objective: Type.Optional(StringEnum(QUALITY_OBJECTIVE_NAMES)),
	status: Type.Optional(StringEnum(QUALITY_OBJECTIVE_STATUSES)),
	evidence: Type.Optional(Type.String()),
	reason: Type.Optional(Type.String()),
	question: Type.Optional(Type.String()),
	scope: Type.Optional(StringEnum(RESEARCH_SCOPES)),
	objectiveRefs: Type.Optional(Type.Array(StringEnum(QUALITY_OBJECTIVE_NAMES))),
	summary: Type.Optional(Type.String()),
	verificationSummary: Type.Optional(Type.String()),
	failure: Type.Optional(Type.String()),
});

const AutoDevelopResearchSchema = Type.Object({
	action: StringEnum(["health", "query", "fetch"]),
	scope: Type.Optional(StringEnum(RESEARCH_SCOPES)),
	query: Type.Optional(Type.String({ description: "Research question or search string." })),
	target: Type.Optional(Type.String({ description: "File path or URL to fetch into a persisted research artifact." })),
	artifactId: Type.Optional(Type.String({ description: "Existing artifact id to refetch or cite." })),
	objectiveRefs: Type.Optional(Type.Array(StringEnum(QUALITY_OBJECTIVE_NAMES))),
});

function formatShortHash(hash?: string) {
	return hash ? hash.slice(0, 12) : "unknown";
}

function hasOpenBacklogItem(state: ReturnType<typeof cloneLoopState>) {
	return state?.backlog?.some((item) => item.status === "pending" || item.status === "in_progress");
}

function formatProviderSummary(state: ReturnType<typeof cloneLoopState>) {
	if (!state?.researchProviders) return "research providers unknown";

	return ["local", "searxng", "pinchtab"]
		.map((provider) => {
			const current = state.researchProviders[provider];
			if (!current) return `${provider}:missing`;
			if (current.healthy) return `${provider}:healthy`;
			if (current.configured) return `${provider}:degraded`;
			return `${provider}:off`;
		})
		.join(", ");
}

function formatVerifierSummary(state: ReturnType<typeof cloneLoopState>) {
	if (!state?.verifierBackend) return "verifier unknown";

	const backend = state.verifierBackend;
	if (!backend.available) {
		return `${backend.resolved}:unavailable`;
	}
	if (backend.degradedReason) {
		return `${backend.resolved}:degraded`;
	}
	return `${backend.resolved}:healthy`;
}

function createRequestId(prefix: string, itemId: string) {
	return `${prefix}-${Date.now()}-${itemId.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40)}`;
}

function createVerifierFailureReport(request: { id: string; fingerprint: string }, summary: string, findings: string[] = []) {
	return {
		id: `report-${request.id}`,
		requestId: request.id,
		requestFingerprint: request.fingerprint,
		createdAt: new Date().toISOString(),
		status: "fail" as const,
		summary,
		findings,
		missingEvidence: [],
		recommendedNextSteps: ["Address the verifier findings, then request verification again."],
		rawText: "",
	};
}

function buildQualityPrompt(state: ReturnType<typeof cloneLoopState>) {
	const unresolved = getUnresolvedQualityObjectives(state);
	const researchBlockers = getUnresolvedResearchBlockers(state);
	const unresolvedText = unresolved.length ? unresolved.join(", ") : "none";
	const blockerText = researchBlockers.length ? researchBlockers.map((item) => item.title).join("; ") : "none";

	if (!hasOpenBacklogItem(state)) {
		if (state?.mode === "delivery") {
			return `The backlog is empty. Replan delivery work so the plan already accounts for unresolved quality objectives: ${unresolvedText}.`;
		}

		if (state?.mode === "hardening" || state?.mode === "improvement") {
			return `The backlog is empty. Replan immediately. Prioritize unresolved quality objectives first in this order: ${QUALITY_HARDENING_PRIORITY.join(", ")}. Unresolved: ${unresolvedText}.`;
		}
	}

	return `Unresolved quality objectives: ${unresolvedText}. Unresolved research blockers: ${blockerText}.`;
}

function buildLoopTurnPrompt(state: ReturnType<typeof cloneLoopState>, reason: string) {
	const currentItem = state?.backlog.find((item) => item.id === state.currentItemId);
	const currentItemLine = currentItem ? `Current item: [${currentItem.kind}] ${currentItem.title}` : "Current item: none";
	const modeInstructions =
		state?.mode === "delivery"
			? `Stay in delivery mode until the primary goal is satisfied. When it is satisfied, call autodevelop_state with action="complete" to enter hardening mode.`
			: state?.mode === "hardening"
				? `You are in hardening mode. Do not treat the loop as done. Resolve enabled quality objectives before drifting into broader improvement work.`
				: `You are in improvement mode. Keep finding justified ways to make the system better without waiting for a new user task.`;

	return `${LOOP_SKILL_COMMAND} reason=${reason}

Continue the autonomous development loop.

Goal file: ${state?.goal?.path ?? "unknown"}
Goal hash: ${state?.goal?.hash ?? "unknown"}
Mode: ${state?.mode ?? "unknown"}
Phase: ${state?.phase ?? "unknown"}
Primary goal satisfied: ${state?.goalSatisfied ? "yes" : "no"}
Iteration: ${state?.iteration ?? 0}
Research providers: ${formatProviderSummary(state)}
Verifier: ${formatVerifierSummary(state)}
${currentItemLine}

Use autodevelop_state with action="get" first, then proceed with the next best action.
Use autodevelop_research as the default research interface for repo and web research.
If you hit uncertainty, unknown behavior, assumptions, or missing evidence during code/test/verify work, call autodevelop_state with action="flag_uncertainty" immediately and continue through a dedicated research item.
Every backlog item is verifier-gated. When an item satisfies its acceptanceCriteria, call autodevelop_state with action="request_verification" instead of marking it done directly.
If the backlog is empty, create one with replace_plan.
Use autodevelop_state with action="block" only when the entire loop cannot proceed safely. If only one backlog item is blocked and other work remains, mark that item blocked and continue with the next runnable work.
Use update_objective to record evidence as you address reliability, scalability, throughput, latency, memory efficiency, and performance.
Inspect large-data and high-load behavior for chunking, batching, streaming, pagination, memory pressure, queue depth, retries, timeouts, idempotency, and backpressure unless explicitly opted out.
${buildQualityPrompt(state)}
${modeInstructions}`;
}

function renderResearchResultMarkdown(result: {
	summary?: string;
	content?: string;
	artifact?: { id: string } | null;
	fallbackOrder?: string[];
}) {
	const lines = ["## AutoDevelop Research", ""];
	if (result.summary) lines.push(result.summary, "");
	if (result.artifact?.id) lines.push(`- Artifact: \`${result.artifact.id}\``, "");
	if (result.fallbackOrder?.length) lines.push(`- Providers: ${result.fallbackOrder.join(" -> ")}`, "");
	if (result.content) lines.push(result.content);
	return lines.join("\n").trim();
}

async function resolveCandidatePath(cwd: string, candidatePath: string) {
	const absolutePath = resolve(cwd, candidatePath);
	try {
		return await realpath(absolutePath);
	} catch {
		return absolutePath;
	}
}

function extractTextFromContent(content: unknown) {
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is { type: string; text: string } => Boolean(item && typeof item === "object" && (item as { type?: string }).type === "text"))
		.map((item) => item.text)
		.join("\n")
		.trim();
}

function extractAssistantTextFromEntries(entries: unknown[]) {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry?.type !== "message") continue;
		if (entry.message?.role !== "assistant") continue;
		const text = extractTextFromContent(entry.message.content);
		if (text) return text;
	}

	return "";
}

export default function autodevelopExtension(pi: ExtensionAPI) {
	let loopState: ReturnType<typeof cloneLoopState> | null = null;
	let stateQueue = Promise.resolve();
	let pendingAutoTurn = false;
	let turnStartEntryCount = 0;
	let sawResearchToolThisTurn = false;
	let sawFlagUncertaintyThisTurn = false;

	function emitLoopMessage(content: string) {
		pi.sendMessage(
			{
				customType: "autodevelop-note",
				content,
				display: true,
			},
			{ triggerTurn: false },
		);
	}

	function updateLoopUi(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (!loopState) {
			ctx.ui.setStatus("autodevelop", undefined);
			ctx.ui.setWidget("autodevelop", undefined);
			return;
		}

		const total = loopState.backlog.length;
		const done = loopState.backlog.filter((item) => item.status === "done").length;
		const unresolvedCount = getUnresolvedQualityObjectives(loopState).length;
		const researchBlockers = getUnresolvedResearchBlockers(loopState).length;
		const pendingReviews = loopState.pendingVerificationItemId ? 1 : 0;
		const statusLine = `AD ${loopState.mode}/${loopState.phase} ${done}/${total} q:${unresolvedCount} r:${researchBlockers} v:${pendingReviews} goal:${basename(loopState.goal.path)}`;
		ctx.ui.setStatus("autodevelop", statusLine);

		const latestReport = loopState.verificationReports?.slice(-1)[0];
		const widgetLines = [
			`goal ${basename(loopState.goal.path)} hash ${formatShortHash(loopState.goal.hash)}`,
			`mode ${loopState.mode} phase ${loopState.phase} iteration ${loopState.iteration}`,
			`quality ${unresolvedCount} research ${researchBlockers} review ${pendingReviews}`,
			`providers ${formatProviderSummary(loopState)}`,
			`verifier ${formatVerifierSummary(loopState)}`,
		];
		if (latestReport) {
			widgetLines.push(`last verifier [${latestReport.status}] ${latestReport.summary || "No summary"}`);
		}
		for (const item of loopState.backlog.slice(0, 6)) {
			const prefix = item.id === loopState.currentItemId ? ">" : "-";
			const refs = item.objectiveRefs?.length ? ` -> ${item.objectiveRefs.join(",")}` : "";
			const evidence = item.evidenceRefs?.length ? ` ev:${item.evidenceRefs.length}` : "";
			const verification = item.verificationRequired ? ` vr:${item.verificationStatus}` : "";
			widgetLines.push(`${prefix} [${item.status}] [${item.kind}] ${item.title}${refs}${evidence}${verification}`);
		}
		ctx.ui.setWidget("autodevelop", widgetLines);
	}

	function persistControlState(reason: string) {
		if (!loopState) return;
		pi.appendEntry("autodevelop-control", {
			reason,
			timestamp: Date.now(),
			state: cloneLoopState(loopState),
		});
	}

	function syncToolProfile() {
		if (!loopState) return;
		const profile = buildToolProfile(pi.getAllTools(), loopState);
		if (profile) {
			pi.setActiveTools(profile);
		}
	}

	async function withStateLock<T>(fn: () => Promise<T>) {
		const next = stateQueue.then(fn, fn);
		stateQueue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	async function refreshResearchProviders(ctx?: ExtensionContext, persistReason?: string) {
		if (!loopState) return;
		const providers = await probeResearchProviders();
		loopState = applyStateAction(loopState, "sync_research_providers", { providers });
		if (persistReason) persistControlState(persistReason);
		syncToolProfile();
		if (ctx) updateLoopUi(ctx);
	}

	async function refreshVerifierBackend(ctx?: ExtensionContext, persistReason?: string) {
		if (!loopState) return;
		const backend = resolveVerifierBackend({ cwd: ctx?.cwd ?? dirname(loopState.goal.path) ?? process.cwd() });
		loopState = applyStateAction(loopState, "sync_verifier_backend", { backend });
		if (persistReason) persistControlState(persistReason);
		syncToolProfile();
		if (ctx) updateLoopUi(ctx);
	}

	async function markLoopBlocked(ctx: ExtensionContext, reason: string) {
		if (!loopState) return;
		loopState = applyStateAction(loopState, "block", { reason });
		persistControlState("goal-integrity-failed");
		syncToolProfile();
		updateLoopUi(ctx);
		emitLoopMessage(`## AutoDevelop Blocked\n\n${reason}`);
	}

	async function ensureGoalIsUnchanged(ctx: ExtensionContext) {
		if (!loopState?.goal) return true;
		const result = await verifyGoalSnapshot(loopState.goal);
		if (result.ok) return true;

		const reason = result.error
			? `Goal file is no longer readable at \`${loopState.goal.path}\`: ${result.error}`
			: `Goal file changed outside the loop. Expected hash \`${loopState.goal.hash}\`, found \`${result.currentHash ?? "unknown"}\`.`;
		await markLoopBlocked(ctx, reason);
		return false;
	}

	async function hydrateState(ctx: ExtensionContext) {
		loopState = reconstructStateFromEntries(ctx.sessionManager.getBranch());
		if (loopState) {
			await refreshResearchProviders(ctx);
			await refreshVerifierBackend(ctx);
		}
		syncToolProfile();
		updateLoopUi(ctx);
	}

	async function queueLoopTurn(ctx: ExtensionContext, reason: string) {
		if (!loopState || !isLoopRunning(loopState)) return;
		if (loopState.pendingVerificationItemId) return;
		if (pendingAutoTurn || ctx.hasPendingMessages()) return;
		if (!(await ensureGoalIsUnchanged(ctx))) return;

		loopState = cloneLoopState(loopState);
		if (loopState.mode === "hardening" && allEnabledQualityObjectivesResolved(loopState)) {
			loopState.mode = "improvement";
		}
		loopState.iteration += 1;
		persistControlState(`queue:${reason}`);
		syncToolProfile();
		updateLoopUi(ctx);

		pendingAutoTurn = true;
		try {
			pi.sendUserMessage(buildLoopTurnPrompt(loopState, reason));
		} catch (error) {
			pendingAutoTurn = false;
			const message = error instanceof Error ? error.message : String(error);
			emitLoopMessage(`## AutoDevelop Error\n\nFailed to queue the next loop turn.\n\n${message}`);
		}
	}

	async function enforceUncertaintyResearch(ctx: ExtensionContext) {
		if (!loopState || !isLoopRunning(loopState)) return false;
		if (!["implementing", "testing", "verifying"].includes(loopState.phase)) return false;
		if (sawFlagUncertaintyThisTurn || sawResearchToolThisTurn) return false;

		const entries = ctx.sessionManager.getBranch().slice(turnStartEntryCount);
		const assistantText = extractAssistantTextFromEntries(entries);
		const marker = detectUncertaintyMarker(assistantText);
		if (!marker) return false;

		const currentItem = loopState.backlog.find((item) => item.id === loopState.currentItemId);
		if (!currentItem || currentItem.kind === "research") return false;

		loopState = applyStateAction(loopState, "flag_uncertainty", {
			itemId: currentItem.id,
			reason: `Uncertainty detected in the agent response ("${marker}").`,
			question: `Resolve the uncertainty that blocked "${currentItem.title}".`,
			scope: "auto",
			objectiveRefs: currentItem.objectiveRefs,
		});
		persistControlState("uncertainty-safety-net");
		syncToolProfile();
		updateLoopUi(ctx);
		emitLoopMessage(
			`## AutoDevelop Research Required\n\nDetected uncertainty in the latest agent response ("${marker}"). The active item was paused and a linked research item was inserted before implementation can continue.`,
		);
		await queueLoopTurn(ctx, "uncertainty");
		return true;
	}

	pi.registerCommand("autodevelop", {
		description: "Manage the autonomous goal-driven development loop",
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();
			const [subcommand = "", ...rest] = trimmedArgs.split(/\s+/).filter(Boolean);
			const subcommandArgs = rest.join(" ");

			switch (subcommand) {
				case "scaffold": {
					if (!subcommandArgs) {
						ctx.ui.notify("Usage: /autodevelop scaffold <goalPath>", "warning");
						return;
					}

					try {
						const goalPath = await scaffoldGoalFile(ctx.cwd, subcommandArgs);
						emitLoopMessage(`## AutoDevelop Goal Scaffolded\n\nCreated \`${goalPath}\`.\n\n${createGoalScaffoldContent()}`);
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
					return;
				}

				case "start": {
					if (!subcommandArgs) {
						ctx.ui.notify("Usage: /autodevelop start <goalPath>", "warning");
						return;
					}

					try {
						const goalSnapshot = await readGoalSnapshot(ctx.cwd, subcommandArgs);
						const providers = await probeResearchProviders();
						const verifierBackend = resolveVerifierBackend({ cwd: ctx.cwd });
						goalSnapshot.readonlyProtection = await makeGoalReadOnly(goalSnapshot.path);
						loopState = createInitialLoopState(goalSnapshot, providers, verifierBackend);
						persistControlState("start");
						syncToolProfile();
						updateLoopUi(ctx);
						emitLoopMessage(
							`## AutoDevelop Started\n\n- Goal: \`${goalSnapshot.path}\`\n- Hash: \`${goalSnapshot.hash}\`\n- Read-only protection: ${goalSnapshot.readonlyProtection ? "enabled" : "best effort only"}\n- Default hardening priorities: ${QUALITY_HARDENING_PRIORITY.join(", ")}\n- Research providers: ${formatProviderSummary(loopState)}\n- Verifier: ${formatVerifierSummary(loopState)}`,
						);
						await queueLoopTurn(ctx, "start");
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
					return;
				}

				case "status": {
					emitLoopMessage(formatLoopStateMarkdown(loopState));
					return;
				}

				case "pause": {
					if (!loopState) {
						ctx.ui.notify("No active autodevelop loop.", "warning");
						return;
					}

					loopState = applyStateAction(loopState, "set_phase", { phase: "paused" });
					persistControlState("pause");
					syncToolProfile();
					updateLoopUi(ctx);
					emitLoopMessage("## AutoDevelop Paused");
					return;
				}

				case "resume": {
					if (!loopState) {
						ctx.ui.notify("No autodevelop loop to resume.", "warning");
						return;
					}

					await refreshResearchProviders(ctx, "resume-providers");
					await refreshVerifierBackend(ctx, "resume-verifier");
					const nextPhase = nextRunnablePhase(loopState);
					loopState = applyStateAction(loopState, "set_phase", {
						phase: nextPhase,
						currentItemId: loopState.currentItemId ?? undefined,
						failure: "",
					});
					loopState.stopReason = "";
					persistControlState("resume");
					syncToolProfile();
					updateLoopUi(ctx);
					emitLoopMessage(`## AutoDevelop Resumed\n\nMode: \`${loopState.mode}\`\n\nPhase: \`${nextPhase}\``);
					await queueLoopTurn(ctx, "resume");
					return;
				}

				case "stop": {
					if (!loopState) {
						ctx.ui.notify("No autodevelop loop to stop.", "warning");
						return;
					}

					loopState = cloneLoopState(loopState);
					loopState.phase = "stopped";
					loopState.stopReason = "Stopped by user";
					persistControlState("stop");
					syncToolProfile();
					updateLoopUi(ctx);
					emitLoopMessage("## AutoDevelop Stopped\n\nThe loop will not auto-continue.");
					return;
				}

				default: {
					ctx.ui.notify("Usage: /autodevelop <start|status|pause|resume|stop|scaffold> [args]", "info");
				}
			}
		},
	});

	pi.registerTool({
		name: "autodevelop_state",
		label: "AutoDevelop State",
		description:
			"Manage the autonomous development loop state. Use get before acting, replace_plan to define backlog items, update_item as work progresses, request_verification to trigger the external verifier gate, set_phase to match the work phase, update_objective to record hardening evidence, flag_uncertainty when research is required, block when stuck, and complete only after the primary goal is satisfied and the active item has already passed verification.",
		promptSnippet: "Inspect and update the autonomous loop state, research blockers, verifier-gated backlog, hardening objectives, phase, and completion status.",
		promptGuidelines: [
			"Call autodevelop_state with action=get before replacing the plan or claiming completion.",
			"Keep backlog kinds to research, code, test, or verify.",
			"Unless the goal file explicitly opts out, treat reliability, scalability, throughput, latency, memory efficiency, and performance as default success dimensions.",
			"Use autodevelop_research as the default research interface.",
			"Use flag_uncertainty immediately when code, test, or verify work hits assumptions, unknown behavior, unclear failures, or missing evidence.",
			"Every backlog item is verifier-gated. When an item satisfies its acceptanceCriteria, use request_verification instead of marking it done directly.",
			"Tag backlog items with objectiveRefs and attach evidenceRefs when research unblocks later work.",
			"Use update_objective with evidence as you address quality objectives.",
			"Use block only when the entire loop cannot proceed safely or the goal cannot be met with the current constraints. If a single item is blocked but other work remains, block that item and continue.",
		],
		parameters: AutoDevelopStateSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return withStateLock(async () => {
				if (!loopState) {
					return {
						content: [{ type: "text", text: "Error: no autodevelop loop has been started yet." }],
						details: null,
						isError: true,
					};
				}

				try {
					if (params.action === "flag_uncertainty") {
						sawFlagUncertaintyThisTurn = true;
					}

					if (params.action === "request_verification") {
						await refreshVerifierBackend(ctx);

						const requestId = createRequestId("verify", params.itemId ?? "item");
						loopState = applyStateAction(loopState, "request_verification", { ...params, requestId });
						const request = await createVerificationRequest({
							cwd: ctx.cwd,
							state: loopState,
							itemId: params.itemId,
							backend: loopState.verifierBackend,
							requestId,
						});
						const paths = await ensureVerifierPaths(ctx.cwd, loopState.verifierBackend);
						await persistVerificationRequest(paths, request);
						loopState = applyStateAction(loopState, "record_verification_request", { request });
						persistControlState("verification:request");
						syncToolProfile();
						updateLoopUi(ctx);

						let report;
						try {
							const apiKey = ctx.model ? await ctx.modelRegistry.getApiKey(ctx.model) : null;
							const verification = await runVerifierWithFallback({
								request,
								backend: loopState.verifierBackend,
								paths,
								model: ctx.model,
								apiKey,
								signal,
								completeFn: complete,
							});
							report = verification.report;
							if (verification.backend && verification.backend !== loopState.verifierBackend) {
								loopState = applyStateAction(loopState, "sync_verifier_backend", {
									backend: verification.backend,
								});
							}
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							loopState = applyStateAction(loopState, "sync_verifier_backend", {
								backend: {
									...loopState.verifierBackend,
									degradedReason: message,
								},
							});
							report = createVerifierFailureReport(
								request,
								`Verifier backend failed while reviewing "${request.itemTitle}".`,
								[message],
							);
						}

						await persistVerificationReport(paths, report);
						if (isVerificationReportStale(request, loopState)) {
							loopState = applyStateAction(loopState, "discard_verification_request", {
								requestId: request.id,
								reason: `Discarded stale verifier result for request ${request.id} because the task changed while review was running.`,
							});
							persistControlState("verification:stale");
							syncToolProfile();
							updateLoopUi(ctx);

							return {
								content: [
									{
										type: "text",
										text: `## AutoDevelop Verification\n\nVerifier result for \`${request.itemTitle}\` was discarded because the task changed while review was running.\n\n${formatLoopStateMarkdown(loopState)}`,
									},
								],
								details: cloneLoopState(loopState),
							};
						}

						loopState = applyStateAction(loopState, "apply_verification_report", { report });
						persistControlState(`verification:${report.status}`);
						syncToolProfile();
						updateLoopUi(ctx);

						return {
							content: [
								{
									type: "text",
									text: `## AutoDevelop Verification\n\n- Item: \`${request.itemTitle}\`\n- Result: \`${report.status}\`\n- Summary: ${report.summary || "No summary"}\n\n${formatLoopStateMarkdown(loopState)}`,
								},
							],
							details: cloneLoopState(loopState),
						};
					}

					loopState = applyStateAction(loopState, params.action, params);
					if (params.action === "flag_uncertainty") {
						persistControlState("flag-uncertainty");
					}
					if (params.action === "complete") {
						persistControlState("complete");
					}
					syncToolProfile();
					updateLoopUi(ctx);

					return {
						content: [{ type: "text", text: formatLoopStateMarkdown(loopState) }],
						details: cloneLoopState(loopState),
					};
				} catch (error) {
					return {
						content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
						details: cloneLoopState(loopState),
						isError: true,
					};
				}
			});
		},
	});

	pi.registerTool({
		name: "autodevelop_research",
		label: "AutoDevelop Research",
		description:
			"Run guaranteed repo and web research for the autonomous loop. This tool always exists. Use it for provider health, local repo search, optional web search, and fetching files, URLs, or prior research artifacts.",
		promptSnippet: "Run repo or web research, persist evidence, and return artifact ids that later work can cite.",
		promptGuidelines: [
			"Use action=health to inspect provider availability and fallback order.",
			"Use action=query for repo or web research. Prefer scope=repo or scope=auto unless you explicitly need web-only research.",
			"Use action=fetch to capture a local file, URL, or prior artifact as durable evidence.",
			"If you are in code, test, or verify work and research is needed, call autodevelop_state action=flag_uncertainty first. If you forget, the extension will pause the active item automatically when this tool runs.",
			"Carry objectiveRefs when the research relates to reliability, scalability, throughput, latency, memory, or performance.",
		],
		parameters: AutoDevelopResearchSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return withStateLock(async () => {
				if (!loopState) {
					return {
						content: [{ type: "text", text: "Error: no autodevelop loop has been started yet." }],
						details: null,
						isError: true,
					};
				}

				try {
					if (
						(params.action === "query" || params.action === "fetch") &&
						["implementing", "testing", "verifying"].includes(loopState.phase)
					) {
						const currentItem = loopState.backlog.find((item) => item.id === loopState.currentItemId);
						if (currentItem && currentItem.kind !== "research" && !sawFlagUncertaintyThisTurn) {
							loopState = applyStateAction(loopState, "flag_uncertainty", {
								itemId: currentItem.id,
								reason: params.query?.trim() || params.target?.trim() || "Research was needed during execution work.",
								question: params.query?.trim() || params.target?.trim() || `Research needed for ${currentItem.title}`,
								scope: params.scope ?? "auto",
								objectiveRefs: params.objectiveRefs ?? currentItem.objectiveRefs,
							});
							sawFlagUncertaintyThisTurn = true;
							persistControlState("auto-flag-uncertainty");
						}
					}

					const research = await runResearchAction({
						params,
						cwd: ctx.cwd,
						state: loopState,
					});

					loopState = applyStateAction(loopState, "sync_research_providers", { providers: research.providers });
					if (research.artifact) {
						loopState = applyStateAction(loopState, "record_research_artifact", { artifact: research.artifact });
					}
					if (params.action !== "health") {
						sawResearchToolThisTurn = true;
					}
					persistControlState(`research:${params.action}`);
					syncToolProfile();
					updateLoopUi(ctx);

					return {
						content: [
							{
								type: "text",
								text: renderResearchResultMarkdown({
									summary: research.result.summary,
									content: research.result.content,
									artifact: research.artifact,
									fallbackOrder: research.fallbackOrder,
								}),
							},
						],
						details: {
							artifact: research.artifact,
							providers: research.providers,
							fallbackOrder: research.fallbackOrder,
							loopState: cloneLoopState(loopState),
						},
						isError: false,
					};
				} catch (error) {
					return {
						content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
						details: cloneLoopState(loopState),
						isError: true,
					};
				}
			});
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await hydrateState(ctx);
	});
	pi.on("session_switch", async (_event, ctx) => {
		await hydrateState(ctx);
	});
	pi.on("session_fork", async (_event, ctx) => {
		await hydrateState(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		await hydrateState(ctx);
	});

	pi.on("input", async (event) => {
		if (event.source === "extension" && event.text.startsWith(LOOP_SKILL_COMMAND)) {
			pendingAutoTurn = false;
		}
	});

	pi.on("context", async (event) => {
		return {
			messages: event.messages.filter((message) => {
				const candidate = message as { customType?: string };
				return candidate.customType !== "autodevelop-context";
			}),
		};
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!loopState || !isLoopRunning(loopState)) return;
		if (!(await ensureGoalIsUnchanged(ctx))) return;

		turnStartEntryCount = ctx.sessionManager.getBranch().length;
		sawResearchToolThisTurn = false;
		sawFlagUncertaintyThisTurn = false;

		return {
			message: {
				customType: "autodevelop-context",
				content: buildLoopContext(loopState),
				display: false,
			},
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		pendingAutoTurn = false;
		if (!loopState || !isLoopRunning(loopState)) return;
		if (ctx.hasPendingMessages()) return;
		if (await enforceUncertaintyResearch(ctx)) return;
		await queueLoopTurn(ctx, "continue");
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!loopState?.goal?.path) return;

		if (event.toolName === "write" || event.toolName === "edit") {
			const rawPath = (event.input.path ?? event.input.file_path) as string | undefined;
			if (!rawPath) return;
			const candidatePath = await resolveCandidatePath(ctx.cwd, rawPath);
			if (candidatePath === loopState.goal.path) {
				return {
					block: true,
					reason: `The goal file is immutable and cannot be modified: ${loopState.goal.path}`,
				};
			}
		}

		if (event.toolName === "bash") {
			const command = event.input.command as string | undefined;
			if (command && isGoalMutationCommand(command, loopState.goal.path)) {
				return {
					block: true,
					reason: `Blocked bash command because it mutates the immutable goal file: ${loopState.goal.path}`,
				};
			}
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!loopState) return;
		if (!ctx.model) return;

		const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
		if (!apiKey) return;

		const { preparation, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;
		const conversationText = serializeConversation(convertToLlm([...messagesToSummarize, ...turnPrefixMessages]));
		const priorSummaryBlock = previousSummary ? `\n\nPrevious summary:\n${previousSummary}` : "";
		const researchArtifactSummary = getRecentResearchArtifacts(loopState, 5)
			.map((artifact) => `- ${artifact.id} [${artifact.provider}] ${artifact.summary || artifact.query || artifact.target}`)
			.join("\n");
		const researchBlockers = getUnresolvedResearchBlockers(loopState)
			.map((item) => `- ${item.title} (${item.id})`)
			.join("\n");
		const verificationReports = (loopState.verificationReports ?? [])
			.slice(-5)
			.reverse()
			.map((report) => `- ${report.requestId} [${report.status}] ${report.summary || "No summary."}`)
			.join("\n");
		const pendingVerification = loopState.pendingVerificationItemId
			? `- pending item: ${loopState.pendingVerificationItemId}`
			: "- pending item: none";
		const summaryPrompt = `You are compacting a pi session that is running an autonomous coding loop.

Preserve the following as first-class data:
- current mode, phase, and iteration
- immutable goal path, hash, and snapshot
- explicit opt-outs
- research provider health and fallback status
- verifier backend health and degraded reason
- recent research artifacts with ids, provider, summary, and source refs
- unresolved research blockers and which items depend on them
- quality objectives with status and evidence
- unfinished backlog items with status, kind, objectiveRefs, evidenceRefs, research dependencies, and verification status
- current item id
- pending verification item id
- pending verification requests and the latest verification reports
- last verification summary
- last failure or stop reason
- the exact next step to take when the loop resumes${priorSummaryBlock}

Current loop state:
${formatLoopStateMarkdown(loopState)}

Recent research artifacts:
${researchArtifactSummary || "- none"}

Research blockers:
${researchBlockers || "- none"}

Verifier backend:
- ${formatVerifierSummary(loopState)}
${pendingVerification}

Recent verification reports:
${verificationReports || "- none"}

Conversation to summarize:
<conversation>
${conversationText}
</conversation>

Write markdown with these sections:
## Goal Snapshot
## Loop State
## Research
## Quality Objectives
## Backlog
## Verification
## Next Step
## Conversation Summary`;

		try {
			const response = await complete(
				ctx.model,
				{
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: summaryPrompt }],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey,
					maxTokens: 4096,
					signal,
				},
			);

			const summary = response.content
				.filter((item): item is { type: "text"; text: string } => item.type === "text")
				.map((item) => item.text)
				.join("\n")
				.trim();

			if (!summary) return;

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					details: {
						loopState: cloneLoopState(loopState),
					},
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`AutoDevelop compaction fallback: ${message}`, "warning");
			return;
		}
	});
}
