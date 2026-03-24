import test from "node:test";
import assert from "node:assert/strict";

import {
	applyStateAction,
	allEnabledQualityObjectivesResolved,
	buildLoopContext,
	createDefaultQualityObjectives,
	createDefaultResearchProviders,
	createInitialLoopState,
	formatLoopStateMarkdown,
	getUnresolvedQualityObjectives,
	migrateLoopState,
	nextRunnablePhase,
	reconstructStateFromEntries,
} from "../extensions/autodevelop/lib/state-machine.js";

function makeGoal() {
	return {
		path: "/tmp/project/goal.md",
		hash: "abc123",
		text: "# Goal\n\nShip it.\n",
		sections: { Goal: "Ship it." },
		presentSections: ["Goal"],
		hasStructuredSections: true,
		explicitOptOuts: [],
		readonlyProtection: true,
	};
}

test("replace_plan normalizes backlog items and keeps loop in delivery mode by default", () => {
	const initial = createInitialLoopState(makeGoal());
	const next = applyStateAction(initial, "replace_plan", {
		items: [
			{ title: "Inspect repo", kind: "research", objectiveRefs: ["reliability"], evidenceRefs: ["artifact-1"] },
			{ title: "Implement loop", kind: "code", acceptanceCriteria: "Core command works", objectiveRefs: ["scalability"] },
		],
	});

	assert.equal(next.backlog.length, 2);
	assert.ok(next.backlog[0].id.startsWith("item-1-"));
	assert.equal(next.backlog[1].acceptanceCriteria, "Core command works");
	assert.deepEqual(next.backlog[0].objectiveRefs, ["reliability"]);
	assert.deepEqual(next.backlog[0].evidenceRefs, ["artifact-1"]);
	assert.equal(next.mode, "delivery");
	assert.equal(next.phase, "researching");
});

test("update_item drives the current item and phase", () => {
	const initial = applyStateAction(createInitialLoopState(makeGoal()), "replace_plan", {
		items: [{ id: "research-1", title: "Inspect repo", kind: "research", evidenceRefs: ["artifact-1"], verificationStatus: "passed" }],
	});

	const active = applyStateAction(initial, "update_item", {
		itemId: "research-1",
		patch: { status: "in_progress", notes: "Reading files" },
	});
	assert.equal(active.currentItemId, "research-1");
	assert.equal(active.phase, "researching");

	const done = applyStateAction(active, "update_item", {
		itemId: "research-1",
		patch: { status: "done" },
	});
	assert.equal(done.currentItemId, null);
});

test("block and complete record stop reasons and switch delivery into hardening", () => {
	const blocked = applyStateAction(createInitialLoopState(makeGoal()), "block", {
		reason: "Missing API key",
	});
	assert.equal(blocked.phase, "blocked");
	assert.equal(blocked.stopReason, "Missing API key");

	const completed = applyStateAction(createInitialLoopState(makeGoal()), "complete", {
		summary: "All checks passed",
	});
	assert.equal(completed.mode, "hardening");
	assert.equal(completed.phase, "planning");
	assert.equal(completed.goalSatisfied, true);
	assert.equal(completed.lastVerificationSummary, "All checks passed");
	assert.equal(completed.stopReason, "");
});

test("update_objective tracks evidence and promotes hardening to improvement when resolved", () => {
	let state = applyStateAction(createInitialLoopState(makeGoal()), "complete", {
		summary: "Primary goal satisfied",
	});

	for (const objective of getUnresolvedQualityObjectives(state)) {
		state = applyStateAction(state, "update_objective", {
			objective,
			status: "addressed",
			evidence: `Handled ${objective}`,
		});
	}

	assert.equal(allEnabledQualityObjectivesResolved(state), true);
	assert.equal(state.mode, "improvement");
	assert.equal(state.qualityObjectives.reliability.evidence, "Handled reliability");
});

test("reconstructs the latest loop state from mixed session entries", () => {
	const stateFromCommand = applyStateAction(createInitialLoopState(makeGoal()), "replace_plan", {
		items: [{ id: "code-1", title: "Implement loop", kind: "code", status: "pending" }],
	});
	const stateFromTool = applyStateAction(stateFromCommand, "update_item", {
		itemId: "code-1",
		patch: { status: "in_progress" },
	});

	const reconstructed = reconstructStateFromEntries([
		{
			type: "custom",
			customType: "autodevelop-control",
			data: { state: stateFromCommand },
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "autodevelop_state",
				details: stateFromTool,
			},
		},
	]);

	assert.equal(reconstructed.currentItemId, "code-1");
	assert.equal(reconstructed.phase, "implementing");
});

