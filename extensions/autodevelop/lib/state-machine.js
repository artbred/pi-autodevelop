import {
	ACTIVE_PHASES,
	BACKLOG_KINDS,
	CYCLE_LAUNCH_STATES,
	ITEM_STATUSES,
	LEGACY_LOOP_PHASES,
	LOOP_MODES,
	LOOP_PHASES,
	LOOP_STATE_VERSION,
	PAUSED_OR_TERMINAL_PHASES,
	QUALITY_HARDENING_PRIORITY,
	QUALITY_OBJECTIVE_NAMES,
	QUALITY_OBJECTIVE_STATUSES,
	RESEARCH_PROVIDER_NAMES,
	RESEARCH_SCOPES,
	RESOLVED_QUALITY_OBJECTIVE_STATUSES,
} from "./constants.js";
import { parseGoalDocument } from "./goal.js";

function slugify(value, fallback) {
	const slug = String(value ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);

	return slug || fallback;
}

function trimText(value) {
	return typeof value === "string" ? value.trim() : "";
}

function clone(value) {
	return value ? JSON.parse(JSON.stringify(value)) : value;
}

function uniqueTrimmed(values) {
	return [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))];
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

function assertValidCycleLaunchState(state) {
	if (!CYCLE_LAUNCH_STATES.includes(state)) {
		throw new Error(`Invalid cycle launch state: ${state}`);
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

function assertValidResearchScope(scope) {
	if (!RESEARCH_SCOPES.includes(scope)) {
		throw new Error(`Invalid research scope: ${scope}`);
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
		default:
			return "planning";
	}
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

function normalizeEvidenceRefs(evidenceRefs) {
	return uniqueTrimmed(evidenceRefs);
}

function normalizeResearchDependencies(dependsOnResearchItemIds) {
	return uniqueTrimmed(dependsOnResearchItemIds);
}

function normalizeCycleChangedFiles(files) {
	return uniqueTrimmed(files);
}

function normalizeCycleBlockers(blockers) {
	return uniqueTrimmed(blockers);
}

function normalizeCycleCommits(commits) {
	return (commits ?? [])
		.map((commit) => ({
			sha: trimText(commit?.sha),
			shortSha: trimText(commit?.shortSha),
			subject: trimText(commit?.subject),
			committedAt: trimText(commit?.committedAt),
		}))
		.filter((commit) => commit.sha || commit.subject);
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
			evidence: trimText(raw.evidence) || defaults[objective].evidence,
		};
	}

	return normalized;
}

export function createDefaultResearchProviders() {
	return {
		local: {
			configured: true,
			healthy: true,
			description: "Built-in local repo research is always available.",
			lastError: "",
			lastCheckedAt: "",
		},
		searxng: {
			configured: false,
			healthy: false,
			description: "SearXNG not configured.",
			lastError: "",
			lastCheckedAt: "",
		},
		pinchtab: {
			configured: false,
			healthy: false,
			description: "PinchTab not configured.",
			lastError: "",
			lastCheckedAt: "",
		},
	};
}

function normalizeResearchProviders(rawProviders) {
	const defaults = createDefaultResearchProviders();
	if (!rawProviders) return defaults;

	const normalized = {};
	for (const name of RESEARCH_PROVIDER_NAMES) {
		const raw = rawProviders[name] ?? {};
		normalized[name] = {
			configured: Boolean(raw.configured ?? defaults[name].configured),
			healthy: Boolean(raw.healthy ?? defaults[name].healthy),
			description: trimText(raw.description) || defaults[name].description,
			lastError: trimText(raw.lastError),
			lastCheckedAt: trimText(raw.lastCheckedAt),
		};
	}

	return normalized;
}

function normalizeResearchArtifact(artifact, index = 0) {
	if (!artifact) return null;

	const scope = artifact.scope ?? "auto";
	assertValidResearchScope(scope);

	return {
		id: trimText(artifact.id) || `research-artifact-${index + 1}`,
		createdAt: trimText(artifact.createdAt),
		action: trimText(artifact.action) || "query",
		scope,
		provider: trimText(artifact.provider) || "local",
		query: trimText(artifact.query),
		target: trimText(artifact.target),
		summary: trimText(artifact.summary),
		content: trimText(artifact.content),
		sources: Array.isArray(artifact.sources)
			? artifact.sources.map((source) => ({
					kind: trimText(source.kind) || "url",
					location: trimText(source.location),
					title: trimText(source.title),
					snippet: trimText(source.snippet),
					line: Number.isFinite(source.line) ? source.line : undefined,
				}))
			: [],
		objectiveRefs: normalizeObjectiveRefs(artifact.objectiveRefs),
	};
}

function normalizeResearchArtifacts(artifacts) {
	return (artifacts ?? []).map((artifact, index) => normalizeResearchArtifact(artifact, index)).filter(Boolean);
}

function normalizeKind(kind) {
	const normalized = trimText(kind).toLowerCase();
	if (normalized === "verify") return "test";
	return normalized;
}

function normalizeBacklogItem(item, index = 0) {
	if (!item) return null;

	const kind = normalizeKind(item.kind ?? "code");
	assertValidKind(kind);

	let status = trimText(item.status) || "pending";
	if (item.verificationStatus === "running" || item.verificationStatus === "pending") {
		status = "pending";
	}
	assertValidStatus(status);

	return {
		id: trimText(item.id) || `item-${index + 1}-${slugify(item.title ?? kind, kind)}`,
		title: trimText(item.title) || `Untitled ${kind} task ${index + 1}`,
		kind,
		status,
		notes: trimText(item.notes),
		acceptanceCriteria: trimText(item.acceptanceCriteria),
		objectiveRefs: normalizeObjectiveRefs(item.objectiveRefs),
		researchRequired: Boolean(item.researchRequired),
		evidenceRefs: normalizeEvidenceRefs(item.evidenceRefs),
		dependsOnResearchItemIds: normalizeResearchDependencies(item.dependsOnResearchItemIds),
	};
}

function normalizeBacklog(backlog) {
	return (backlog ?? []).map((item, index) => normalizeBacklogItem(item, index)).filter(Boolean);
}

function findRunnableItem(backlog, currentItemId = null) {
	const current = currentItemId
		? backlog.find((item) => item.id === currentItemId && (item.status === "pending" || item.status === "in_progress"))
		: null;
	return current ?? backlog.find((item) => item.status === "in_progress") ?? backlog.find((item) => item.status === "pending") ?? null;
}

function selectCurrentItemId(backlog) {
	return findRunnableItem(backlog)?.id ?? null;
}

function derivePhase(backlog, currentItemId, currentPhase = "planning") {
	if (["paused", "blocked", "stopped", "committing", "relaunching"].includes(currentPhase)) {
		return currentPhase;
	}

	const runnable = findRunnableItem(backlog, currentItemId);
	if (runnable) return phaseFromKind(runnable.kind);
	if (backlog.some((item) => item.status === "blocked")) return "blocked";
	return "planning";
}

function appendUniqueText(existing, nextLine) {
	const next = trimText(nextLine);
	if (!next) return trimText(existing);
	const current = trimText(existing);
	if (!current) return next;
	if (current.includes(next)) return current;
	return `${current}\n${next}`;
}

function createResearchItemFromUncertainty(params, item, backlog) {
	const title = trimText(params.question) || `Research for ${item.title}`;
	return normalizeBacklogItem(
		{
			id: trimText(params.newItemId) || `research-${backlog.length + 1}-${slugify(title, "research")}`,
			title,
			kind: "research",
			status: "pending",
			notes: trimText(params.reason),
			objectiveRefs: normalizeObjectiveRefs(params.objectiveRefs ?? item.objectiveRefs),
		},
		backlog.length,
	);
}

function unfinishedDependencyTitles(state, item) {
	const blockers = [];
	for (const dependencyId of item.dependsOnResearchItemIds ?? []) {
		const dependency = state.backlog.find((candidate) => candidate.id === dependencyId);
		if (dependency && dependency.status !== "done") {
			blockers.push(dependency.title);
		}
	}
	return blockers;
}

function validateCompletionRequirements(state, item) {
	if (!item) {
		throw new Error("Cannot complete an unknown backlog item.");
	}

	if (item.kind === "research" && item.evidenceRefs.length === 0) {
		throw new Error(`Research item "${item.title}" requires evidenceRefs before it can be marked done.`);
	}

	if (item.researchRequired && item.evidenceRefs.length === 0) {
		throw new Error(`Item "${item.title}" requires linked research evidence before it can be marked done.`);
	}

	const dependencyTitles = unfinishedDependencyTitles(state, item);
	if (dependencyTitles.length) {
		throw new Error(`Item "${item.title}" still depends on unfinished research: ${dependencyTitles.join(", ")}.`);
	}
}

function normalizeMode(mode) {
	if (trimText(mode) && LOOP_MODES.includes(trimText(mode))) {
		return trimText(mode);
	}
	return "cycle";
}

function normalizePhase(phase) {
	const normalized = trimText(phase).toLowerCase();
	if (normalized === "verifying" || normalized === "reviewing") return "testing";
	if (LEGACY_LOOP_PHASES.has(normalized)) return "planning";
	if (LOOP_PHASES.includes(normalized)) return normalized;
	return "planning";
}

function normalizeCycleLaunchState(value, fallback = "acknowledged") {
	const normalized = trimText(value).toLowerCase();
	if (CYCLE_LAUNCH_STATES.includes(normalized)) {
		return normalized;
	}
	return fallback;
}

function inferCycleLaunchState(state, backlog, phase, currentItemId) {
	const explicit = trimText(state?.cycleLaunchState);
	if (explicit) {
		return normalizeCycleLaunchState(explicit);
	}

	const launchQueuedAt = trimText(state?.launchQueuedAt);
	const launchAcknowledgedAt = trimText(state?.launchAcknowledgedAt);
	if (launchQueuedAt && !launchAcknowledgedAt) {
		return "queued";
	}

	if (backlog.length > 0 || currentItemId || (Number.isFinite(state?.iteration) && state.iteration > 0)) {
		return "acknowledged";
	}

	if ((phase === "planning" || phase === "relaunching") && !state?.goalSatisfied) {
		return "not_started";
	}

	return "acknowledged";
}

export function createInitialLoopState(goalSnapshot, researchProviders = createDefaultResearchProviders(), repoContext = {}) {
	const goal = normalizeGoalSnapshot(goalSnapshot);

	return {
		version: LOOP_STATE_VERSION,
		mode: "cycle",
		phase: "planning",
		goal,
		repoRoot: trimText(repoContext.repoRoot),
		branch: trimText(repoContext.branch),
		iteration: 0,
		cycleNumber: Number.isFinite(repoContext.cycleNumber) && repoContext.cycleNumber > 0 ? repoContext.cycleNumber : 1,
		lastCycleCommitSha: "",
		lastCycleSummary: "",
		lastCycleChangedFiles: [],
		lastCycleNoop: false,
		lastCycleBlockers: [],
		nextCycleAt: "",
		recentCycleCommits: normalizeCycleCommits(repoContext.recentCycleCommits),
		cycleLaunchState: "not_started",
		launchId: "",
		launchPrompt: "",
		launchQueuedAt: "",
		launchAcknowledgedAt: "",
		relaunchRequested: false,
		compactionRequested: false,
		recoveryCount: 0,
		goalSatisfied: false,
		completionSummary: "",
		currentItemId: null,
		backlog: [],
		qualityObjectives: normalizeQualityObjectives(undefined, goal.explicitOptOuts),
		researchProviders: normalizeResearchProviders(researchProviders),
		researchArtifacts: [],
		lastFailure: "",
		stopReason: "",
	};
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

export function getUnresolvedResearchBlockers(state) {
	if (!state?.backlog?.length) return [];

	const blockers = [];
	for (const item of state.backlog) {
		if (item.kind === "research" && item.status !== "done") {
			blockers.push(item);
			continue;
		}
		if (item.researchRequired && item.status !== "done" && item.evidenceRefs.length === 0) {
			blockers.push(item);
		}
	}
	return blockers;
}

export function getRecentResearchArtifacts(state, count = 5) {
	return (state?.researchArtifacts ?? []).slice(Math.max(0, (state?.researchArtifacts?.length ?? 0) - count));
}

export function isLoopRunning(state) {
	return Boolean(state && ACTIVE_PHASES.has(state.phase));
}

export function nextRunnablePhase(state) {
	if (!state) return "planning";
	if (PAUSED_OR_TERMINAL_PHASES.has(state.phase)) return state.phase;
	return derivePhase(state.backlog ?? [], state.currentItemId, state.phase);
}

export function applyStateAction(state, action, params = {}) {
	const nextState = migrateLoopState(state);
	if (!nextState) {
		throw new Error("Loop state is missing or invalid.");
	}

	switch (action) {
		case "get":
			return nextState;

		case "replace_plan": {
			const items = Array.isArray(params.items) ? params.items : [];
			nextState.backlog = normalizeBacklog(items);
			nextState.currentItemId = selectCurrentItemId(nextState.backlog);
			nextState.phase = derivePhase(nextState.backlog, nextState.currentItemId, "planning");
			nextState.stopReason = "";
			if (nextState.phase !== "blocked") {
				nextState.lastFailure = "";
			}
			return nextState;
		}

		case "update_item": {
			const itemId = trimText(params.itemId);
			if (!itemId) {
				throw new Error("itemId is required for update_item");
			}

			const index = nextState.backlog.findIndex((item) => item.id === itemId);
			if (index === -1) {
				throw new Error(`Unknown backlog item: ${itemId}`);
			}

			const existing = nextState.backlog[index];
			const patch = params.patch ?? {};
			const merged = normalizeBacklogItem(
				{
					...existing,
					...patch,
				},
				index,
			);
			if (!merged) {
				throw new Error(`Failed to normalize backlog item: ${itemId}`);
			}
			if (merged.status === "done") {
				validateCompletionRequirements(nextState, merged);
			}

			nextState.backlog[index] = merged;
			nextState.currentItemId = selectCurrentItemId(nextState.backlog);
			nextState.phase = derivePhase(nextState.backlog, nextState.currentItemId, nextState.phase);
			nextState.stopReason = "";
			if (merged.status !== "blocked" && nextState.phase !== "blocked") {
				nextState.lastFailure = "";
			}
			return nextState;
		}

		case "set_phase": {
			const phase = normalizePhase(params.phase);
			assertValidPhase(phase);
			nextState.phase = phase;

			if (params.currentItemId !== undefined) {
				const requestedId = trimText(params.currentItemId);
				nextState.currentItemId = requestedId && nextState.backlog.some((item) => item.id === requestedId) ? requestedId : selectCurrentItemId(nextState.backlog);
			} else if (!PAUSED_OR_TERMINAL_PHASES.has(phase) && phase !== "committing" && phase !== "relaunching") {
				nextState.currentItemId = selectCurrentItemId(nextState.backlog);
			}

			if (params.failure !== undefined) {
				nextState.lastFailure = trimText(params.failure);
			}
			if (phase !== "blocked") {
				nextState.stopReason = "";
			}
			return nextState;
		}

		case "update_objective": {
			const objective = trimText(params.objective).toLowerCase();
			const status = trimText(params.status).toLowerCase();
			assertValidObjectiveName(objective);
			assertValidObjectiveStatus(status);
			nextState.qualityObjectives[objective] = {
				enabled: status === "opted_out" ? false : true,
				status,
				evidence: trimText(params.evidence) || trimText(nextState.qualityObjectives[objective]?.evidence),
			};
			return nextState;
		}

		case "flag_uncertainty": {
			const itemId = trimText(params.itemId);
			if (!itemId) {
				throw new Error("itemId is required for flag_uncertainty");
			}

			const item = nextState.backlog.find((candidate) => candidate.id === itemId);
			if (!item) {
				throw new Error(`Unknown backlog item: ${itemId}`);
			}

			item.status = "blocked";
			item.notes = appendUniqueText(item.notes, trimText(params.reason));

			const researchItem = createResearchItemFromUncertainty(params, item, nextState.backlog);
			nextState.backlog.push(researchItem);
			nextState.currentItemId = selectCurrentItemId(nextState.backlog);
			nextState.phase = derivePhase(nextState.backlog, nextState.currentItemId, "planning");
			nextState.lastFailure = trimText(params.reason) || nextState.lastFailure;
			nextState.stopReason = "";
			return nextState;
		}

		case "block": {
			const reason = trimText(params.reason);
			if (!reason) {
				throw new Error("reason is required for block");
			}

			const activeItem = nextState.backlog.find((item) => item.id === nextState.currentItemId && item.status === "in_progress");
			const alternativeWork = nextState.backlog.some(
				(item) => item.id !== activeItem?.id && (item.status === "pending" || item.status === "in_progress"),
			);

			if (activeItem && alternativeWork) {
				activeItem.status = "blocked";
				activeItem.notes = appendUniqueText(activeItem.notes, reason);
				nextState.currentItemId = selectCurrentItemId(nextState.backlog);
				nextState.phase = derivePhase(nextState.backlog, nextState.currentItemId, "planning");
				nextState.lastFailure = reason;
				nextState.stopReason = "";
				return nextState;
			}

			nextState.phase = "blocked";
			nextState.stopReason = reason;
			nextState.lastFailure = reason;
			nextState.currentItemId = selectCurrentItemId(nextState.backlog);
			return nextState;
		}

		case "complete": {
			const summary = trimText(params.summary);
			if (!summary) {
				throw new Error("summary is required for complete");
			}
			if (nextState.backlog.some((item) => item.status === "pending" || item.status === "in_progress")) {
				throw new Error("Cannot complete the cycle while pending or in-progress backlog items remain.");
			}
			if (!nextState.backlog.some((item) => item.status === "done")) {
				throw new Error("Cannot complete the cycle before at least one backlog item is done.");
			}

			nextState.goalSatisfied = true;
			nextState.completionSummary = summary;
			nextState.phase = "committing";
			nextState.currentItemId = null;
			nextState.lastFailure = "";
			nextState.stopReason = "";
			return nextState;
		}

		case "sync_research_providers": {
			nextState.researchProviders = normalizeResearchProviders(params.providers);
			return nextState;
		}

		case "record_research_artifact": {
			const artifact = normalizeResearchArtifact(params.artifact, nextState.researchArtifacts.length);
			if (!artifact) {
				throw new Error("artifact is required for record_research_artifact");
			}
			const existingIndex = nextState.researchArtifacts.findIndex((candidate) => candidate.id === artifact.id);
			if (existingIndex >= 0) {
				nextState.researchArtifacts[existingIndex] = artifact;
			} else {
				nextState.researchArtifacts.push(artifact);
			}
			return nextState;
		}

		case "sync_git_context": {
			nextState.repoRoot = trimText(params.repoRoot) || nextState.repoRoot;
			nextState.branch = trimText(params.branch) || nextState.branch;
			if (params.recentCycleCommits !== undefined) {
				nextState.recentCycleCommits = normalizeCycleCommits(params.recentCycleCommits);
			}
			return nextState;
		}

		case "record_cycle_result": {
			nextState.lastCycleCommitSha = trimText(params.commitSha);
			nextState.lastCycleSummary = trimText(params.summary);
			nextState.lastCycleChangedFiles = normalizeCycleChangedFiles(params.changedFiles);
			nextState.lastCycleNoop = Boolean(params.noop);
			nextState.lastCycleBlockers = normalizeCycleBlockers(params.blockers);
			nextState.nextCycleAt = trimText(params.nextCycleAt);
			if (params.recentCycleCommits !== undefined) {
				nextState.recentCycleCommits = normalizeCycleCommits(params.recentCycleCommits);
			}
			return nextState;
		}

		case "prepare_cycle_launch": {
			nextState.cycleLaunchState = "not_started";
			nextState.launchId = trimText(params.launchId);
			nextState.launchPrompt = trimText(params.launchPrompt);
			nextState.launchQueuedAt = "";
			nextState.launchAcknowledgedAt = "";
			nextState.relaunchRequested = params.relaunchRequested === undefined ? true : Boolean(params.relaunchRequested);
			nextState.compactionRequested = Boolean(params.compactionRequested);
			nextState.recoveryCount = Number.isFinite(params.recoveryCount) && params.recoveryCount >= 0 ? params.recoveryCount : 0;
			if (params.nextCycleAt !== undefined) {
				nextState.nextCycleAt = trimText(params.nextCycleAt);
				nextState.phase = nextState.nextCycleAt ? "relaunching" : "planning";
			}
			return nextState;
		}

		case "queue_cycle_launch": {
			nextState.cycleLaunchState = "queued";
			nextState.launchQueuedAt = trimText(params.queuedAt) || new Date().toISOString();
			nextState.relaunchRequested = true;
			nextState.compactionRequested = Boolean(params.compactionRequested);
			if (params.nextCycleAt !== undefined) {
				nextState.nextCycleAt = trimText(params.nextCycleAt);
			}
			if (!nextState.nextCycleAt) {
				nextState.phase = "planning";
			}
			return nextState;
		}

		case "acknowledge_cycle_launch": {
			nextState.cycleLaunchState = "acknowledged";
			nextState.launchAcknowledgedAt = trimText(params.acknowledgedAt) || new Date().toISOString();
			nextState.relaunchRequested = false;
			nextState.compactionRequested = false;
			nextState.nextCycleAt = "";
			if (nextState.phase === "relaunching") {
				nextState.phase = "planning";
			}
			return nextState;
		}

		case "record_launch_recovery": {
			nextState.recoveryCount = Math.max(0, Number(nextState.recoveryCount) || 0) + 1;
			return nextState;
		}

		case "begin_next_cycle": {
			nextState.cycleNumber = Math.max(1, Number(nextState.cycleNumber || 1)) + 1;
			nextState.phase = trimText(params.nextCycleAt) ? "relaunching" : "planning";
			nextState.currentItemId = null;
			nextState.backlog = [];
			nextState.goalSatisfied = false;
			nextState.completionSummary = "";
			nextState.lastFailure = "";
			nextState.stopReason = "";
			nextState.iteration = 0;
			nextState.nextCycleAt = trimText(params.nextCycleAt);
			nextState.cycleLaunchState = "not_started";
			nextState.launchId = trimText(params.launchId);
			nextState.launchPrompt = trimText(params.launchPrompt);
			nextState.launchQueuedAt = "";
			nextState.launchAcknowledgedAt = "";
			nextState.relaunchRequested = params.relaunchRequested === undefined ? true : Boolean(params.relaunchRequested);
			nextState.compactionRequested = Boolean(params.compactionRequested);
			nextState.recoveryCount = Number.isFinite(params.recoveryCount) && params.recoveryCount >= 0 ? params.recoveryCount : 0;
			if (params.recentCycleCommits !== undefined) {
				nextState.recentCycleCommits = normalizeCycleCommits(params.recentCycleCommits);
			}
			return nextState;
		}

		default:
			throw new Error(`Unsupported state action: ${action}`);
	}
}

export function migrateLoopState(state) {
	if (!state) return null;

	const goal = normalizeGoalSnapshot(state.goal);
	const backlog = normalizeBacklog(state.backlog);
	const currentItemId = trimText(state.currentItemId);
	const currentId = currentItemId && backlog.some((item) => item.id === currentItemId) ? currentItemId : selectCurrentItemId(backlog);
	const normalizedPhase = normalizePhase(state.phase);
	const cycleLaunchState = inferCycleLaunchState(state, backlog, normalizedPhase, currentId);

	const nextState = {
		version: LOOP_STATE_VERSION,
		mode: normalizeMode(state.mode),
		phase: normalizedPhase,
		goal,
		repoRoot: trimText(state.repoRoot) || trimText(state.verifierBackend?.repoRoot),
		branch: trimText(state.branch),
		iteration: Number.isFinite(state.iteration) ? state.iteration : 0,
		cycleNumber: Number.isFinite(state.cycleNumber) && state.cycleNumber > 0 ? state.cycleNumber : 1,
		lastCycleCommitSha: trimText(state.lastCycleCommitSha),
		lastCycleSummary: trimText(state.lastCycleSummary || state.completionSummary),
		lastCycleChangedFiles: normalizeCycleChangedFiles(state.lastCycleChangedFiles),
		lastCycleNoop: Boolean(state.lastCycleNoop),
		lastCycleBlockers: normalizeCycleBlockers(state.lastCycleBlockers),
		nextCycleAt: trimText(state.nextCycleAt),
		recentCycleCommits: normalizeCycleCommits(state.recentCycleCommits),
		cycleLaunchState,
		launchId: trimText(state.launchId),
		launchPrompt: trimText(state.launchPrompt),
		launchQueuedAt: trimText(state.launchQueuedAt),
		launchAcknowledgedAt: trimText(state.launchAcknowledgedAt),
		relaunchRequested:
			typeof state.relaunchRequested === "boolean"
				? state.relaunchRequested
				: cycleLaunchState !== "acknowledged" || Boolean(trimText(state.nextCycleAt)),
		compactionRequested: Boolean(state.compactionRequested),
		recoveryCount: Number.isFinite(state.recoveryCount) && state.recoveryCount >= 0 ? state.recoveryCount : 0,
		goalSatisfied: Boolean(state.goalSatisfied),
		completionSummary: trimText(state.completionSummary),
		currentItemId: currentId,
		backlog,
		qualityObjectives: normalizeQualityObjectives(state.qualityObjectives, goal.explicitOptOuts),
		researchProviders: normalizeResearchProviders(state.researchProviders),
		researchArtifacts: normalizeResearchArtifacts(state.researchArtifacts),
		lastFailure: trimText(state.lastFailure),
		stopReason: trimText(state.stopReason),
	};

	assertValidMode(nextState.mode);
	assertValidCycleLaunchState(nextState.cycleLaunchState);
	if (!PAUSED_OR_TERMINAL_PHASES.has(nextState.phase) && nextState.phase !== "committing" && nextState.phase !== "relaunching") {
		nextState.phase = derivePhase(nextState.backlog, nextState.currentItemId, nextState.phase);
	}
	assertValidPhase(nextState.phase);
	return nextState;
}

export function reconstructStateFromEntries(entries = []) {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type === "custom" && entry.customType === "autodevelop-control" && entry.data?.state) {
			return migrateLoopState(entry.data.state);
		}

		if (entry?.type !== "message") continue;
		const details = entry.message?.details;
		const candidate = details?.loopState ?? details?.state ?? details;
		if (candidate?.goal?.path) {
			return migrateLoopState(candidate);
		}
	}

	return null;
}

