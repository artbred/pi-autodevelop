import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { isGoalMutationCommand } from "./lib/bash-guard.js";
import {
	BACKLOG_KINDS,
	ITEM_STATUSES,
	LOOP_PHASES,
	LOOP_SKILL_COMMAND,
	PAUSED_OR_TERMINAL_PHASES,
} from "./lib/constants.js";
import {
	createGoalScaffoldContent,
	makeGoalReadOnly,
	readGoalSnapshot,
	scaffoldGoalFile,
	verifyGoalSnapshot,
} from "./lib/goal.js";
import {
	applyStateAction,
	buildLoopContext,
	cloneLoopState,
	createInitialLoopState,
	formatLoopStateMarkdown,
	isLoopRunning,
	nextRunnablePhase,
	reconstructStateFromEntries,
} from "./lib/state-machine.js";
import { buildToolProfile } from "./lib/tool-profiles.js";

const BacklogItemSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable item id. Omit to auto-generate." })),
	title: Type.String({ description: "Short actionable title." }),
	kind: StringEnum(BACKLOG_KINDS),
	status: Type.Optional(StringEnum(ITEM_STATUSES)),
	notes: Type.Optional(Type.String({ description: "Progress, findings, or constraints." })),
	acceptanceCriteria: Type.Optional(Type.String({ description: "What proves the item is done." })),
});

const BacklogItemPatchSchema = Type.Partial(
	Type.Object({
		title: Type.String(),
		kind: StringEnum(BACKLOG_KINDS),
		status: StringEnum(ITEM_STATUSES),
		notes: Type.String(),
		acceptanceCriteria: Type.String(),
	}),
);

const AutoDevelopStateSchema = Type.Object({
	action: StringEnum(["get", "replace_plan", "update_item", "set_phase", "block", "complete"]),
	items: Type.Optional(Type.Array(BacklogItemSchema)),
	itemId: Type.Optional(Type.String()),
	patch: Type.Optional(BacklogItemPatchSchema),
	phase: Type.Optional(StringEnum(LOOP_PHASES)),
	currentItemId: Type.Optional(Type.String()),
	reason: Type.Optional(Type.String()),
	summary: Type.Optional(Type.String()),
	verificationSummary: Type.Optional(Type.String()),
	failure: Type.Optional(Type.String()),
});

function formatShortHash(hash?: string) {
	return hash ? hash.slice(0, 12) : "unknown";
}

function buildLoopTurnPrompt(state: ReturnType<typeof cloneLoopState>, reason: string) {
	const currentItem = state?.backlog.find((item) => item.id === state.currentItemId);
	const currentItemLine = currentItem ? `Current item: [${currentItem.kind}] ${currentItem.title}` : "Current item: none";
	return `${LOOP_SKILL_COMMAND} reason=${reason}

Continue the autonomous development loop.

Goal file: ${state?.goal?.path ?? "unknown"}
Goal hash: ${state?.goal?.hash ?? "unknown"}
Phase: ${state?.phase ?? "unknown"}
Iteration: ${state?.iteration ?? 0}
${currentItemLine}

Use autodevelop_state with action="get" first, then proceed with the next best action.
If the backlog is empty, create one with replace_plan.
If you are blocked, call autodevelop_state with action="block".
If the goal is satisfied, call autodevelop_state with action="complete".`;
}

async function resolveCandidatePath(cwd: string, candidatePath: string) {
	const absolutePath = resolve(cwd, candidatePath);
	try {
		return await realpath(absolutePath);
	} catch {
		return absolutePath;
	}
}

export default function autodevelopExtension(pi: ExtensionAPI) {
	let loopState: ReturnType<typeof cloneLoopState> | null = null;
	let stateQueue = Promise.resolve();
	let pendingAutoTurn = false;

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
		const statusLine = `AD ${loopState.phase} ${done}/${total} goal:${basename(loopState.goal.path)}`;
		ctx.ui.setStatus("autodevelop", statusLine);

		const widgetLines = [
			`goal ${basename(loopState.goal.path)} hash ${formatShortHash(loopState.goal.hash)}`,
			`phase ${loopState.phase} iteration ${loopState.iteration}`,
		];
		for (const item of loopState.backlog.slice(0, 6)) {
			const prefix = item.id === loopState.currentItemId ? ">" : "-";
			widgetLines.push(`${prefix} [${item.status}] [${item.kind}] ${item.title}`);
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
		syncToolProfile();
		updateLoopUi(ctx);
	}

	async function queueLoopTurn(ctx: ExtensionContext, reason: string) {
		if (!loopState || !isLoopRunning(loopState)) return;
		if (pendingAutoTurn || ctx.hasPendingMessages()) return;
		if (!(await ensureGoalIsUnchanged(ctx))) return;

		loopState = cloneLoopState(loopState);
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
						goalSnapshot.readonlyProtection = await makeGoalReadOnly(goalSnapshot.path);
						loopState = createInitialLoopState(goalSnapshot);
						persistControlState("start");
						syncToolProfile();
						updateLoopUi(ctx);
						emitLoopMessage(
							`## AutoDevelop Started\n\n- Goal: \`${goalSnapshot.path}\`\n- Hash: \`${goalSnapshot.hash}\`\n- Read-only protection: ${goalSnapshot.readonlyProtection ? "enabled" : "best effort only"}`,
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
					emitLoopMessage(`## AutoDevelop Resumed\n\nPhase: \`${nextPhase}\``);
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
			"Manage the autonomous development loop state. Use get before acting, replace_plan to define backlog items, update_item as work progresses, set_phase to match the current work mode, block when stuck, and complete when the goal is satisfied.",
		promptSnippet: "Inspect and update the autonomous loop state, backlog, phase, and completion status.",
		promptGuidelines: [
			"Call autodevelop_state with action=get before replacing the plan or claiming completion.",
			"Keep backlog kinds to research, code, test, or verify.",
			"Use block when the loop cannot proceed safely or the goal cannot be met with the current constraints.",
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
					loopState = applyStateAction(loopState, params.action, params);
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
		const summaryPrompt = `You are compacting a pi session that is running an autonomous coding loop.

Preserve the following as first-class data:
- immutable goal path, hash, and snapshot
- current phase and iteration
- unfinished backlog items with status and kind
- current item id
- last verification summary
- last failure or stop reason
- the exact next step to take when the loop resumes${priorSummaryBlock}

Current loop state:
${formatLoopStateMarkdown(loopState)}

Conversation to summarize:
<conversation>
${conversationText}
</conversation>

Write markdown with these sections:
## Goal Snapshot
## Loop State
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
