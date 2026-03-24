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
	RESEARCH_PROVIDER_NAMES,
	RESEARCH_SCOPES,
	RESOLVED_QUALITY_OBJECTIVE_STATUSES,
	VERIFICATION_STATUSES,
	VERIFIER_BACKENDS,
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

function assertValidResearchScope(scope) {
	if (!RESEARCH_SCOPES.includes(scope)) {
		throw new Error(`Invalid research scope: ${scope}`);
	}
}

function assertValidVerificationStatus(status) {
	if (!VERIFICATION_STATUSES.includes(status)) {
		throw new Error(`Invalid verification status: ${status}`);
	}
}

function assertValidVerifierBackend(backend) {
	if (!VERIFIER_BACKENDS.includes(backend)) {
		throw new Error(`Invalid verifier backend: ${backend}`);
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

function uniqueTrimmed(values) {
	return [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))];
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
			description: raw.description?.trim?.() ?? defaults[name].description,
			lastError: raw.lastError?.trim?.() ?? "",
			lastCheckedAt: raw.lastCheckedAt?.trim?.() ?? "",
		};
	}

	return normalized;
}

export function createDefaultVerifierBackend() {
	return {
		configured: "auto",
		resolved: "inline",
		available: true,
		degradedReason: "Verifier backend has not been probed yet. Using inline verifier mode by default.",
		repoRoot: null,
		isGitRepo: false,
	};
}

function normalizeVerifierBackend(rawBackend) {
	const defaults = createDefaultVerifierBackend();
	const degradedReason =
		rawBackend && Object.prototype.hasOwnProperty.call(rawBackend, "degradedReason")
			? rawBackend.degradedReason?.trim?.() ?? ""
			: defaults.degradedReason;
	const normalized = {
		configured: rawBackend?.configured?.trim?.() || defaults.configured,
		resolved: rawBackend?.resolved?.trim?.() || defaults.resolved,
		available: Boolean(rawBackend?.available ?? defaults.available),
		degradedReason,
		repoRoot: rawBackend?.repoRoot?.trim?.() ?? defaults.repoRoot,
		isGitRepo: Boolean(rawBackend?.isGitRepo ?? defaults.isGitRepo),
	};

	assertValidVerifierBackend(normalized.resolved);
	return normalized;
}

function normalizeResearchArtifact(artifact, index = 0) {
	if (!artifact) return null;

	const scope = artifact.scope ?? "auto";
	assertValidResearchScope(scope);

	return {
		id: artifact.id?.trim() || `research-artifact-${index + 1}`,
		createdAt: artifact.createdAt?.trim?.() ?? "",
		action: artifact.action?.trim?.() || "query",
		scope,
		provider: artifact.provider?.trim?.() || "local",
		query: artifact.query?.trim?.() ?? "",
		target: artifact.target?.trim?.() ?? "",
		summary: artifact.summary?.trim?.() ?? "",
		content: artifact.content?.trim?.() ?? "",
		sources: Array.isArray(artifact.sources)
			? artifact.sources.map((source) => ({
					kind: source.kind?.trim?.() || "url",
					location: source.location?.trim?.() ?? "",
					title: source.title?.trim?.() ?? "",
					snippet: source.snippet?.trim?.() ?? "",
					line: Number.isFinite(source.line) ? source.line : undefined,
				}))
			: [],
		objectiveRefs: normalizeObjectiveRefs(artifact.objectiveRefs),
	};
}

function normalizeResearchArtifacts(artifacts) {
	return (artifacts ?? []).map((artifact, index) => normalizeResearchArtifact(artifact, index)).filter(Boolean);
}