function formatBacklogLine(item, state) {
	const refs = item.objectiveRefs?.length ? ` -> ${item.objectiveRefs.join(",")}` : "";
	const evidence = item.evidenceRefs?.length ? ` evidence:${item.evidenceRefs.join(",")}` : "";
	const blockers = item.dependsOnResearchItemIds?.length ? ` deps:${item.dependsOnResearchItemIds.join(",")}` : "";
	const required = item.researchRequired ? " research:required" : "";
	const currentSuffix = item.id === state.currentItemId ? " current" : "";
	return `- [${item.status}] [${item.kind}] ${item.title} (${item.id})${refs}${evidence}${blockers}${required}${currentSuffix}`;
}

export function formatLoopStateMarkdown(state) {
	if (!state) {
		return "## AutoDevelop\n\nNo loop state is available.";
	}

	const unresolvedObjectives = getUnresolvedQualityObjectives(state);
	const recentResearch = getRecentResearchArtifacts(state, 5);
	const recentCommits = state.recentCycleCommits?.length
		? state.recentCycleCommits.map((commit) => `- ${commit.shortSha || commit.sha.slice(0, 12)} ${commit.subject}`).join("\n")
		: "- none";
	const backlogLines = state.backlog.length ? state.backlog.map((item) => formatBacklogLine(item, state)).join("\n") : "- none";
	const objectiveLines = QUALITY_HARDENING_PRIORITY.map((objective) => {
		const current = state.qualityObjectives?.[objective];
		return `- ${objective}: ${current?.status ?? "unknown"}${current?.evidence ? ` (${current.evidence})` : ""}`;
	}).join("\n");
	const researchLines = recentResearch.length
		? recentResearch.map((artifact) => `- ${artifact.id} [${artifact.provider}] ${artifact.summary || artifact.query || artifact.target || "No summary."}`).join("\n")
		: "- none";

	return `## AutoDevelop

- Goal: \`${state.goal?.path ?? "unknown"}\`
- Goal hash: \`${state.goal?.hash ?? "unknown"}\`
- Repo root: \`${state.repoRoot || "unknown"}\`
- Branch: \`${state.branch || "unknown"}\`
- Mode: \`${state.mode}\`
- Phase: \`${state.phase}\`
- Cycle: \`${state.cycleNumber}\`
- Iteration: \`${state.iteration}\`
- Current item: ${state.currentItemId ? `\`${state.currentItemId}\`` : "none"}
- Last cycle commit: ${state.lastCycleCommitSha ? `\`${state.lastCycleCommitSha}\`` : "none"}
- Last cycle summary: ${state.lastCycleSummary || "none"}
- Last cycle changed files: ${state.lastCycleChangedFiles?.length ? state.lastCycleChangedFiles.join(", ") : "none"}
- Last cycle noop: ${state.lastCycleNoop ? "yes" : "no"}
- Cycle launch state: ${state.cycleLaunchState || "unknown"}
- Launch queued at: ${state.launchQueuedAt || "none"}
- Launch acknowledged at: ${state.launchAcknowledgedAt || "none"}
- Relaunch requested: ${state.relaunchRequested ? "yes" : "no"}
- Compaction requested: ${state.compactionRequested ? "yes" : "no"}
- Recovery count: ${Number.isFinite(state.recoveryCount) ? state.recoveryCount : 0}
- Next cycle retry: ${state.nextCycleAt || "none"}
- Goal satisfied in current cycle: ${state.goalSatisfied ? "yes" : "no"}
- Completion summary: ${state.completionSummary || "none"}
- Unresolved quality objectives: ${unresolvedObjectives.length ? unresolvedObjectives.join(", ") : "none"}
- Last failure: ${state.lastFailure || "none"}
- Stop reason: ${state.stopReason || "none"}

