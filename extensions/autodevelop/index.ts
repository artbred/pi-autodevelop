import { complete, StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { isGoalMutationCommand } from "./lib/bash-guard.js";
import { readLoopStateCheckpoint, writeLoopStateCheckpoint } from "./lib/checkpoint.js";
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
	assertCommitEligibility,
	createCycleCommit,
	getRecentAutoDevelopCommits,
	resolveGitCycleContext,
	stageCommitEligibleChanges,
} from "./lib/git-cycle.js";
import {
	createGoalScaffoldContent,
	makeGoalReadOnly,
	readGoalSnapshot,
	scaffoldGoalFile,
	verifyGoalSnapshot,
} from "./lib/goal.js";
import {
	acquireLoopLease,
	describeLoopLease,
	LEASE_HEARTBEAT_INTERVAL_MS,
	readLoopLease,
	refreshLoopLease,
	releaseLoopLease,
} from "./lib/lease.js";
import { probeResearchProviders, runResearchAction } from "./lib/research.js";
import { persistCycleSummary, persistResearchArtifactReview } from "./lib/review-log.js";
import {
	applyStateAction,
	buildLoopContext,
	cloneLoopState,
	createInitialLoopState,
	formatLoopStateMarkdown,
	getRecentResearchArtifacts,
	getUnresolvedQualityObjectives,
	getUnresolvedResearchBlockers,
	isLoopRunning,
	migrateLoopState,
	nextRunnablePhase,
	reconstructStateFromEntries,
} from "./lib/state-machine.js";
import { buildToolProfile } from "./lib/tool-profiles.js";
import { detectUncertaintyMarker } from "./lib/uncertainty.js";

const NOOP_RETRY_DELAY_MS = 60000;

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

function truncateSingleLine(value: string, max = 160) {
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= max) return compact;
	return `${compact.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function formatRetryState(nextCycleAt?: string) {
	if (!nextCycleAt) {
		return {
			active: false,
			label: "none",
		};
	}

	const target = Date.parse(nextCycleAt);
	if (!Number.isFinite(target)) {
		return {
			active: false,
			label: "invalid",
		};
	}

	const remainingMs = Math.max(0, target - Date.now());
	return {
		active: remainingMs > 0,
		label: remainingMs > 0 ? `${Math.ceil(remainingMs / 1000)}s` : "ready",
	};
}

function buildQualityPrompt(state: ReturnType<typeof cloneLoopState>) {
	const unresolved = getUnresolvedQualityObjectives(state);
	const researchBlockers = getUnresolvedResearchBlockers(state);
	const unresolvedText = unresolved.length ? unresolved.join(", ") : "none";
	const blockerText = researchBlockers.length ? researchBlockers.map((item) => item.title).join("; ") : "none";

	if (!hasOpenBacklogItem(state)) {
		return `The backlog is empty. Replan immediately against the same goal. Prioritize unresolved quality objectives in this order: ${QUALITY_HARDENING_PRIORITY.join(", ")}. Unresolved: ${unresolvedText}.`;
	}

	return `Unresolved quality objectives: ${unresolvedText}. Unresolved research blockers: ${blockerText}.`;
}

function buildLoopTurnPrompt(state: ReturnType<typeof cloneLoopState>, reason: string) {
	const currentItem = state?.backlog.find((item) => item.id === state.currentItemId);
	const currentItemLine = currentItem ? `Current item: [${currentItem.kind}] ${currentItem.title}` : "Current item: none";
	const retry = formatRetryState(state?.nextCycleAt);

	return `${LOOP_SKILL_COMMAND} reason=${reason}

Continue the autonomous development loop.

Goal file: ${state?.goal?.path ?? "unknown"}
Goal hash: ${state?.goal?.hash ?? "unknown"}
Repo root: ${state?.repoRoot ?? "unknown"}
Branch: ${state?.branch ?? "unknown"}
Mode: ${state?.mode ?? "unknown"}
Phase: ${state?.phase ?? "unknown"}
Cycle: ${state?.cycleNumber ?? 0}
Iteration: ${state?.iteration ?? 0}
Research providers: ${formatProviderSummary(state)}
Last cycle commit: ${state?.lastCycleCommitSha ?? "none"}
Last cycle summary: ${state?.lastCycleSummary || "none"}
Last cycle noop: ${state?.lastCycleNoop ? "yes" : "no"}
Next retry: ${retry.label}
${currentItemLine}