function normalizeVerificationRequest(request, index = 0) {
	if (!request) return null;

	return {
		id: request.id?.trim() || `verify-request-${index + 1}`,
		createdAt: request.createdAt?.trim?.() ?? "",
		itemId: request.itemId?.trim?.() ?? "",
		itemKind: request.itemKind?.trim?.() ?? "",
		itemTitle: request.itemTitle?.trim?.() ?? "",
		goal: clone(request.goal ?? {}),
		item: {
			id: request.item?.id?.trim?.() ?? request.itemId?.trim?.() ?? "",
			kind: request.item?.kind?.trim?.() ?? request.itemKind?.trim?.() ?? "",
			title: request.item?.title?.trim?.() ?? request.itemTitle?.trim?.() ?? "",
			status: request.item?.status?.trim?.() ?? "",
			notes: request.item?.notes?.trim?.() ?? "",
			acceptanceCriteria: request.item?.acceptanceCriteria?.trim?.() ?? "",
			objectiveRefs: normalizeObjectiveRefs(request.item?.objectiveRefs),
			evidenceRefs: normalizeEvidenceRefs(request.item?.evidenceRefs),
			dependsOnResearchItemIds: normalizeResearchDependencies(request.item?.dependsOnResearchItemIds),
		},
		linkedResearchArtifacts: normalizeResearchArtifacts(request.linkedResearchArtifacts),
		repoSnapshot: clone(request.repoSnapshot ?? {}),
		lastVerificationSummary: request.lastVerificationSummary?.trim?.() ?? "",
		lastFailure: request.lastFailure?.trim?.() ?? "",
		fingerprint: request.fingerprint?.trim?.() ?? "",
		instructions: request.instructions?.trim?.() ?? "",
	};
}

function normalizeVerificationRequests(requests) {
	return (requests ?? []).map((request, index) => normalizeVerificationRequest(request, index)).filter(Boolean);
}

function normalizeVerificationReport(report, index = 0) {
	if (!report) return null;

	const status = report.status?.trim?.() ?? "fail";
	if (!["pass", "pass_with_notes", "fail"].includes(status)) {
		throw new Error(`Invalid verification report status: ${status}`);
	}

	return {
		id: report.id?.trim() || `verify-report-${index + 1}`,
		requestId: report.requestId?.trim?.() ?? "",
		requestFingerprint: report.requestFingerprint?.trim?.() ?? "",
		createdAt: report.createdAt?.trim?.() ?? "",
		status,
		summary: report.summary?.trim?.() ?? "",
		findings: uniqueTrimmed(report.findings),
		missingEvidence: uniqueTrimmed(report.missingEvidence),
		recommendedNextSteps: uniqueTrimmed(report.recommendedNextSteps),
		rawText: report.rawText?.trim?.() ?? "",
	};
}

function normalizeVerificationReports(reports) {
	return (reports ?? []).map((report, index) => normalizeVerificationReport(report, index)).filter(Boolean);
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
	if (state?.pendingVerificationItemId) return "reviewing";

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

	if (nextState.phase === "reviewing" && !nextState.pendingVerificationItemId) {
		nextState.phase = derivePhaseFromState(nextState);
	} else if (!LOOP_PHASES.includes(nextState.phase)) {
		nextState.phase = derivePhaseFromState(nextState);
	}

	return nextState;
}

export function createInitialLoopState(
	goalSnapshot,
	researchProviders = createDefaultResearchProviders(),
	verifierBackend = createDefaultVerifierBackend(),
) {
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
		researchArtifacts: [],
		researchProviders: normalizeResearchProviders(researchProviders),
		verifierBackend: normalizeVerifierBackend(verifierBackend),
		verificationRequests: [],
		verificationReports: [],
		pendingVerificationItemId: null,
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
			researchRequired: Boolean(item.researchRequired),
			evidenceRefs: normalizeEvidenceRefs(item.evidenceRefs),
			dependsOnResearchItemIds: normalizeResearchDependencies(item.dependsOnResearchItemIds),
			verificationRequired: true,
			verificationStatus: item.verificationStatus?.trim?.() ?? "pending",
			verificationRequestId: item.verificationRequestId?.trim?.() ?? "",
			verificationReportId: item.verificationReportId?.trim?.() ?? "",
		};
	});
}

