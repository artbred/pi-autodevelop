import test from "node:test";
import assert from "node:assert/strict";

import {
	applyStateAction,
	allEnabledQualityObjectivesResolved,
	buildLoopContext,
	createDefaultQualityObjectives,
	createInitialLoopState,
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
			{ title: "Inspect repo", kind: "research", objectiveRefs: ["reliability"] },
			{ title: "Implement loop", kind: "code", acceptanceCriteria: "Core command works", objectiveRefs: ["scalability"] },
		],
	});

	assert.equal(next.backlog.length, 2);
	assert.ok(next.backlog[0].id.startsWith("item-1-"));
	assert.equal(next.backlog[1].acceptanceCriteria, "Core command works");
	assert.deepEqual(next.backlog[0].objectiveRefs, ["reliability"]);
	assert.equal(next.mode, "delivery");
	assert.equal(next.phase, "researching");
});

test("update_item drives the current item and phase", () => {
	const initial = applyStateAction(createInitialLoopState(makeGoal()), "replace_plan", {
		items: [{ id: "research-1", title: "Inspect repo", kind: "research" }],
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

test("migrates legacy improving state into v2 improvement mode", () => {
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

	assert.equal(migrated.version, 2);
	assert.equal(migrated.mode, "improvement");
	assert.equal(migrated.phase, "planning");
	assert.equal(migrated.qualityObjectives.scalability.status, "pending");
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
});

test("createDefaultQualityObjectives marks opt-outs precisely", () => {
	const objectives = createDefaultQualityObjectives(["latency", "memory"]);
	assert.equal(objectives.latency.status, "opted_out");
	assert.equal(objectives.memory.enabled, false);
	assert.equal(objectives.performance.status, "pending");
});