### Backlog

${backlogLines}

### Quality Objectives

${objectiveLines}

### Recent Research

${researchLines}

### Recent AutoDevelop Commits

${recentCommits}`;
}

export function buildLoopContext(state) {
	if (!state) {
		return "AUTODEVELOP LOOP INACTIVE";
	}

	const backlogLines = state.backlog.length ? state.backlog.map((item) => formatBacklogLine(item, state)).join("\n") : "- none";
	const recentCommits = state.recentCycleCommits?.length
		? state.recentCycleCommits
			.map((commit) => `- ${commit.shortSha || commit.sha.slice(0, 12)} ${commit.subject} (${commit.committedAt || "unknown"})`)
			.join("\n")
		: "- none";
	const recentResearch = getRecentResearchArtifacts(state, 5)
		.map((artifact) => `- ${artifact.id} [${artifact.provider}] ${artifact.summary || artifact.query || artifact.target || "No summary."}`)
		.join("\n") || "- none";
	const unresolvedQuality = getUnresolvedQualityObjectives(state);
	const researchBlockers = getUnresolvedResearchBlockers(state)
		.map((item) => `- ${item.title} (${item.id})`)
		.join("\n") || "- none";

	return `AUTODEVELOP LOOP ACTIVE

Goal file: ${state.goal?.path ?? "unknown"}
Goal hash: ${state.goal?.hash ?? "unknown"}
Repo root: ${state.repoRoot || "unknown"}
Branch: ${state.branch || "unknown"}
Mode: ${state.mode}
Phase: ${state.phase}
Cycle: ${state.cycleNumber}
Iteration: ${state.iteration}
Current item: ${state.currentItemId || "none"}
Last cycle commit: ${state.lastCycleCommitSha || "none"}
Last cycle summary: ${state.lastCycleSummary || "none"}
Last cycle noop: ${state.lastCycleNoop ? "yes" : "no"}
Cycle launch state: ${state.cycleLaunchState || "unknown"}
Launch queued at: ${state.launchQueuedAt || "none"}
Launch acknowledged at: ${state.launchAcknowledgedAt || "none"}
Relaunch requested: ${state.relaunchRequested ? "yes" : "no"}
Compaction requested: ${state.compactionRequested ? "yes" : "no"}
Recovery count: ${Number.isFinite(state.recoveryCount) ? state.recoveryCount : 0}
Next cycle retry: ${state.nextCycleAt || "none"}

Recent AutoDevelop commits:
${recentCommits}

Recent research artifacts:
${recentResearch}

Research blockers:
${researchBlockers}

Unresolved quality objectives:
${unresolvedQuality.length ? unresolvedQuality.join(", ") : "none"}

Backlog:
${backlogLines}

Rules:
- Call autodevelop_state with action="get" before replacing the plan or claiming completion.
- Keep backlog kinds to research, code, or test.
- Use autodevelop_research as the default research interface for repo and web research.
- If code or test work hits uncertainty, missing evidence, or unclear behavior, call autodevelop_state with action="flag_uncertainty" immediately.
- Use update_item to move tasks through pending, in_progress, done, or blocked.
- A task may be marked done directly once acceptance criteria and required evidence are satisfied.
- Call autodevelop_state with action="complete" only when no pending or in-progress items remain, at least one item is done, and you can provide a non-empty completion summary.
- Completing the cycle will create a git commit, preserve a local cycle summary, and relaunch the same goal in the same session.
- Runtime-only paths under .pi/autodevelop and .autodevelop must never be committed.
- Inspect large-data and high-load behavior for chunking, batching, streaming, pagination, memory pressure, queue depth, retries, timeouts, idempotency, and backpressure unless explicitly opted out.`;
}