function normalizeBacklogItemVerification(item) {
	assertValidVerificationStatus(item.verificationStatus);
	return item;
}

function findBacklogItem(state, itemId) {
	const item = state.backlog.find((candidate) => candidate.id === itemId);
	if (!item) {
		throw new Error(`Backlog item not found: ${itemId}`);
	}
	return item;
}

function hasPendingResearchDependencies(state, item) {
	return item.dependsOnResearchItemIds.some((dependencyId) => {
		const dependency = state.backlog.find((candidate) => candidate.id === dependencyId);
		return dependency && dependency.status !== "done";
	});
}

function validateCompletionRequirements(state, item) {
	if (item.kind === "research" && item.evidenceRefs.length === 0) {
		throw new Error(`Research item "${item.title}" requires at least one evidenceRef before it can be marked done.`);
	}

	if (item.kind !== "research" && item.researchRequired && item.evidenceRefs.length === 0) {
		throw new Error(`Item "${item.title}" requires linked research evidence before it can be marked done.`);
	}

	if (hasPendingResearchDependencies(state, item)) {
		throw new Error(`Item "${item.title}" still depends on unfinished research.`);
	}

	if (item.verificationRequired && !["passed", "pass_with_notes"].includes(item.verificationStatus)) {
		throw new Error(`Item "${item.title}" requires request_verification and a passing verifier result before it can be marked done.`);
	}
}

function validateVerificationRequirements(state, item) {
	if (!item.acceptanceCriteria?.trim()) {
		throw new Error(`Item "${item.title}" requires acceptanceCriteria before verification can be requested.`);
	}

	if (item.kind === "research" && item.evidenceRefs.length === 0) {
		throw new Error(`Research item "${item.title}" requires evidenceRefs before verification can be requested.`);
	}

	if (item.kind !== "research" && item.researchRequired && item.evidenceRefs.length === 0) {
		throw new Error(`Item "${item.title}" requires linked research evidence before verification can be requested.`);
	}

	if (hasPendingResearchDependencies(state, item)) {
		throw new Error(`Item "${item.title}" still depends on unfinished research and cannot be verified yet.`);
	}
}

function appendUniqueText(base, extra) {
	const next = extra?.trim();
	if (!next) return base?.trim?.() ?? "";
	if (!base?.trim()) return next;
	return base.includes(next) ? base.trim() : `${base.trim()}\n${next}`;
}

function ensureCurrentResearchItemUsesArtifact(state, artifactId) {
	if (!state.currentItemId) return;
	const item = state.backlog.find((candidate) => candidate.id === state.currentItemId);
	if (!item) return;
	if (item.kind !== "research" && !item.researchRequired) return;
	if (!item.evidenceRefs.includes(artifactId)) {
		item.evidenceRefs.push(artifactId);
	}
}

function buildVerifierNotes(report) {
	const lines = [];
	if (report.summary) lines.push(`Verifier summary: ${report.summary}`);
	if (report.findings?.length) lines.push(`Verifier findings:\n- ${report.findings.join("\n- ")}`);
	if (report.missingEvidence?.length) lines.push(`Missing evidence:\n- ${report.missingEvidence.join("\n- ")}`);
	if (report.recommendedNextSteps?.length) lines.push(`Recommended next steps:\n- ${report.recommendedNextSteps.join("\n- ")}`);
	return lines.join("\n");
}