test("migrates legacy improving state into v4 improvement mode", () => {
	const migrated = migrateLoopState({
		version: 1,
		goal: makeGoal(),
		phase: "improving",
		goalSatisfied: true,
		backlog: [],
		iteration: 3,
		currentItemId: null,
		lastVerificationSummary: "",
		lastFailure: "",
		stopReason: "",
		completionSummary: "done",
	});

	assert.equal(migrated.version, 4);
	assert.equal(migrated.mode, "improvement");
	assert.equal(migrated.phase, "planning");
	assert.equal(migrated.qualityObjectives.scalability.status, "pending");
	assert.equal(migrated.researchProviders.local.healthy, true);
	assert.equal(migrated.verifierBackend.resolved, "inline");
});

test("legacy goalSatisfied state without mode migrates into hardening", () => {
	const migrated = migrateLoopState({
		version: 1,
		goal: makeGoal(),
		phase: "planning",
		goalSatisfied: true,
		backlog: [],
		iteration: 1,
		currentItemId: null,
	});

	assert.equal(migrated.mode, "hardening");
});

test("migrateLoopState preserves a healthy pi_cli verifier backend without inventing degradation", () => {
	const migrated = migrateLoopState({
		version: 4,
		goal: makeGoal(),
		mode: "delivery",
		phase: "planning",
		goalSatisfied: false,
		backlog: [],
		iteration: 1,
		currentItemId: null,
		verifierBackend: {
			configured: "auto",
			resolved: "pi_cli",
			available: true,
			degradedReason: null,
			repoRoot: "/tmp/project",
			isGitRepo: true,
		},
	});

	assert.equal(migrated.verifierBackend.resolved, "pi_cli");
	assert.equal(migrated.verifierBackend.degradedReason, "");
});

test("builds loop context and computes the next runnable phase", () => {
	const initial = applyStateAction(createInitialLoopState(makeGoal()), "replace_plan", {
		items: [{ id: "verify-1", title: "Verify behavior", kind: "verify", status: "pending", objectiveRefs: ["reliability"] }],
	});
	assert.equal(nextRunnablePhase(initial), "verifying");

	const context = buildLoopContext(initial);
	assert.match(context, /AUTODEVELOP LOOP ACTIVE/);
	assert.match(context, /Goal file: \/tmp\/project\/goal.md/);
	assert.match(context, /Mode: delivery/);
	assert.match(context, /\[pending\] \[verify\] Verify behavior/);
	assert.match(context, /chunking, batching, streaming/);
	assert.match(context, /autodevelop_research/);
});

test("createInitialLoopState enables all quality objectives unless explicitly opted out", () => {
	const initial = createInitialLoopState({
		...makeGoal(),
		explicitOptOuts: ["latency"],
	});

	assert.equal(initial.mode, "delivery");
	assert.equal(initial.qualityObjectives.latency.enabled, false);
	assert.equal(initial.qualityObjectives.latency.status, "opted_out");
	assert.equal(initial.qualityObjectives.reliability.status, "pending");
	assert.equal(initial.researchProviders.local.healthy, true);
	assert.equal(initial.verifierBackend.resolved, "inline");
});

test("createDefaultQualityObjectives marks opt-outs precisely", () => {
	const objectives = createDefaultQualityObjectives(["latency", "memory"]);
	assert.equal(objectives.latency.status, "opted_out");
	assert.equal(objectives.memory.enabled, false);
	assert.equal(objectives.performance.status, "pending");
});

test("flag_uncertainty pauses current work and inserts linked research", () => {
	let state = applyStateAction(createInitialLoopState(makeGoal()), "replace_plan", {
		items: [{ id: "code-1", title: "Implement loop", kind: "code", status: "in_progress", objectiveRefs: ["reliability"] }],
	});

	state = applyStateAction(state, "flag_uncertainty", {
		itemId: "code-1",
		reason: "Need to verify throughput assumptions",
		question: "What batching model is safe for large inputs?",
		scope: "auto",
		objectiveRefs: ["throughput"],
	});

	assert.equal(state.phase, "researching");
	assert.equal(state.currentItemId.startsWith("research-"), true);
	assert.equal(state.backlog[0].kind, "research");
	assert.equal(state.backlog[1].researchRequired, true);
	assert.deepEqual(state.backlog[1].dependsOnResearchItemIds, [state.backlog[0].id]);
	assert.deepEqual(state.backlog[1].objectiveRefs.sort(), ["reliability", "throughput"].sort());
});

