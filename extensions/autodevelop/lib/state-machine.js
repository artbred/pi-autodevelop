import {
	ACTIVE_PHASES,
	BACKLOG_KINDS,
	ITEM_STATUSES,
	LOOP_STATE_VERSION,
	PAUSED_OR_TERMINAL_PHASES,
} from "./constants.js";

function slugify(value, fallback) {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);

	return slug || fallback;
}

function clone(value) {
	return value ? JSON.parse(JSON.stringify(value)) : value;
}

function assertValidKind(kind) {
	if (!BACKLOG_KINDS.includes(kind)) {
		throw new Error(`Invalid backlog kind: ${kind}`);
	}
}

function assertValidStatus(status) {
	if (!ITEM_STATUSES.includes(status)) {
		throw new Error(`Invalid backlog status: ${status}`);
	}
}

function phaseFromKind(kind) {
	switch (kind) {
		case "research":
			return "researching";
		case "code":
			return "implementing";
		case "test":
			return "testing";
		case "verify":
			return "verifying";
		default:
			return "planning";
	}
}

export function cloneLoopState(state) {
	return clone(state);
}

export function createInitialLoopState(goalSnapshot) {
	return {
		version: LOOP_STATE_VERSION,
		goal: clone(goalSnapshot),
		phase: "planning",
		iteration: 0,
		currentItemId: null,
		backlog: [],
		lastVerificationSummary: "",
		lastFailure: "",
		stopReason: "",
		completionSummary: "",
	};
}

export function normalizeBacklogItems(items) {
	return (items ?? []).map((item, index) => {
		const kind = item.kind ?? "research";
		const status = item.status ?? "pending";
		assertValidKind(kind);
		assertValidStatus(status);

		return {
			id: item.id?.trim() || `item-${index + 1}-${slugify(item.title ?? kind, kind)}`,
			title: (item.title ?? `${kind} task ${index + 1}`).trim(),
			kind,
			status,
			notes: item.notes?.trim() ?? "",
			acceptanceCriteria: item.acceptanceCriteria?.trim() ?? "",
		};
	});
}

function findBacklogItem(state, itemId) {
	const item = state.backlog.find((candidate) => candidate.id === itemId);
	if (!item) {
		throw new Error(`Backlog item not found: ${itemId}`);
	}
	return item;
}

export function applyStateAction(state, action, params = {}) {
	const nextState = cloneLoopState(state);
	if (!nextState) {
		throw new Error("Loop state is not initialized");
	}

	switch (action) {
		case "get":
			return nextState;

		case "replace_plan": {
			nextState.backlog = normalizeBacklogItems(params.items ?? []);
			const inProgressItem = nextState.backlog.find((item) => item.status === "in_progress");
			nextState.currentItemId = inProgressItem?.id ?? nextState.currentItemId ?? null;
			nextState.stopReason = "";
			nextState.completionSummary = "";
			if (!ACTIVE_PHASES.has(nextState.phase) || nextState.phase === "planning") {
				nextState.phase = inProgressItem ? phaseFromKind(inProgressItem.kind) : "planning";
			}
			return nextState;
		}

		case "update_item": {
			if (!params.itemId) {
				throw new Error("itemId is required for update_item");
			}

			const item = findBacklogItem(nextState, params.itemId);
			const patch = params.patch ?? {};

			if (patch.kind !== undefined) {
				assertValidKind(patch.kind);
				item.kind = patch.kind;
			}

			if (patch.status !== undefined) {
				assertValidStatus(patch.status);
				item.status = patch.status;
			}

			if (patch.title !== undefined) item.title = patch.title.trim();
			if (patch.notes !== undefined) item.notes = patch.notes.trim();
			if (patch.acceptanceCriteria !== undefined) item.acceptanceCriteria = patch.acceptanceCriteria.trim();

			if (item.status === "in_progress") {
				nextState.currentItemId = item.id;
				nextState.phase = phaseFromKind(item.kind);
			}

			if ((item.status === "done" || item.status === "blocked") && nextState.currentItemId === item.id) {
				nextState.currentItemId = null;
			}

			return nextState;
		}

		case "set_phase": {
			if (!params.phase) {
				throw new Error("phase is required for set_phase");
			}

			nextState.phase = params.phase;
			if (params.currentItemId !== undefined) {
				nextState.currentItemId = params.currentItemId || null;
			}
			if (params.verificationSummary !== undefined) {
				nextState.lastVerificationSummary = params.verificationSummary.trim();
			}
			if (params.failure !== undefined) {
				nextState.lastFailure = params.failure.trim();
			}
			if (PAUSED_OR_TERMINAL_PHASES.has(nextState.phase) && params.failure) {
				nextState.stopReason = params.failure.trim();
			}
			return nextState;
		}

		case "block": {
			const reason = params.reason?.trim();
			if (!reason) {
				throw new Error("reason is required for block");
			}

			nextState.phase = "blocked";
			nextState.stopReason = reason;
			nextState.lastFailure = reason;
			if (nextState.currentItemId) {
				const item = nextState.backlog.find((candidate) => candidate.id === nextState.currentItemId);
				if (item) item.status = "blocked";
			}
			return nextState;
		}

		case "complete": {
			const summary = params.summary?.trim() ?? "";
			nextState.phase = "complete";
			nextState.stopReason = "Goal complete";
			nextState.completionSummary = summary;
			if (summary) {
				nextState.lastVerificationSummary = summary;
			}
			if (nextState.currentItemId) {
				const item = nextState.backlog.find((candidate) => candidate.id === nextState.currentItemId);
				if (item && item.status !== "blocked") {
					item.status = "done";
				}
			}
			nextState.currentItemId = null;
			return nextState;
		}

		default:
			throw new Error(`Unsupported autodevelop_state action: ${action}`);
	}
}