Use autodevelop_state with action="get" first, then proceed with the next best action.
Use autodevelop_research as the default research interface for repo and web research.
If you hit uncertainty, unknown behavior, assumptions, or missing evidence during code or test work, call autodevelop_state with action="flag_uncertainty" immediately and continue through a dedicated research item.
When an item satisfies its acceptanceCriteria and evidence requirements, use update_item to mark it done directly.
If the backlog is empty, create one with replace_plan.
Use autodevelop_state with action="complete" only when no pending or in-progress items remain, at least one item is done, and you can provide a non-empty completion summary. complete will create a git commit for this cycle and relaunch the same goal.
Use autodevelop_state with action="block" only when the entire loop cannot proceed safely. If only one backlog item is blocked and other work remains, mark that item blocked and continue with the next runnable work.
Use update_objective to record evidence as you address reliability, scalability, throughput, latency, memory efficiency, and performance.
Runtime-only paths under .pi/autodevelop and .autodevelop are never committed.
Inspect large-data and high-load behavior for chunking, batching, streaming, pagination, memory pressure, queue depth, retries, timeouts, idempotency, and backpressure unless explicitly opted out.
${buildQualityPrompt(state)}`;
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

function getSessionMeta(ctx?: ExtensionContext | null) {
	if (!ctx) {
		return {
			sessionId: "",
			sessionFile: "",
			cwd: "",
		};
	}

	return {
		sessionId: ctx.sessionManager.getSessionId?.() ?? "",
		sessionFile: ctx.sessionManager.getSessionFile?.() ?? "",
		cwd: ctx.cwd,
	};
}

function formatLeaseSummary(
	lease: Awaited<ReturnType<typeof readLoopLease>> | null,
	currentSessionId = "",
) {
	const description = describeLoopLease(lease, { currentSessionId });
	if (!description.present) {
		return {
			description,
			owner: "none",
			ownership: "no",
			freshness: "idle",
			age: "n/a",
			statusToken: "none",
		};
	}

	return {
		description,
		owner: description.ownerLabel,
		ownership: description.isOwner ? "yes" : "no",
		freshness: description.freshness,
		age: description.ageLabel,
		statusToken: description.isOwner ? "own" : `${description.isStale ? "other-stale" : "other"}@${description.ageLabel}`,
	};
}

function appendLeaseSection(markdown: string, lease: Awaited<ReturnType<typeof readLoopLease>> | null, currentSessionId = "") {
	const summary = formatLeaseSummary(lease, currentSessionId);
	return `${markdown}

### Lease

- Owner: ${summary.owner}
- Lease age: ${summary.age}
- Freshness: ${summary.freshness}
- Current session owns lease: ${summary.ownership}`;
}

function buildLeaseOwnershipError(lease: Awaited<ReturnType<typeof readLoopLease>> | null, currentSessionId = "") {
	const summary = formatLeaseSummary(lease, currentSessionId);
	if (!summary.description.present) {
		return "AutoDevelop is read-only because no workspace lease is active. Use `/autodevelop resume` to acquire the lease or `/autodevelop recover` to take over a foreign lease explicitly.";
	}

	if (summary.description.isOwner) {
		return "";
	}

	return `Another session owns the AutoDevelop workspace lease (\`${summary.owner}\`, ${summary.freshness}, age ${summary.age}). Use \`/autodevelop status\` to inspect or \`/autodevelop recover\` to take over explicitly.`;
}

function shouldRequireCleanRepoOnResume(state: ReturnType<typeof cloneLoopState>) {
	if (!state) return true;
	if (state.phase === "relaunching") return true;
	if (state.backlog.length === 0) return true;
	return false;
}

function cycleBlockersFromState(state: ReturnType<typeof cloneLoopState>) {
	return state?.backlog?.filter((item) => item.status === "blocked").map((item) => item.title) ?? [];
}