test("research items cannot complete without evidence refs", () => {
	const initial = applyStateAction(createInitialLoopState(makeGoal()), "replace_plan", {
		items: [{ id: "research-1", title: "Inspect repo", kind: "research", status: "in_progress" }],
	});

	assert.throws(
		() =>
			applyStateAction(initial, "update_item", {
				itemId: "research-1",
				patch: { status: "done" },
			}),
		/evidenceRef/,
	);
});

test("research-blocked implementation items require evidence refs before completion", () => {
	const initial = applyStateAction(createInitialLoopState(makeGoal()), "replace_plan", {
		items: [
			{
				id: "research-1",
				title: "Inspect repo",
				kind: "research",
				status: "done",
				evidenceRefs: ["artifact-1"],
				verificationStatus: "passed",
				verificationReportId: "report-1",
			},
			{
				id: "code-1",
				title: "Implement loop",
				kind: "code",
				status: "in_progress",
				researchRequired: true,
				dependsOnResearchItemIds: ["research-1"],
			},
		],
	});

	assert.throws(
		() =>
			applyStateAction(initial, "update_item", {
				itemId: "code-1",
				patch: { status: "done" },
			}),
		/evidence/,
	);

	const done = applyStateAction(initial, "update_item", {
		itemId: "code-1",
		patch: { evidenceRefs: ["artifact-1"], status: "in_progress" },
	});
	const verified = {
		...done,
		backlog: done.backlog.map((item) => (item.id === "code-1" ? { ...item, verificationStatus: "passed" } : item)),
	};
	const completed = applyStateAction(verified, "update_item", {
		itemId: "code-1",
		patch: { status: "done" },
	});
	assert.equal(completed.backlog[1].status, "done");
});

test("request_verification moves an item into reviewing and requires acceptance criteria", () => {
	const initial = applyStateAction(createInitialLoopState(makeGoal()), "replace_plan", {
		items: [{ id: "code-1", title: "Implement loop", kind: "code", status: "in_progress", acceptanceCriteria: "Command works" }],
	});

	const reviewing = applyStateAction(initial, "request_verification", {
		itemId: "code-1",
		requestId: "verify-1",
	});

	assert.equal(reviewing.phase, "reviewing");
	assert.equal(reviewing.pendingVerificationItemId, "code-1");
	assert.equal(reviewing.backlog[0].verificationStatus, "running");
	assert.equal(reviewing.backlog[0].verificationRequestId, "verify-1");

	const missingCriteria = applyStateAction(createInitialLoopState(makeGoal()), "replace_plan", {
		items: [{ id: "code-2", title: "No criteria yet", kind: "code", status: "in_progress" }],
	});
	assert.throws(
		() =>
			applyStateAction(missingCriteria, "request_verification", {
				itemId: "code-2",
				requestId: "verify-2",
			}),
		/acceptanceCriteria/,
	);
});

test("direct completion is rejected until verifier passes", () => {
	const initial = applyStateAction(createInitialLoopState(makeGoal()), "replace_plan", {
		items: [{ id: "code-1", title: "Implement loop", kind: "code", status: "in_progress", acceptanceCriteria: "Command works" }],
	});

	assert.throws(
		() =>
			applyStateAction(initial, "update_item", {
				itemId: "code-1",
				patch: { status: "done" },
			}),
		/request_verification/,
	);
});

test("apply_verification_report marks pass_with_notes done and preserves notes", () => {
	let state = applyStateAction(createInitialLoopState(makeGoal()), "replace_plan", {
		items: [{ id: "code-1", title: "Implement loop", kind: "code", status: "in_progress", acceptanceCriteria: "Command works" }],
	});

	state = applyStateAction(state, "request_verification", { itemId: "code-1", requestId: "verify-1" });
	state = applyStateAction(state, "record_verification_request", {
		request: {
			id: "verify-1",
			itemId: "code-1",
			itemKind: "code",
			itemTitle: "Implement loop",
			item: {
				id: "code-1",
				kind: "code",
				title: "Implement loop",
				status: "in_progress",
				notes: "",
				acceptanceCriteria: "Command works",
				objectiveRefs: [],
				evidenceRefs: [],
				dependsOnResearchItemIds: [],
			},
			fingerprint: "fp-1",
		},
	});
	state = applyStateAction(state, "apply_verification_report", {
		report: {
			id: "report-1",
			requestId: "verify-1",
			requestFingerprint: "fp-1",
			status: "pass_with_notes",
			summary: "Looks good",
			findings: ["Add one more edge-case test later."],
			missingEvidence: [],
			recommendedNextSteps: ["Track the extra test as follow-up work."],
		},
	});

	assert.equal(state.backlog[0].status, "done");
	assert.equal(state.backlog[0].verificationStatus, "pass_with_notes");
	assert.match(state.backlog[0].notes, /Add one more edge-case test later/);
	assert.equal(state.pendingVerificationItemId, null);
});