function insertResearchItemForReason(nextState, item, args = {}) {
	const scope = args.scope ?? "auto";
	assertValidResearchScope(scope);

	item.status = "pending";
	item.researchRequired = true;
	item.objectiveRefs = normalizeObjectiveRefs([...(item.objectiveRefs ?? []), ...(args.objectiveRefs ?? [])]);
	item.notes = appendUniqueText(item.notes, `Blocked on research: ${args.reason?.trim() || args.question?.trim() || "Unclear implementation detail."}`);

	const researchTitle = args.question?.trim() || args.reason?.trim() || `Research needed for ${item.title}`;
	const researchId = `research-${slugify(researchTitle, "follow-up")}-${nextState.backlog.length + 1}`;
	const researchItem = normalizeBacklogItems([
		{
			id: researchId,
			title: `Research: ${researchTitle}`,
			kind: "research",
			status: "in_progress",
			notes: [args.reason?.trim(), args.question?.trim(), `Scope: ${scope}`].filter(Boolean).join("\n"),
			acceptanceCriteria: `Capture evidenceRefs that unblock "${item.title}".`,
			objectiveRefs: normalizeObjectiveRefs([...(args.objectiveRefs ?? []), ...(item.objectiveRefs ?? [])]),
			researchRequired: false,
			evidenceRefs: [],
			dependsOnResearchItemIds: [],
		},
	])[0];

	if (!item.dependsOnResearchItemIds.includes(researchId)) {
		item.dependsOnResearchItemIds.push(researchId);
	}

	const targetIndex = nextState.backlog.findIndex((candidate) => candidate.id === item.id);
	nextState.backlog.splice(targetIndex >= 0 ? targetIndex : nextState.backlog.length, 0, researchItem);
	nextState.currentItemId = researchId;
	nextState.phase = "researching";
	nextState.lastFailure = args.reason?.trim?.() ?? "";
	nextState.stopReason = "";
	return researchItem;
}

function verificationStatusFromReport(reportStatus) {
	switch (reportStatus) {
		case "pass":
			return "passed";
		case "pass_with_notes":
			return "pass_with_notes";
		case "fail":
		default:
			return "failed";
	}
}

export function getUnresolvedResearchBlockers(state) {
	if (!state?.backlog) return [];

	return state.backlog.filter((item) => {
		if (item.kind === "research") {
			return item.status !== "done";
		}

		return item.researchRequired && (item.evidenceRefs.length === 0 || hasPendingResearchDependencies(state, item));
	});
}

