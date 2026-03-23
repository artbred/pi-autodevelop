import {
	ACTIVE_PHASES,
	BACKLOG_KINDS,
	IMPROVEMENT_DIRECTIONS,
	ITEM_STATUSES,
	LEGACY_LOOP_PHASES,
	LOOP_MODES,
	LOOP_PHASES,
	LOOP_STATE_VERSION,
	PAUSED_OR_TERMINAL_PHASES,
	QUALITY_HARDENING_PRIORITY,
	QUALITY_OBJECTIVE_NAMES,
	QUALITY_OBJECTIVE_STATUSES,
	RESOLVED_QUALITY_OBJECTIVE_STATUSES,
} from "./constants.js";
import { parseGoalDocument } from "./goal.js";

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

function assertValidMode(mode) {
	if (!LOOP_MODES.includes(mode)) {
		throw new Error(`Invalid loop mode: ${mode}`);
	}
}

function assertValidPhase(phase) {
	if (!LOOP_PHASES.includes(phase)) {
		throw new Error(`Invalid loop phase: ${phase}`);
	}
}

function assertValidObjectiveName(objective) {
	if (!QUALITY_OBJECTIVE_NAMES.includes(objective)) {
		throw new Error(`Invalid quality objective: ${objective}`);
	}
}

function assertValidObjectiveStatus(status) {
	if (!QUALITY_OBJECTIVE_STATUSES.includes(status)) {
		throw new Error(`Invalid quality objective status: ${status}`);
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

export function normalizeObjectiveRefs(objectiveRefs) {
	if (!objectiveRefs) return [];

	return [...new Set(objectiveRefs.map((objective) => objective.trim().toLowerCase()))].map((objective) => {
		assertValidObjectiveName(objective);
		return objective;
	});
}

function normalizeGoalSnapshot(goalSnapshot) {
	const goal = clone(goalSnapshot ?? {});
	const parsed = goal.text ? parseGoalDocument(goal.text) : null;

	return {
		...goal,
		sections: goal.sections ?? parsed?.sections ?? {},
		presentSections: goal.presentSections ?? parsed?.presentSections ?? [],
		hasStructuredSections: goal.hasStructuredSections ?? parsed?.hasStructuredSections ?? false,
		explicitOptOuts: goal.explicitOptOuts ?? parsed?.explicitOptOuts ?? [],
	};
}

export function createDefaultQualityObjectives(explicitOptOuts = []) {
	const optedOut = new Set((explicitOptOuts ?? []).map((value) => value.trim().toLowerCase()));
	const objectives = {};

	for (const objective of QUALITY_OBJECTIVE_NAMES) {
		const enabled = !optedOut.has(objective);
		objectives[objective] = {
			enabled,
			status: enabled ? "pending" : "opted_out",
			evidence: enabled ? "" : "Explicitly opted out in goal file.",
		};
	}

	return objectives;
}

function normalizeQualityObjectives(rawObjectives, explicitOptOuts) {
	const defaults = createDefaultQualityObjectives(explicitOptOuts);
	if (!rawObjectives) return defaults;

	const normalized = {};
	for (const objective of QUALITY_OBJECTIVE_NAMES) {
		const raw = rawObjectives[objective];
		if (!raw) {
			normalized[objective] = defaults[objective];
			continue;
		}

		const enabled = raw.enabled ?? defaults[objective].enabled;
		const fallbackStatus = enabled ? defaults[objective].status : "opted_out";
		const status = raw.status ?? fallbackStatus;
		assertValidObjectiveStatus(status);

		normalized[objective] = {
			enabled: status === "opted_out" ? false : enabled,
			status: enabled ? status : "opted_out",
			evidence: raw.evidence?.trim() ?? defaults[objective].evidence,
		};
	}

	return normalized;
}

export function getUnresolvedQualityObjectives(state) {
	if (!state?.qualityObjectives) return [];

	return QUALITY_HARDENING_PRIORITY.filter((objective) => {
		const current = state.qualityObjectives[objective];
		return current?.enabled && !RESOLVED_QUALITY_OBJECTIVE_STATUSES.has(current.status);
	});
}

export function allEnabledQualityObjectivesResolved(state) {
	return getUnresolvedQualityObjectives(state).length === 0;
}

function getCurrentActiveItem(state) {
	if (!state?.currentItemId) return null;

	const item = state.backlog.find((candidate) => candidate.id === state.currentItemId);
	if (!item || item.status === "done" || item.status === "blocked") return null;
	return item;
}

function derivePhaseFromState(state) {
	const currentItem = getCurrentActiveItem(state);
	if (currentItem) return phaseFromKind(currentItem.kind);

	const nextItem = state.backlog.find((candidate) => candidate.status === "in_progress" || candidate.status === "pending");
	return nextItem ? phaseFromKind(nextItem.kind) : "planning";
}

function normalizeModeAndPhase(state) {
	const nextState = cloneLoopState(state);

	if (!nextState.goalSatisfied) {
		nextState.mode = "delivery";
	} else if (nextState.mode === "hardening" && allEnabledQualityObjectivesResolved(nextState)) {
		nextState.mode = "improvement";
	}

	if (!LOOP_PHASES.includes(nextState.phase)) {
		nextState.phase = derivePhaseFromState(nextState);
	}

	return nextState;
}

export function createInitialLoopState(goalSnapshot) {
	const normalizedGoal = normalizeGoalSnapshot(goalSnapshot);

	return {
		version: LOOP_STATE_VERSION,
		goal: normalizedGoal,
		mode: "delivery",
		phase: "planning",
		goalSatisfied: false,
		iteration: 0,
		currentItemId: null,
		backlog: [],
		qualityObjectives: createDefaultQualityObjectives(normalizedGoal.explicitOptOuts),
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
			objectiveRefs: normalizeObjectiveRefs(item.objectiveRefs),
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
			if (!nextState.goalSatisfied) {
				nextState.completionSummary = "";
			}
			nextState.phase = inProgressItem ? phaseFromKind(inProgressItem.kind) : derivePhaseFromState(nextState);
			return normalizeModeAndPhase(nextState);
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
			if (patch.objectiveRefs !== undefined) item.objectiveRefs = normalizeObjectiveRefs(patch.objectiveRefs);

			if (item.status === "in_progress") {
				nextState.currentItemId = item.id;
				nextState.phase = phaseFromKind(item.kind);
			}

			if ((item.status === "done" || item.status === "blocked") && nextState.currentItemId === item.id) {
				nextState.currentItemId = null;
				nextState.phase = derivePhaseFromState(nextState);
			}

			return normalizeModeAndPhase(nextState);
		}

		case "set_phase": {
			if (!params.phase) {
				throw new Error("phase is required for set_phase");
			}
			assertValidPhase(params.phase);

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
			return normalizeModeAndPhase(nextState);
		}

		case "update_objective": {
			if (!params.objective) {
				throw new Error("objective is required for update_objective");
			}
			if (!params.status) {
				throw new Error("status is required for update_objective");
			}

			assertValidObjectiveName(params.objective);
			assertValidObjectiveStatus(params.status);

			const objective = nextState.qualityObjectives[params.objective];
			if (!objective) {
				throw new Error(`Unknown quality objective: ${params.objective}`);
			}

			if (!objective.enabled && params.status !== "opted_out") {
				throw new Error(`Objective "${params.objective}" is opted out in the goal file and cannot be re-enabled here.`);
			}
			if (objective.enabled && params.status === "opted_out") {
				throw new Error(`Objective "${params.objective}" can only be opted out in the goal file.`);
			}

			objective.status = params.status;
			if (params.evidence !== undefined) {
				objective.evidence = params.evidence.trim();
			}

			if (
				nextState.goalSatisfied &&
				nextState.mode === "improvement" &&
				objective.enabled &&
				!RESOLVED_QUALITY_OBJECTIVE_STATUSES.has(objective.status)
			) {
				nextState.mode = "hardening";
			}

			return normalizeModeAndPhase(nextState);
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
			return normalizeModeAndPhase(nextState);
		}

		case "complete": {
			const summary = params.summary?.trim() ?? "";
			const previousMode = nextState.mode;

			nextState.goalSatisfied = true;
			nextState.stopReason = "";
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
			nextState.phase = "planning";
			if (previousMode === "delivery") {
				nextState.mode = "hardening";
				return nextState;
			}

			return normalizeModeAndPhase(nextState);
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
	return derivePhaseFromState(state);
}

export function formatLoopStateMarkdown(state) {
	if (!state) {
		return "## AutoDevelop\n\nNo loop state is active.";
	}

	const backlogLines =
		state.backlog.length === 0
			? ["- No backlog items yet."]
			: state.backlog.map((item) => {
					const refs = item.objectiveRefs?.length ? ` -> ${item.objectiveRefs.join(", ")}` : "";
					return `- [${item.status}] [${item.kind}] ${item.title} (\`${item.id}\`)${refs}`;
				});

	const objectiveLines = QUALITY_HARDENING_PRIORITY.map((objective) => {
		const current = state.qualityObjectives?.[objective];
		if (!current) return `- ${objective}: missing`;
		const suffix = current.evidence ? ` - ${current.evidence}` : "";
		return `- ${objective}: [${current.status}]${suffix}`;
	});

	const lines = [
		"## AutoDevelop",
		"",
		`- Goal: \`${state.goal?.path ?? "unknown"}\``,
		`- Mode: \`${state.mode ?? "unknown"}\``,
		`- Phase: \`${state.phase}\``,
		`- Primary goal satisfied: ${state.goalSatisfied ? "yes" : "no"}`,
		`- Iteration: ${state.iteration}`,
		`- Current item: ${state.currentItemId ? `\`${state.currentItemId}\`` : "none"}`,
		`- Goal hash: \`${state.goal?.hash ?? "unknown"}\``,
	];

	if (state.completionSummary) lines.push(`- Goal completion summary: ${state.completionSummary}`);
	if (state.lastVerificationSummary) lines.push(`- Last verification: ${state.lastVerificationSummary}`);
	if (state.lastFailure) lines.push(`- Last failure: ${state.lastFailure}`);
	if (state.stopReason) lines.push(`- Stop reason: ${state.stopReason}`);

	lines.push("", "### Quality Objectives", "", ...objectiveLines, "", "### Backlog", "", ...backlogLines);
	return lines.join("\n");
}

function looksLikeLoopState(value) {
	return Boolean(value && value.goal?.path);
}

export function migrateLoopState(rawState) {
	if (!rawState) return null;

	const nextState = cloneLoopState(rawState);
	nextState.version = LOOP_STATE_VERSION;
	nextState.goal = normalizeGoalSnapshot(nextState.goal);
	nextState.backlog = normalizeBacklogItems(nextState.backlog ?? []);
	nextState.goalSatisfied = Boolean(nextState.goalSatisfied);
	nextState.mode =
		nextState.mode && LOOP_MODES.includes(nextState.mode)
			? nextState.mode
			: nextState.phase === "improving"
				? "improvement"
				: nextState.goalSatisfied
					? "hardening"
					: "delivery";
	assertValidMode(nextState.mode);

	if (!nextState.phase || LEGACY_LOOP_PHASES.has(nextState.phase) || !LOOP_PHASES.includes(nextState.phase)) {
		nextState.phase = derivePhaseFromState(nextState);
	}

	nextState.qualityObjectives = normalizeQualityObjectives(nextState.qualityObjectives, nextState.goal.explicitOptOuts);
	nextState.lastVerificationSummary = nextState.lastVerificationSummary?.trim?.() ?? "";
	nextState.lastFailure = nextState.lastFailure?.trim?.() ?? "";
	nextState.stopReason = nextState.stopReason?.trim?.() ?? "";
	nextState.completionSummary = nextState.completionSummary?.trim?.() ?? "";
	nextState.iteration = Number.isFinite(nextState.iteration) ? nextState.iteration : 0;
	nextState.currentItemId = nextState.currentItemId ?? null;

	return normalizeModeAndPhase(nextState);
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
				latestState = migrateLoopState(message.details);
			}
		}

		if (entry.type === "custom" && entry.customType === "autodevelop-control" && looksLikeLoopState(entry.data?.state)) {
			latestState = migrateLoopState(entry.data.state);
		}

		if ((entry.type === "compaction" || entry.type === "branch_summary") && looksLikeLoopState(entry.details?.loopState)) {
			latestState = migrateLoopState(entry.details.loopState);
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
					const refs = item.objectiveRefs?.length ? ` -> ${item.objectiveRefs.join(", ")}` : "";
					return `- [${item.status}] [${item.kind}] ${item.title} (${item.id})${refs}${currentSuffix}`;
				});

	const structuredGoal = state.goal.presentSections?.length
		? state.goal.presentSections.map((heading) => `## ${heading}\n${state.goal.sections[heading]}`).join("\n\n")
		: state.goal.text.trim();

	const objectiveLines = QUALITY_HARDENING_PRIORITY.map((objective) => {
		const current = state.qualityObjectives?.[objective];
		if (!current) return `- ${objective}: missing`;
		const suffix = current.evidence ? ` (${current.evidence})` : "";
		return `- ${objective}: [${current.status}]${suffix}`;
	});

	const unresolvedObjectives = getUnresolvedQualityObjectives(state);
	const optOuts = state.goal.explicitOptOuts?.length ? state.goal.explicitOptOuts.join(", ") : "none";

	return `[AUTODEVELOP LOOP ACTIVE]
Goal file: ${state.goal.path}
Goal hash: ${state.goal.hash}
Iteration: ${state.iteration}
Mode: ${state.mode}
Phase: ${state.phase}
Primary goal satisfied: ${state.goalSatisfied ? "yes" : "no"}
Current item: ${state.currentItemId ?? "none"}

Immutable goal snapshot:
${structuredGoal}

Backlog:
${backlogLines.join("\n")}

Quality objectives:
${objectiveLines.join("\n")}

Explicit opt-outs:
${optOuts}

Unresolved quality objectives in priority order:
${unresolvedObjectives.length ? unresolvedObjectives.join(", ") : "none"}

Last verification:
${state.lastVerificationSummary || "None yet."}

Last failure:
${state.lastFailure || "None."}

Rules:
- Never modify the goal markdown file.
- Call autodevelop_state with action="get" before changing the plan or claiming completion.
- Unless explicitly opted out in the goal file, treat performance, latency, throughput, memory efficiency, scalability, and reliability as default success dimensions.
- When backlog is empty in delivery mode, replan while accounting for unresolved quality objectives from the start.
- When backlog is empty in hardening or improvement mode, prioritize unresolved quality objectives in this order: ${QUALITY_HARDENING_PRIORITY.join(", ")}.
- For large-data and high-load systems, inspect chunking, batching, streaming, pagination, memory pressure, queue depth, retries, timeouts, idempotency, and backpressure unless explicitly opted out.
- After hardening objectives are resolved, improvement mode should continue with these directions: ${IMPROVEMENT_DIRECTIONS.join(", ")}.
- External web research is allowed only through tools already available in this session.`;
}