test("failed verification reopens the item and inserts research when evidence is missing", () => {
	let state = applyStateAction(createInitialLoopState(makeGoal()), "replace_plan", {
		items: [
			{
				id: "code-1",
				title: "Implement loop",
				kind: "code",
				status: "in_progress",
				acceptanceCriteria: "Command works for large datasets",
				objectiveRefs: ["reliability"],
			},
		],
	});

	state = applyStateAction(state, "request_verification", { itemId: "code-1", requestId: "verify-1" });
	state = applyStateAction(state, "record_verification_request", {
		request: {
			id: "verify-1",
			itemId: "code-1",
			itemKind: "code",
			itemTitle: "Implement loop",
			item: {
				id: "code-1",
				kind: "code",
				title: "Implement loop",
				status: "in_progress",
				notes: "",
				acceptanceCriteria: "Command works for large datasets",
				objectiveRefs: ["reliability"],
				evidenceRefs: [],
				dependsOnResearchItemIds: [],
			},
			fingerprint: "fp-1",
		},
	});
	state = applyStateAction(state, "apply_verification_report", {
		report: {
			id: "report-1",
			requestId: "verify-1",
			requestFingerprint: "fp-1",
			status: "fail",
			summary: "Large-input evidence is missing.",
			findings: ["The implementation may still assume a small working set."],
			missingEvidence: ["Show bounded memory or chunked processing on large inputs."],
			recommendedNextSteps: ["Research and implement chunked processing if needed."],
		},
	});

	assert.equal(state.phase, "researching");
	assert.equal(state.currentItemId.startsWith("research-"), true);
	assert.equal(state.backlog[1].id, "code-1");
	assert.equal(state.backlog[1].researchRequired, true);
	assert.equal(state.backlog[1].verificationStatus, "failed");
	assert.match(state.backlog[1].notes, /Large-input evidence is missing/);
});

test("record_research_artifact attaches evidence to the active research item", () => {
	const initial = applyStateAction(createInitialLoopState(makeGoal()), "replace_plan", {
		items: [{ id: "research-1", title: "Inspect repo", kind: "research", status: "in_progress" }],
	});
	const current = applyStateAction(initial, "set_phase", { phase: "researching", currentItemId: "research-1" });
	const next = applyStateAction(current, "record_research_artifact", {
		artifact: {
			id: "artifact-1",
			scope: "repo",
			provider: "local",
			summary: "Found the code path",
			sources: [],
		},
	});

	assert.equal(next.researchArtifacts.length, 1);
	assert.deepEqual(next.backlog[0].evidenceRefs, ["artifact-1"]);
});

test("reconstructs research artifacts from autodevelop_research tool details", () => {
	const state = createInitialLoopState(makeGoal(), createDefaultResearchProviders());
	const reconstructed = reconstructStateFromEntries([
		{
			type: "custom",
			customType: "autodevelop-control",
			data: { state },
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "autodevelop_research",
				details: {
					artifact: {
						id: "artifact-1",
						scope: "repo",
						provider: "local",
						summary: "Captured local evidence",
						sources: [{ kind: "file", location: "/tmp/project/file.js", snippet: "match" }],
					},
				},
			},
		},
	]);

	assert.equal(reconstructed.researchArtifacts.length, 1);
	assert.equal(reconstructed.researchArtifacts[0].id, "artifact-1");
});

test("formatLoopStateMarkdown surfaces research providers and blockers", () => {
	const state = applyStateAction(
		applyStateAction(createInitialLoopState(makeGoal()), "replace_plan", {
			items: [{ id: "code-1", title: "Implement loop", kind: "code", status: "in_progress" }],
		}),
		"flag_uncertainty",
		{
			itemId: "code-1",
			reason: "Need external confirmation",
			scope: "web",
		},
	);

	const markdown = formatLoopStateMarkdown(state);
	assert.match(markdown, /Research Providers/);
	assert.match(markdown, /Research Blockers/);
	assert.match(markdown, /research-required/);
});