export function getRecentResearchArtifacts(state, limit = 5) {
	if (!state?.researchArtifacts?.length) return [];
	return state.researchArtifacts.slice(-limit).reverse();
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
			nextState.backlog = normalizeBacklogItems(params.items ?? []).map(normalizeBacklogItemVerification);
			const inProgressItem = nextState.backlog.find((item) => item.status === "in_progress");
			nextState.currentItemId = inProgressItem?.id ?? nextState.currentItemId ?? null;
			nextState.pendingVerificationItemId = null;
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

			if (patch.title !== undefined) item.title = patch.title.trim();
			if (patch.notes !== undefined) item.notes = patch.notes.trim();
			if (patch.acceptanceCriteria !== undefined) item.acceptanceCriteria = patch.acceptanceCriteria.trim();
			if (patch.objectiveRefs !== undefined) item.objectiveRefs = normalizeObjectiveRefs(patch.objectiveRefs);
			if (patch.researchRequired !== undefined) item.researchRequired = Boolean(patch.researchRequired);
			if (patch.evidenceRefs !== undefined) item.evidenceRefs = normalizeEvidenceRefs(patch.evidenceRefs);
			if (patch.dependsOnResearchItemIds !== undefined) {
				item.dependsOnResearchItemIds = normalizeResearchDependencies(patch.dependsOnResearchItemIds);
			}

			if (patch.status !== undefined) {
				assertValidStatus(patch.status);
				if (patch.status === "done") {
					validateCompletionRequirements(nextState, item);
				}
				item.status = patch.status;
			}

			if (item.status === "in_progress") {
				nextState.currentItemId = item.id;
				nextState.phase = phaseFromKind(item.kind);
			}

			if ((item.status === "done" || item.status === "blocked") && nextState.currentItemId === item.id) {
				nextState.currentItemId = null;
				if (nextState.pendingVerificationItemId === item.id) {
					nextState.pendingVerificationItemId = null;
				}
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

		case "request_verification": {
			if (!params.itemId) {
				throw new Error("itemId is required for request_verification");
			}

			if (nextState.pendingVerificationItemId && nextState.pendingVerificationItemId !== params.itemId) {
				throw new Error(`Another item is already pending verification: ${nextState.pendingVerificationItemId}`);
			}

			const item = findBacklogItem(nextState, params.itemId);
			validateVerificationRequirements(nextState, item);

			if (item.status === "pending") {
				item.status = "in_progress";
			}

			item.verificationStatus = "running";
			item.verificationRequestId = params.requestId?.trim?.() ?? item.verificationRequestId ?? "";
			item.verificationReportId = "";
			nextState.pendingVerificationItemId = item.id;
			nextState.currentItemId = item.id;
			nextState.phase = "reviewing";
			nextState.stopReason = "";
			return normalizeModeAndPhase(nextState);
		}

		case "record_verification_request": {
			const request = normalizeVerificationRequest(params.request, nextState.verificationRequests.length);
			if (!request) {
				throw new Error("request is required for record_verification_request");
			}

			const item = findBacklogItem(nextState, request.itemId);
			const existingIndex = nextState.verificationRequests.findIndex((candidate) => candidate.id === request.id);
			if (existingIndex >= 0) {
				nextState.verificationRequests[existingIndex] = request;
			} else {
				nextState.verificationRequests.push(request);
			}

			item.verificationStatus = "running";
			item.verificationRequestId = request.id;
			item.verificationReportId = "";
			nextState.pendingVerificationItemId = item.id;
			nextState.currentItemId = item.id;
			nextState.phase = "reviewing";
			return normalizeModeAndPhase(nextState);
		}

		case "discard_verification_request": {
			if (!params.requestId) {
				throw new Error("requestId is required for discard_verification_request");
			}

			const request = nextState.verificationRequests.find((candidate) => candidate.id === params.requestId);
			if (!request) {
				throw new Error(`Verification request not found: ${params.requestId}`);
			}

			const item = findBacklogItem(nextState, request.itemId);
			item.verificationStatus = "pending";
			item.notes = appendUniqueText(
				item.notes,
				params.reason?.trim?.() || `Discarded stale verifier result for request ${params.requestId}.`,
			);
			nextState.pendingVerificationItemId = null;
			nextState.currentItemId = item.id;
			nextState.phase = phaseFromKind(item.kind);
			return normalizeModeAndPhase(nextState);
		}

		case "apply_verification_report": {
			const report = normalizeVerificationReport(params.report, nextState.verificationReports.length);
			if (!report) {
				throw new Error("report is required for apply_verification_report");
			}

			const request = nextState.verificationRequests.find((candidate) => candidate.id === report.requestId);
			if (!request) {
				throw new Error(`Verification request not found for report: ${report.requestId}`);
			}

			const item = findBacklogItem(nextState, request.itemId);
			const existingIndex = nextState.verificationReports.findIndex((candidate) => candidate.id === report.id);
			if (existingIndex >= 0) {
				nextState.verificationReports[existingIndex] = report;
			} else {
				nextState.verificationReports.push(report);
			}

			const verifierNotes = buildVerifierNotes(report);
			item.verificationStatus = verificationStatusFromReport(report.status);
			item.verificationReportId = report.id;
			nextState.pendingVerificationItemId = null;
			nextState.lastVerificationSummary = report.summary || nextState.lastVerificationSummary;

			if (report.status === "pass" || report.status === "pass_with_notes") {
				if (verifierNotes) {
					item.notes = appendUniqueText(item.notes, verifierNotes);
				}
				item.status = "done";
				nextState.currentItemId = null;
				nextState.phase = derivePhaseFromState(nextState);
				nextState.lastFailure = "";
				nextState.stopReason = "";
				return normalizeModeAndPhase(nextState);
			}

			item.status = "pending";
			if (verifierNotes) {
				item.notes = appendUniqueText(item.notes, verifierNotes);
			}
			if (report.missingEvidence?.length && item.kind !== "research") {
				insertResearchItemForReason(nextState, item, {
					reason: `Verifier requested missing evidence for "${item.title}".`,
					question: report.missingEvidence.join("; "),
					scope: "auto",
					objectiveRefs: item.objectiveRefs,
				});
			} else {
				nextState.currentItemId = item.id;
				nextState.phase = phaseFromKind(item.kind);
			}
			nextState.lastFailure = report.summary || verifierNotes || "Verification failed.";
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

		case "flag_uncertainty": {
			if (!params.itemId) {
				throw new Error("itemId is required for flag_uncertainty");
			}

			const item = findBacklogItem(nextState, params.itemId);
			if (item.kind === "research") {
				throw new Error("flag_uncertainty cannot target a research item");
			}

			insertResearchItemForReason(nextState, item, {
				reason: params.reason,
				question: params.question,
				scope: params.scope ?? "auto",
				objectiveRefs: params.objectiveRefs,
			});
			return normalizeModeAndPhase(nextState);
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
			ensureCurrentResearchItemUsesArtifact(nextState, artifact.id);
			return normalizeModeAndPhase(nextState);
		}

		case "sync_research_providers": {
			nextState.researchProviders = normalizeResearchProviders(params.providers);
			return normalizeModeAndPhase(nextState);
		}

		case "sync_verifier_backend": {
			nextState.verifierBackend = normalizeVerifierBackend(params.backend);
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
			nextState.pendingVerificationItemId = null;
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
				if (item && item.status !== "blocked" && item.status !== "done") {
					throw new Error(`Current item "${item.title}" must be completed and verifier-approved before calling complete.`);
				}
			}
			nextState.currentItemId = null;
			nextState.pendingVerificationItemId = null;
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
					const evidence = item.evidenceRefs?.length ? ` evidence:${item.evidenceRefs.join(",")}` : "";
					const dependencySuffix = item.dependsOnResearchItemIds?.length
						? ` depends:${item.dependsOnResearchItemIds.join(",")}`
						: "";
					const required = item.researchRequired ? " research-required" : "";
					const verification = item.verificationRequired
						? ` verify:${item.verificationStatus}${item.verificationRequestId ? ` req:${item.verificationRequestId}` : ""}${item.verificationReportId ? ` rep:${item.verificationReportId}` : ""}`
						: " verify:disabled";
					return `- [${item.status}] [${item.kind}] ${item.title} (\`${item.id}\`)${refs}${evidence}${dependencySuffix}${required}${verification}`;
				});

	const objectiveLines = QUALITY_HARDENING_PRIORITY.map((objective) => {
		const current = state.qualityObjectives?.[objective];
		if (!current) return `- ${objective}: missing`;
		const suffix = current.evidence ? ` - ${current.evidence}` : "";
		return `- ${objective}: [${current.status}]${suffix}`;
	});

	const providerLines = RESEARCH_PROVIDER_NAMES.map((provider) => {
		const current = state.researchProviders?.[provider];
		if (!current) return `- ${provider}: missing`;
		const status = current.healthy ? "healthy" : current.configured ? "degraded" : "unconfigured";
		const errorSuffix = current.lastError ? ` - ${current.lastError}` : "";
		return `- ${provider}: [${status}] ${current.description}${errorSuffix}`;
	});

	const recentArtifacts = getRecentResearchArtifacts(state, 3);
	const artifactLines = recentArtifacts.length
		? recentArtifacts.map((artifact) => `- \`${artifact.id}\` [${artifact.provider}] ${artifact.summary || artifact.query || artifact.target}`)
		: ["- No research artifacts yet."];
	const recentReports = state.verificationReports?.slice(-3).reverse() ?? [];
	const reportLines = recentReports.length
		? recentReports.map((report) => `- \`${report.requestId}\` [${report.status}] ${report.summary || "No summary."}`)
		: ["- No verification reports yet."];
	const verifier = state.verifierBackend ?? createDefaultVerifierBackend();
	const verifierStatus = verifier.available
		? verifier.degradedReason
			? `${verifier.resolved} (degraded: ${verifier.degradedReason})`
			: `${verifier.resolved} (healthy)`
		: `${verifier.resolved} (unavailable)`;

	const blockerLines = getUnresolvedResearchBlockers(state).length
		? getUnresolvedResearchBlockers(state).map((item) => `- ${item.title} (\`${item.id}\`)`)
		: ["- None."];

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
		`- Pending verification item: ${state.pendingVerificationItemId ? `\`${state.pendingVerificationItemId}\`` : "none"}`,
		`- Verifier backend: ${verifierStatus}`,
	];

	if (state.completionSummary) lines.push(`- Goal completion summary: ${state.completionSummary}`);
	if (state.lastVerificationSummary) lines.push(`- Last verification: ${state.lastVerificationSummary}`);
	if (state.lastFailure) lines.push(`- Last failure: ${state.lastFailure}`);
	if (state.stopReason) lines.push(`- Stop reason: ${state.stopReason}`);

	lines.push(
		"",
		"### Research Providers",
		"",
		...providerLines,
		"",
		"### Recent Research",
		"",
		...artifactLines,
		"",
		"### Research Blockers",
		"",
		...blockerLines,
		"",
		"### Verification",
		"",
		...reportLines,
		"",
		"### Quality Objectives",
		"",
		...objectiveLines,
		"",
		"### Backlog",
		"",
		...backlogLines,
	);
	return lines.join("\n");
}

function looksLikeLoopState(value) {
	return Boolean(value && value.goal?.path);
}

function looksLikeResearchDetails(value) {
	return Boolean(value && (value.artifact?.id || value.providers));
}

export function migrateLoopState(rawState) {
	if (!rawState) return null;

	const nextState = cloneLoopState(rawState);
	nextState.version = LOOP_STATE_VERSION;
	nextState.goal = normalizeGoalSnapshot(nextState.goal);
	nextState.backlog = normalizeBacklogItems(nextState.backlog ?? []).map(normalizeBacklogItemVerification);
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
	nextState.researchArtifacts = normalizeResearchArtifacts(nextState.researchArtifacts);
	nextState.researchProviders = normalizeResearchProviders(nextState.researchProviders);
	nextState.verifierBackend = normalizeVerifierBackend(nextState.verifierBackend);
	nextState.verificationRequests = normalizeVerificationRequests(nextState.verificationRequests);
	nextState.verificationReports = normalizeVerificationReports(nextState.verificationReports);
	nextState.lastVerificationSummary = nextState.lastVerificationSummary?.trim?.() ?? "";
	nextState.lastFailure = nextState.lastFailure?.trim?.() ?? "";
	nextState.stopReason = nextState.stopReason?.trim?.() ?? "";
	nextState.completionSummary = nextState.completionSummary?.trim?.() ?? "";
	nextState.iteration = Number.isFinite(nextState.iteration) ? nextState.iteration : 0;
	nextState.currentItemId = nextState.currentItemId ?? null;
	nextState.pendingVerificationItemId = nextState.pendingVerificationItemId ?? null;

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

			if (message?.role === "toolResult" && message.toolName === "autodevelop_research" && looksLikeResearchDetails(message.details)) {
				if (looksLikeLoopState(message.details?.loopState)) {
					latestState = migrateLoopState(message.details.loopState);
					continue;
				}
				if (latestState && message.details.providers) {
					latestState = applyStateAction(latestState, "sync_research_providers", { providers: message.details.providers });
				}
				if (latestState && message.details.artifact) {
					latestState = applyStateAction(latestState, "record_research_artifact", { artifact: message.details.artifact });
				}
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
					const evidence = item.evidenceRefs?.length ? ` evidence:${item.evidenceRefs.join(",")}` : "";
					const blockers = item.dependsOnResearchItemIds?.length ? ` depends:${item.dependsOnResearchItemIds.join(",")}` : "";
					const required = item.researchRequired ? " research-required" : "";
					const verification = item.verificationRequired
						? ` verify:${item.verificationStatus}${item.verificationRequestId ? ` req:${item.verificationRequestId}` : ""}${item.verificationReportId ? ` rep:${item.verificationReportId}` : ""}`
						: " verify:disabled";
					return `- [${item.status}] [${item.kind}] ${item.title} (${item.id})${refs}${evidence}${blockers}${required}${verification}${currentSuffix}`;
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

	const providerLines = RESEARCH_PROVIDER_NAMES.map((provider) => {
		const current = state.researchProviders?.[provider];
		if (!current) return `- ${provider}: missing`;
		const status = current.healthy ? "healthy" : current.configured ? "degraded" : "unconfigured";
		const suffix = current.lastError ? ` (${current.lastError})` : "";
		return `- ${provider}: [${status}] ${current.description}${suffix}`;
	});

	const recentArtifactLines = getRecentResearchArtifacts(state, 5).length
		? getRecentResearchArtifacts(state, 5).map((artifact) => {
				const sourceLine = artifact.sources?.[0]?.location ? ` @ ${artifact.sources[0].location}` : "";
				return `- \`${artifact.id}\` [${artifact.provider}] ${artifact.summary || artifact.query || artifact.target}${sourceLine}`;
			})
		: ["- None yet."];
	const verifier = state.verifierBackend ?? createDefaultVerifierBackend();
	const recentReportLines = state.verificationReports?.slice(-3).reverse()?.length
		? state.verificationReports
				.slice(-3)
				.reverse()
				.map((report) => `- \`${report.requestId}\` [${report.status}] ${report.summary || "No summary."}`)
		: ["- None yet."];

	const unresolvedObjectives = getUnresolvedQualityObjectives(state);
	const unresolvedResearch = getUnresolvedResearchBlockers(state);
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