export function isLoopRunning(state) {
	return Boolean(state && ACTIVE_PHASES.has(state.phase));
}

export function nextRunnablePhase(state) {
	if (!state) return "planning";

	if (state.currentItemId) {
		const item = state.backlog.find((candidate) => candidate.id === state.currentItemId);
		if (item && item.status !== "done" && item.status !== "blocked") {
			return phaseFromKind(item.kind);
		}
	}

	const nextItem = state.backlog.find((candidate) => candidate.status === "in_progress" || candidate.status === "pending");
	return nextItem ? phaseFromKind(nextItem.kind) : "planning";
}

export function formatLoopStateMarkdown(state) {
	if (!state) {
		return "## AutoDevelop\n\nNo loop state is active.";
	}

	const backlogLines =
		state.backlog.length === 0
			? ["- No backlog items yet."]
			: state.backlog.map((item) => `- [${item.status}] [${item.kind}] ${item.title} (\`${item.id}\`)`);

	const lines = [
		"## AutoDevelop",
		"",
		`- Goal: \`${state.goal?.path ?? "unknown"}\``,
		`- Phase: \`${state.phase}\``,
		`- Iteration: ${state.iteration}`,
		`- Current item: ${state.currentItemId ? `\`${state.currentItemId}\`` : "none"}`,
		`- Goal hash: \`${state.goal?.hash ?? "unknown"}\``,
	];

	if (state.lastVerificationSummary) lines.push(`- Last verification: ${state.lastVerificationSummary}`);
	if (state.lastFailure) lines.push(`- Last failure: ${state.lastFailure}`);
	if (state.stopReason) lines.push(`- Stop reason: ${state.stopReason}`);

	lines.push("", "### Backlog", "", ...backlogLines);
	return lines.join("\n");
}

function looksLikeLoopState(value) {
	return Boolean(value && value.version === LOOP_STATE_VERSION && value.goal?.path);
}

export function reconstructStateFromEntries(entries) {
	let latestState = null;

	for (const entry of entries ?? []) {
		if (entry.type === "message") {
			const message = entry.message;
			if (
				message?.role === "toolResult" &&
				message.toolName === "autodevelop_state" &&
				looksLikeLoopState(message.details)
			) {
				latestState = cloneLoopState(message.details);
			}
		}

		if (entry.type === "custom" && entry.customType === "autodevelop-control" && looksLikeLoopState(entry.data?.state)) {
			latestState = cloneLoopState(entry.data.state);
		}

		if ((entry.type === "compaction" || entry.type === "branch_summary") && looksLikeLoopState(entry.details?.loopState)) {
			latestState = cloneLoopState(entry.details.loopState);
		}
	}

	return latestState;
}

export function buildLoopContext(state) {
	if (!state) return "";

	const backlogLines =
		state.backlog.length === 0
			? ["- No backlog items yet."]
			: state.backlog.map((item) => {
					const currentSuffix = item.id === state.currentItemId ? " <- current" : "";
					return `- [${item.status}] [${item.kind}] ${item.title} (${item.id})${currentSuffix}`;
				});

	const structuredGoal = state.goal.presentSections?.length
		? state.goal.presentSections
				.map((heading) => `## ${heading}\n${state.goal.sections[heading]}`)
				.join("\n\n")
		: state.goal.text.trim();

	return `[AUTODEVELOP LOOP ACTIVE]
Goal file: ${state.goal.path}
Goal hash: ${state.goal.hash}
Iteration: ${state.iteration}
Phase: ${state.phase}
Current item: ${state.currentItemId ?? "none"}

Immutable goal snapshot:
${structuredGoal}

Backlog:
${backlogLines.join("\n")}

Last verification:
${state.lastVerificationSummary || "None yet."}

Last failure:
${state.lastFailure || "None."}

Rules:
- Never modify the goal markdown file.
- Call autodevelop_state with action="get" before changing the plan or claiming completion.
- Prefer repo-local inspection and tests first.
- External web research is allowed only through tools already available in this session.`;
}