export default function autodevelopExtension(pi: ExtensionAPI) {
	let loopState: ReturnType<typeof cloneLoopState> | null = null;
	let loopLease: Awaited<ReturnType<typeof readLoopLease>> | null = null;
	let stateQueue = Promise.resolve();
	let pendingAutoTurn = false;
	let turnStartEntryCount = 0;
	let sawResearchToolThisTurn = false;
	let sawFlagUncertaintyThisTurn = false;
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	let noOpRetryTimer: ReturnType<typeof setTimeout> | null = null;
	let lastHydrationSource: "none" | "session" | "checkpoint" = "none";
	let currentSession = {
		sessionId: "",
		sessionFile: "",
		cwd: "",
	};

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

	function rememberSession(ctx?: ExtensionContext | null) {
		currentSession = getSessionMeta(ctx);
	}

	function currentSessionOwnsLease(ctx?: ExtensionContext | null) {
		const meta = ctx ? getSessionMeta(ctx) : currentSession;
		return Boolean(loopLease?.sessionId && loopLease.sessionId === meta.sessionId);
	}

	function stopNoOpRetry() {
		if (!noOpRetryTimer) return;
		clearTimeout(noOpRetryTimer);
		noOpRetryTimer = null;
	}

	function updateLoopUi(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const leaseSummary = formatLeaseSummary(loopLease, getSessionMeta(ctx).sessionId);
		if (!loopState && !loopLease) {
			ctx.ui.setStatus("autodevelop", undefined);
			ctx.ui.setWidget("autodevelop", undefined);
			return;
		}

		if (!loopState) {
			ctx.ui.setStatus("autodevelop", `AD idle lease:${leaseSummary.statusToken}`);
			ctx.ui.setWidget("autodevelop", [
				"goal unknown",
				"mode idle phase idle",
				`lease owner ${leaseSummary.owner}`,
				`lease age ${leaseSummary.age} freshness ${leaseSummary.freshness} owned ${leaseSummary.ownership}`,
			]);
			return;
		}

		const total = loopState.backlog.length;
		const done = loopState.backlog.filter((item) => item.status === "done").length;
		const unresolvedCount = getUnresolvedQualityObjectives(loopState).length;
		const researchBlockers = getUnresolvedResearchBlockers(loopState).length;
		const retry = formatRetryState(loopState.nextCycleAt);
		const statusLine = `AD ${loopState.phase} c:${loopState.cycleNumber} ${done}/${total} q:${unresolvedCount} r:${researchBlockers} branch:${loopState.branch || "unknown"} lease:${leaseSummary.statusToken}`;
		ctx.ui.setStatus("autodevelop", statusLine);

		const widgetLines = [
			`goal ${basename(loopState.goal.path)} hash ${formatShortHash(loopState.goal.hash)}`,
			`phase ${loopState.phase} cycle ${loopState.cycleNumber} iteration ${loopState.iteration}`,
			`branch ${loopState.branch || "unknown"} last_commit ${formatShortHash(loopState.lastCycleCommitSha)}`,
			`last cycle ${truncateSingleLine(loopState.lastCycleSummary || "none", 120)}`,
			`last noop ${loopState.lastCycleNoop ? "yes" : "no"} retry ${retry.label}`,
			`lease owner ${leaseSummary.owner}`,
			`lease age ${leaseSummary.age} freshness ${leaseSummary.freshness} owned ${leaseSummary.ownership}`,
			`providers ${formatProviderSummary(loopState)}`,
		];
		for (const item of loopState.backlog.slice(0, 6)) {
			const prefix = item.id === loopState.currentItemId ? ">" : "-";
			const refs = item.objectiveRefs?.length ? ` -> ${item.objectiveRefs.join(",")}` : "";
			const evidence = item.evidenceRefs?.length ? ` ev:${item.evidenceRefs.length}` : "";
			widgetLines.push(`${prefix} [${item.status}] [${item.kind}] ${item.title}${refs}${evidence}`);
		}
		ctx.ui.setWidget("autodevelop", widgetLines);
	}

	function stopLeaseHeartbeat() {
		if (!heartbeatTimer) return;
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}

	function startLeaseHeartbeat() {
		if (heartbeatTimer) return;
		heartbeatTimer = setInterval(() => {
			if (!loopState || !currentSessionOwnsLease()) return;
			void withStateLock(async () => {
				if (!loopState || !currentSessionOwnsLease()) return;
				const refreshed = await refreshLoopLease({
					cwd: currentSession.cwd || dirname(loopState.goal.path),
					state: loopState,
					sessionId: currentSession.sessionId,
					sessionFile: currentSession.sessionFile,
				});
				if (refreshed) {
					loopLease = refreshed;
				}
			});
		}, LEASE_HEARTBEAT_INTERVAL_MS);
		heartbeatTimer.unref?.();
	}

	function scheduleNoOpRetry(ctx: ExtensionContext, nextCycleAt: string) {
		stopNoOpRetry();
		const target = Date.parse(nextCycleAt);
		if (!Number.isFinite(target)) return;
		const delay = Math.max(0, target - Date.now());
		noOpRetryTimer = setTimeout(() => {
			void withStateLock(async () => {
				if (!loopState || !currentSessionOwnsLease(ctx)) return;
				if (loopState.nextCycleAt && Date.parse(loopState.nextCycleAt) > Date.now()) return;
				loopState = cloneLoopState(loopState);
				loopState.nextCycleAt = "";
				loopState.phase = "planning";
				await commitLoopState(ctx, "cycle:retry-ready");
				await queueLoopTurn(ctx, "no-op-retry");
			});
		}, delay);
		noOpRetryTimer.unref?.();
	}

	async function syncLeaseState(ctx?: ExtensionContext | null, state: ReturnType<typeof cloneLoopState> | null = loopState) {
		if (ctx) rememberSession(ctx);
		const cwd = ctx?.cwd ?? currentSession.cwd ?? state?.repoRoot ?? undefined;
		loopLease = await readLoopLease({ cwd, state: state ?? undefined });
		if (currentSessionOwnsLease()) {
			startLeaseHeartbeat();
		} else {
			stopLeaseHeartbeat();
		}
	}

	async function acquireLeaseForCurrentSession(ctx: ExtensionContext, { force = false } = {}) {
		if (!loopState) return false;
		rememberSession(ctx);
		const result = await acquireLoopLease({
			cwd: ctx.cwd,
			state: loopState,
			sessionId: currentSession.sessionId,
			sessionFile: currentSession.sessionFile,
			force,
		});
		if (!result.ok) {
			loopLease = result.lease;
			stopLeaseHeartbeat();
			syncToolProfile();
			updateLoopUi(ctx);
			return false;
		}
		loopLease = result.lease;
		startLeaseHeartbeat();
		syncToolProfile();
		updateLoopUi(ctx);
		return true;
	}

	async function releaseOwnedLease(ctx?: ExtensionContext | null, { force = false } = {}) {
		const meta = ctx ? getSessionMeta(ctx) : currentSession;
		if (!meta.sessionId) return false;
		const released = await releaseLoopLease({
			cwd: meta.cwd || loopState?.repoRoot || undefined,
			state: loopState ?? undefined,
			sessionId: meta.sessionId,
			force,
		});
		if (released || force) {
			loopLease = null;
			stopLeaseHeartbeat();
		}
		return released;
	}

	function syncToolProfile() {
		const allToolNames = pi.getAllTools().map((tool) => tool.name);
		if (!loopState || !currentSessionOwnsLease()) {
			pi.setActiveTools(allToolNames);
			return;
		}
		const profile = buildToolProfile(pi.getAllTools(), loopState);
		pi.setActiveTools(profile?.length ? profile : allToolNames);
	}

	async function withStateLock<T>(fn: () => Promise<T>) {
		const next = stateQueue.then(fn, fn);
		stateQueue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	async function commitLoopState(ctx: ExtensionContext, reason: string) {
		if (!loopState) return;
		rememberSession(ctx);
		pi.appendEntry("autodevelop-control", {
			reason,
			timestamp: Date.now(),
			state: cloneLoopState(loopState),
		});
		await writeLoopStateCheckpoint(loopState, { cwd: ctx.cwd });
		if (currentSessionOwnsLease(ctx)) {
			const refreshed = await refreshLoopLease({
				cwd: ctx.cwd,
				state: loopState,
				sessionId: currentSession.sessionId,
				sessionFile: currentSession.sessionFile,
			});
			if (refreshed) {
				loopLease = refreshed;
			}
		}
		syncToolProfile();
		updateLoopUi(ctx);
	}

	async function refreshResearchProviders() {
		if (!loopState) return;
		const providers = await probeResearchProviders();
		loopState = applyStateAction(loopState, "sync_research_providers", { providers });
	}

	async function refreshGitContext(ctx: ExtensionContext) {
		if (!loopState) return;
		const gitContext = resolveGitCycleContext(ctx.cwd);
		const recentCycleCommits = getRecentAutoDevelopCommits(gitContext.repoRoot, 5);
		loopState = applyStateAction(loopState, "sync_git_context", {
			repoRoot: gitContext.repoRoot,
			branch: gitContext.branch,
			recentCycleCommits,
		});
	}

	async function markLoopBlocked(ctx: ExtensionContext, reason: string) {
		if (!loopState) return;
		loopState = applyStateAction(loopState, "block", { reason });
		await commitLoopState(ctx, "goal-integrity-failed");
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

	async function readStatusSnapshot(ctx: ExtensionContext) {
		const state = loopState ?? (await readLoopStateCheckpoint(ctx.cwd));
		const lease = await readLoopLease({ cwd: ctx.cwd, state: state ?? undefined });
		return { state, lease };
	}

	async function hydrateState(ctx: ExtensionContext, { probe = false } = {}) {
		rememberSession(ctx);
		lastHydrationSource = "none";
		loopState = reconstructStateFromEntries(ctx.sessionManager.getBranch());
		if (loopState) {
			lastHydrationSource = "session";
		} else {
			loopState = await readLoopStateCheckpoint(ctx.cwd);
			if (loopState) {
				lastHydrationSource = "checkpoint";
			}
		}
		loopState = migrateLoopState(loopState);
		await syncLeaseState(ctx, loopState);
		if (probe && loopState && currentSessionOwnsLease(ctx)) {
			await refreshResearchProviders();
			await refreshGitContext(ctx);
		}
		syncToolProfile();
		updateLoopUi(ctx);
	}

	async function ensureLoopMutationOwnership(ctx: ExtensionContext) {
		await syncLeaseState(ctx, loopState);
		return currentSessionOwnsLease(ctx) ? "" : buildLeaseOwnershipError(loopLease, currentSession.sessionId);
	}

	async function commitCheckpointHydration(ctx: ExtensionContext) {
		if (!loopState || lastHydrationSource !== "checkpoint" || !currentSessionOwnsLease(ctx)) return;
		await commitLoopState(ctx, "hydrate-checkpoint");
		lastHydrationSource = "session";
	}

	async function queueLoopTurn(ctx: ExtensionContext, reason: string) {
		await syncLeaseState(ctx, loopState);
		if (!currentSessionOwnsLease(ctx)) return;
		if (!loopState || !isLoopRunning(loopState)) return;
		if (pendingAutoTurn || ctx.hasPendingMessages()) return;
		if (loopState.nextCycleAt && Date.parse(loopState.nextCycleAt) > Date.now()) return;
		if (!(await ensureGoalIsUnchanged(ctx))) return;

		if (loopState.phase === "relaunching" && (!loopState.nextCycleAt || Date.parse(loopState.nextCycleAt) <= Date.now())) {
			loopState = cloneLoopState(loopState);
			loopState.phase = "planning";
			loopState.nextCycleAt = "";
		}

		loopState.iteration += 1;
		await commitLoopState(ctx, `queue:${reason}`);

		pendingAutoTurn = true;
		try {
			pi.sendUserMessage(appendLeaseSection(buildLoopTurnPrompt(loopState, reason), loopLease, currentSession.sessionId), {
				deliverAs: "followUp",
			});
		} catch (error) {
			pendingAutoTurn = false;
			const message = error instanceof Error ? error.message : String(error);
			emitLoopMessage(`## AutoDevelop Error\n\nFailed to queue the next loop turn.\n\n${message}`);
		}
	}

	async function enforceUncertaintyResearch(ctx: ExtensionContext) {
		if (!loopState || !isLoopRunning(loopState)) return false;
		if (!["implementing", "testing"].includes(loopState.phase)) return false;
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
		await commitLoopState(ctx, "uncertainty-safety-net");
		emitLoopMessage(
			`## AutoDevelop Research Required\n\nDetected uncertainty in the latest agent response ("${marker}"). The active item was paused and a linked research item was inserted before implementation can continue.`,
		);
		await queueLoopTurn(ctx, "uncertainty");
		return true;
	}

	async function closeCurrentCycle(ctx: ExtensionContext) {
		if (!loopState) {
			throw new Error("No active loop state exists.");
		}
		if (!(await ensureGoalIsUnchanged(ctx))) {
			throw new Error("Goal integrity failed while closing the cycle.");
		}

		await refreshGitContext(ctx);
		assertCommitEligibility(loopState.repoRoot, { allowDirty: true });

		const cycleNumber = loopState.cycleNumber;
		const summary = loopState.completionSummary;
		const blockers = cycleBlockersFromState(loopState);
		const staged = stageCommitEligibleChanges(loopState.repoRoot);

		if (!staged.hasStagedChanges) {
			const nextCycleAt = new Date(Date.now() + NOOP_RETRY_DELAY_MS).toISOString();
			const recentCycleCommits = getRecentAutoDevelopCommits(loopState.repoRoot, 5);
			loopState = applyStateAction(loopState, "record_cycle_result", {
				summary,
				commitSha: "",
				changedFiles: [],
				noop: true,
				blockers,
				nextCycleAt,
				recentCycleCommits,
			});
			await persistCycleSummary({
				cycleNumber,
				branch: loopState.branch,
				completionSummary: summary,
				commitSha: "",
				diffStat: "No commit was created because no non-runtime changes were staged.",
				changedFiles: [],
				blockers,
				noop: true,
				cwd: ctx.cwd,
				state: loopState,
			});
			await commitLoopState(ctx, "cycle:no-op");
			await ctx.compact?.();
			loopState = applyStateAction(loopState, "begin_next_cycle", {
				nextCycleAt,
				recentCycleCommits,
			});
			await commitLoopState(ctx, "cycle:relaunch");
			scheduleNoOpRetry(ctx, nextCycleAt);
			return {
				noop: true,
				commitSha: "",
				changedFiles: [],
				diffStat: "",
				nextCycleAt,
			};
		}

		const commit = createCycleCommit(loopState.repoRoot, cycleNumber, summary);
		const recentCycleCommits = getRecentAutoDevelopCommits(loopState.repoRoot, 5);
		loopState = applyStateAction(loopState, "record_cycle_result", {
			summary,
			commitSha: commit.commitSha,
			changedFiles: staged.changedFiles,
			noop: false,
			blockers,
			nextCycleAt: "",
			recentCycleCommits,
		});
		await persistCycleSummary({
			cycleNumber,
			branch: loopState.branch,
			completionSummary: summary,
			commitSha: commit.commitSha,
			diffStat: staged.diffStat,
			changedFiles: staged.changedFiles,
			blockers,
			noop: false,
			cwd: ctx.cwd,
			state: loopState,
		});
		await commitLoopState(ctx, "cycle:commit");
		await ctx.compact?.();
		loopState = applyStateAction(loopState, "begin_next_cycle", {
			recentCycleCommits,
		});
		await commitLoopState(ctx, "cycle:relaunch");
		await queueLoopTurn(ctx, "cycle-complete");
		return {
			noop: false,
			commitSha: commit.commitSha,
			changedFiles: staged.changedFiles,
			diffStat: staged.diffStat,
			nextCycleAt: "",
		};
	}

	pi.registerCommand("autodevelop", {
		description: "Manage the autonomous goal-driven development loop",
		handler: async (args, ctx) =>
			withStateLock(async () => {
				rememberSession(ctx);
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
							await hydrateState(ctx);
							const existingCheckpoint = await readLoopStateCheckpoint(ctx.cwd);
							const existingLease = await readLoopLease({
								cwd: ctx.cwd,
								state: existingCheckpoint ?? loopState ?? undefined,
							});
							if (existingLease) {
								loopLease = existingLease;
								syncToolProfile();
								updateLoopUi(ctx);
								ctx.ui.notify(
									`Cannot start a new AutoDevelop loop while a workspace lease exists. ${buildLeaseOwnershipError(existingLease, currentSession.sessionId)}`,
									"warning",
								);
								return;
							}
							if (existingCheckpoint || loopState) {
								ctx.ui.notify(
									"A recoverable AutoDevelop checkpoint already exists for this workspace. Use `/autodevelop resume` or `/autodevelop recover` instead of `start`.",
									"warning",
								);
								return;
							}

							const goalSnapshot = await readGoalSnapshot(ctx.cwd, subcommandArgs);
							const providers = await probeResearchProviders();
							const gitContext = resolveGitCycleContext(ctx.cwd);
							assertCommitEligibility(gitContext.repoRoot);
							goalSnapshot.readonlyProtection = await makeGoalReadOnly(goalSnapshot.path);
							loopState = createInitialLoopState(goalSnapshot, providers, {
								repoRoot: gitContext.repoRoot,
								branch: gitContext.branch,
								recentCycleCommits: getRecentAutoDevelopCommits(gitContext.repoRoot, 5),
							});
							if (!(await acquireLeaseForCurrentSession(ctx))) {
								ctx.ui.notify(buildLeaseOwnershipError(loopLease, currentSession.sessionId), "warning");
								return;
							}
							await commitLoopState(ctx, "start");
							emitLoopMessage(
								appendLeaseSection(
									`## AutoDevelop Started\n\n- Goal: \`${goalSnapshot.path}\`\n- Hash: \`${goalSnapshot.hash}\`\n- Read-only protection: ${goalSnapshot.readonlyProtection ? "enabled" : "best effort only"}\n- Branch: ${loopState.branch}\n- Research providers: ${formatProviderSummary(loopState)}`,
									loopLease,
									currentSession.sessionId,
								),
							);
							await queueLoopTurn(ctx, "start");
						} catch (error) {
							ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
						}
						return;
					}

					case "status": {
						const snapshot = await readStatusSnapshot(ctx);
						emitLoopMessage(appendLeaseSection(formatLoopStateMarkdown(snapshot.state), snapshot.lease, currentSession.sessionId));
						return;
					}

					case "pause": {
						if (!loopState) {
							ctx.ui.notify("No active autodevelop loop.", "warning");
							return;
						}
						const ownershipError = await ensureLoopMutationOwnership(ctx);
						if (ownershipError) {
							ctx.ui.notify(ownershipError, "warning");
							return;
						}

						stopNoOpRetry();
						loopState = applyStateAction(loopState, "set_phase", { phase: "paused" });
						await commitLoopState(ctx, "pause");
						emitLoopMessage("## AutoDevelop Paused");
						return;
					}

					case "resume": {
						await hydrateState(ctx);
						if (!loopState) {
							ctx.ui.notify("No autodevelop loop to resume.", "warning");
							return;
						}
						if (loopLease && !currentSessionOwnsLease(ctx)) {
							ctx.ui.notify(buildLeaseOwnershipError(loopLease, currentSession.sessionId), "warning");
							return;
						}
						if (!(await acquireLeaseForCurrentSession(ctx))) {
							ctx.ui.notify(buildLeaseOwnershipError(loopLease, currentSession.sessionId), "warning");
							return;
						}
						await commitCheckpointHydration(ctx);
						await refreshResearchProviders();
						await refreshGitContext(ctx);
						if (shouldRequireCleanRepoOnResume(loopState)) {
							assertCommitEligibility(loopState.repoRoot);
						}
						if (loopState.nextCycleAt && Date.parse(loopState.nextCycleAt) <= Date.now()) {
							loopState = cloneLoopState(loopState);
							loopState.nextCycleAt = "";
							loopState.phase = "planning";
						}
						const nextPhase = loopState.nextCycleAt
							? "relaunching"
							: nextRunnablePhase({
									...loopState,
									phase: "planning",
								});
						loopState = applyStateAction(loopState, "set_phase", {
							phase: nextPhase,
							currentItemId: loopState.currentItemId ?? undefined,
							failure: "",
						});
						loopState.stopReason = "";
						await commitLoopState(ctx, "resume");
						emitLoopMessage(
							appendLeaseSection(`## AutoDevelop Resumed\n\nPhase: \`${nextPhase}\`\n\nBranch: \`${loopState.branch}\``, loopLease, currentSession.sessionId),
						);
						if (loopState.nextCycleAt) {
							scheduleNoOpRetry(ctx, loopState.nextCycleAt);
						} else {
							await queueLoopTurn(ctx, "resume");
						}
						return;
					}

					case "recover": {
						await hydrateState(ctx);
						if (!loopState) {
							ctx.ui.notify("No autodevelop loop checkpoint is available to recover.", "warning");
							return;
						}

						if (loopLease && !currentSessionOwnsLease(ctx)) {
							const summary = formatLeaseSummary(loopLease, currentSession.sessionId);
							if (ctx.hasUI) {
								const confirmed = await ctx.ui.confirm(
									"Recover AutoDevelop loop?",
									`Take over the workspace lease from ${summary.owner} (${summary.freshness}, age ${summary.age})?`,
								);
								if (!confirmed) return;
							}
						}

						if (!(await acquireLeaseForCurrentSession(ctx, { force: Boolean(loopLease && !currentSessionOwnsLease(ctx)) }))) {
							ctx.ui.notify(buildLeaseOwnershipError(loopLease, currentSession.sessionId), "warning");
							return;
						}
						await commitCheckpointHydration(ctx);
						await refreshResearchProviders();
						await refreshGitContext(ctx);
						if (shouldRequireCleanRepoOnResume(loopState)) {
							assertCommitEligibility(loopState.repoRoot);
						}
						if (loopState.nextCycleAt && Date.parse(loopState.nextCycleAt) <= Date.now()) {
							loopState = cloneLoopState(loopState);
							loopState.nextCycleAt = "";
							loopState.phase = "planning";
						}
						const nextPhase = loopState.nextCycleAt
							? "relaunching"
							: nextRunnablePhase({
									...loopState,
									phase: "planning",
								});
						loopState = applyStateAction(loopState, "set_phase", {
							phase: nextPhase,
							currentItemId: loopState.currentItemId ?? undefined,
							failure: "",
						});
						loopState.stopReason = "";
						await commitLoopState(ctx, "recover");
						emitLoopMessage(
							appendLeaseSection(`## AutoDevelop Recovered\n\nPhase: \`${nextPhase}\`\n\nBranch: \`${loopState.branch}\``, loopLease, currentSession.sessionId),
						);
						if (loopState.nextCycleAt) {
							scheduleNoOpRetry(ctx, loopState.nextCycleAt);
						} else {
							await queueLoopTurn(ctx, "recover");
						}
						return;
					}

					case "stop": {
						if (!loopState) {
							ctx.ui.notify("No autodevelop loop to stop.", "warning");
							return;
						}
						const ownershipError = await ensureLoopMutationOwnership(ctx);
						if (ownershipError) {
							ctx.ui.notify(ownershipError, "warning");
							return;
						}

						stopNoOpRetry();
						loopState = cloneLoopState(loopState);
						loopState.phase = "stopped";
						loopState.stopReason = "Stopped by user";
						await commitLoopState(ctx, "stop");
						await releaseOwnedLease(ctx);
						syncToolProfile();
						updateLoopUi(ctx);
						emitLoopMessage("## AutoDevelop Stopped\n\nThe loop will not auto-continue.");
						return;
					}

					default: {
						ctx.ui.notify("Usage: /autodevelop <start|status|pause|resume|recover|stop|scaffold> [args]", "info");
					}
				}
			}),
	});

	pi.registerTool({
		name: "autodevelop_state",
		label: "AutoDevelop State",
		description:
			"Manage the autonomous development loop state. Use get before acting, replace_plan to define backlog items, update_item as work progresses, set_phase to match the work phase, update_objective to record quality evidence, flag_uncertainty when research is required, block when stuck, and complete to close the current git-backed cycle and relaunch the same goal.",
		promptSnippet: "Inspect and update the autonomous loop state, research blockers, git cycle backlog, quality objectives, phase, and completion status.",
		promptGuidelines: [
			"Call autodevelop_state with action=get before replacing the plan or claiming completion.",
			"Keep backlog kinds to research, code, or test.",
			"Unless the goal file explicitly opts out, treat reliability, scalability, throughput, latency, memory efficiency, and performance as default success dimensions.",
			"Use autodevelop_research as the default research interface.",
			"Use flag_uncertainty immediately when code or test work hits assumptions, unknown behavior, unclear failures, or missing evidence.",
			"Mark items done directly once acceptance criteria and required evidence are satisfied.",
			"Tag backlog items with objectiveRefs and attach evidenceRefs when research unblocks later work.",
			"Use update_objective with evidence as you address quality objectives.",
			"Use block only when the entire loop cannot proceed safely or the goal cannot be met with the current constraints. If a single item is blocked but other work remains, block that item and continue.",
			"Use complete only when the cycle is ready to commit and restart on the same goal.",
		],
		parameters: AutoDevelopStateSchema,
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
					if (params.action !== "get") {
						const ownershipError = await ensureLoopMutationOwnership(ctx);
						if (ownershipError) {
							return {
								content: [{ type: "text", text: `Error: ${ownershipError}` }],
								details: cloneLoopState(loopState),
								isError: true,
							};
						}
					}

					if (params.action === "flag_uncertainty") {
						sawFlagUncertaintyThisTurn = true;
					}

					if (params.action === "complete") {
						loopState = applyStateAction(loopState, params.action, params);
						await commitLoopState(ctx, "state:complete");
						const result = await closeCurrentCycle(ctx);

						return {
							content: [
								{
									type: "text",
									text: result.noop
										? `## AutoDevelop Cycle Closed\n\nNo commit was created because no non-runtime changes were present. The same goal will retry after ${formatRetryState(result.nextCycleAt).label}.\n\n${formatLoopStateMarkdown(loopState)}`
										: `## AutoDevelop Cycle Closed\n\n- Commit: \`${result.commitSha}\`\n- Changed files: ${result.changedFiles.join(", ") || "none"}\n\n${formatLoopStateMarkdown(loopState)}`,
								},
							],
							details: cloneLoopState(loopState),
						};
					}

					loopState = applyStateAction(loopState, params.action, params);
					if (params.action !== "get") {
						await commitLoopState(ctx, `state:${params.action}`);
					}

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
			"If you are in code or test work and research is needed, call autodevelop_state action=flag_uncertainty first. If you forget, the extension will pause the active item automatically when this tool runs.",
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
					const ownershipError = await ensureLoopMutationOwnership(ctx);
					if (ownershipError) {
						return {
							content: [{ type: "text", text: `Error: ${ownershipError}` }],
							details: cloneLoopState(loopState),
							isError: true,
						};
					}

					if (
						(params.action === "query" || params.action === "fetch") &&
						["implementing", "testing"].includes(loopState.phase)
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
							await commitLoopState(ctx, "auto-flag-uncertainty");
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
						const activeItemTitle =
							loopState.backlog.find((item) => item.id === loopState.currentItemId)?.title
							|| loopState.backlog.find((item) => item.evidenceRefs?.includes(research.artifact.id))?.title
							|| "";
						await persistResearchArtifactReview({
							artifact: research.artifact,
							cwd: ctx.cwd,
							state: loopState,
							itemTitle: activeItemTitle,
						});
					}
					if (params.action !== "health") {
						sawResearchToolThisTurn = true;
					}
					await commitLoopState(ctx, `research:${params.action}`);

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
		await withStateLock(async () => {
			await hydrateState(ctx);
		});
	});
	pi.on("session_before_switch", async (_event, ctx) => {
		await withStateLock(async () => {
			rememberSession(ctx);
			stopNoOpRetry();
			await releaseOwnedLease(ctx);
			loopState = null;
			loopLease = null;
			lastHydrationSource = "none";
			stopLeaseHeartbeat();
			syncToolProfile();
			updateLoopUi(ctx);
		});
	});
	pi.on("session_switch", async (_event, ctx) => {
		await withStateLock(async () => {
			await hydrateState(ctx);
		});
	});
	pi.on("session_before_fork", async (_event, ctx) => {
		await withStateLock(async () => {
			rememberSession(ctx);
			stopNoOpRetry();
			await releaseOwnedLease(ctx);
			loopLease = null;
			stopLeaseHeartbeat();
		});
	});
	pi.on("session_fork", async (_event, ctx) => {
		await withStateLock(async () => {
			await hydrateState(ctx);
		});
	});
	pi.on("session_tree", async (_event, ctx) => {
		await withStateLock(async () => {
			await hydrateState(ctx);
		});
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		await withStateLock(async () => {
			rememberSession(ctx);
			stopNoOpRetry();
			await releaseOwnedLease(ctx);
			loopState = null;
			loopLease = null;
			lastHydrationSource = "none";
			stopLeaseHeartbeat();
		});
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
		await syncLeaseState(ctx, loopState);
		if (!currentSessionOwnsLease(ctx)) return;
		if (!loopState || !isLoopRunning(loopState)) return;
		if (!(await ensureGoalIsUnchanged(ctx))) return;

		turnStartEntryCount = ctx.sessionManager.getBranch().length;
		sawResearchToolThisTurn = false;
		sawFlagUncertaintyThisTurn = false;

		return {
			message: {
				customType: "autodevelop-context",
				content: appendLeaseSection(buildLoopContext(loopState), loopLease, getSessionMeta(ctx).sessionId),
				display: false,
			},
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		pendingAutoTurn = false;
		await syncLeaseState(ctx, loopState);
		if (!currentSessionOwnsLease(ctx)) return;
		if (!loopState || !isLoopRunning(loopState)) return;
		if (ctx.hasPendingMessages()) return;
		if (await enforceUncertaintyResearch(ctx)) return;
		if (loopState.nextCycleAt && Date.parse(loopState.nextCycleAt) > Date.now()) {
			scheduleNoOpRetry(ctx, loopState.nextCycleAt);
			return;
		}
		await queueLoopTurn(ctx, "continue");
	});

	pi.on("tool_call", async (event, ctx) => {
		await syncLeaseState(ctx, loopState);
		if (!currentSessionOwnsLease(ctx)) return;
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
		const recentCommits = (loopState.recentCycleCommits ?? [])
			.slice(0, 5)
			.map((commit) => `- ${commit.shortSha || commit.sha.slice(0, 12)} ${commit.subject}`)
			.join("\n");
		const summaryPrompt = `You are compacting a pi session that is running an autonomous coding loop.

Preserve the following as first-class data:
- current phase, iteration, cycle number, and branch
- immutable goal path, hash, and snapshot
- research provider health and fallback status
- recent research artifacts with ids, provider, summary, and source refs
- unresolved research blockers and which items depend on them
- quality objectives with status and evidence
- unfinished backlog items with status, kind, objectiveRefs, evidenceRefs, and research dependencies
- current item id
- last cycle commit sha, last cycle summary, last cycle changed files, and last cycle no-op state
- recent AutoDevelop commits from git history
- next retry time if a no-op cycle is waiting
- last failure or stop reason
- the exact next step to take when the loop resumes${priorSummaryBlock}

Current loop state:
${formatLoopStateMarkdown(loopState)}

Recent research artifacts:
${researchArtifactSummary || "- none"}

Research blockers:
${researchBlockers || "- none"}

Recent AutoDevelop commits:
${recentCommits || "- none"}

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
## Git Cycle
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