Research provider health:
${providerLines.join("\n")}

Recent research artifacts:
${recentArtifactLines.join("\n")}

Verifier backend:
- configured: ${verifier.configured}
- resolved: ${verifier.resolved}
- available: ${verifier.available ? "yes" : "no"}
- degraded reason: ${verifier.degradedReason || "none"}

Recent verifier reports:
${recentReportLines.join("\n")}

Unresolved research blockers:
${unresolvedResearch.length ? unresolvedResearch.map((item) => `- ${item.title} (${item.id})`).join("\n") : "- none"}

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
- Use autodevelop_research as the default research interface. It always exists even if no external web provider is configured.
- Unless explicitly opted out in the goal file, treat performance, latency, throughput, memory efficiency, scalability, and reliability as default success dimensions.
- If you encounter uncertainty, assumptions, unknown behavior, unclear failures, or missing evidence during code, test, or verify work, immediately call autodevelop_state with action="flag_uncertainty" and continue through a dedicated research item.
- Research items must gather evidenceRefs before they can be completed. Any non-research item marked research-required must cite evidenceRefs before it can be completed.
- Every backlog item is verifier-gated. Never mark an item done directly until you have requested verification and received a passing result.
- Use autodevelop_state with action="request_verification" when an item satisfies its acceptanceCriteria. The verifier is read-only and may reopen the task if evidence is insufficient.
- When backlog is empty in delivery mode, replan while accounting for unresolved quality objectives from the start.
- When backlog is empty in hardening or improvement mode, prioritize unresolved quality objectives in this order: ${QUALITY_HARDENING_PRIORITY.join(", ")}.
- For large-data and high-load systems, inspect chunking, batching, streaming, pagination, memory pressure, queue depth, retries, timeouts, idempotency, and backpressure unless explicitly opted out.
- After hardening objectives are resolved, improvement mode should continue with these directions: ${IMPROVEMENT_DIRECTIONS.join(", ")}.
- External web research should go through autodevelop_research, using the built-in provider chain.`;
}
