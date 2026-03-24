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
	isLoopRunning,
	migrateLoopState,
	nextRunnablePhase,
	reconstructStateFromEntries,
} from "../extensions/autodevelop/lib/state-machine.js";

function makeGoal() {
	return {
		path: "/tmp/project/.pi/autodevelop/goal.md",
		hash: "abc123",
		text: "# Goal\n\nShip it.\n",
		sections: { Goal: "Ship it." },
		presentSections: ["Goal"],
		hasStructuredSections: true,
		explicitOptOuts: [],
		readonlyProtection: true,
	};
}

test("replace_plan normalizes backlog items and keeps the first runnable item current", () => {
	const initial = createInitialLoopState(makeGoal(), undefined, { repoRoot: "/tmp/project", branch: "main" });
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
	assert.equal(next.mode, "cycle");
	assert.equal(next.phase, "researching");
	assert.equal(next.currentItemId, next.backlog[0].id);
});

test("replace_plan clears dangling currentItemId and points at the first runnable item", () => {
	const initial = {
		...createInitialLoopState(makeGoal()),
		currentItemId: "stale-item",
	};

	const next = applyStateAction(initial, "replace_plan", {
		items: [{ id: "code-1", title: "Implement loop", kind: "code", status: "pending" }],
	});

	assert.equal(next.currentItemId, "code-1");
	assert.equal(next.phase, "implementing");
});

test("update_item allows direct completion once evidence requirements are satisfied", () => {
	const initial = applyStateAction(createInitialLoopState(makeGoal()), "replace_plan", {
		items: [{ id: "research-1", title: "Inspect repo", kind: "research", evidenceRefs: ["artifact-1"] }],
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
	assert.equal(done.phase, "planning");
});

test("block only stops the active item when other backlog work remains", () => {
	const initial = applyStateAction(createInitialLoopState(makeGoal()), "replace_plan", {
		items: [
			{
				id: "test-1",
				title: "Validate bounded resource behavior",
				kind: "test",
				status: "in_progress",
				acceptanceCriteria: "Tests pass under representative load",
			},
			{
				id: "research-1",
				title: "Investigate CPU headroom",
				kind: "research",
				status: "pending",
			},
		],
	});

	const next = applyStateAction(initial, "block", {
		reason: "Representative live-load CPU environment is unavailable.",
	});

	assert.equal(next.backlog[0].status, "blocked");
	assert.match(next.backlog[0].notes, /Representative live-load CPU environment is unavailable/);
	assert.equal(next.phase, "researching");
	assert.equal(next.stopReason, "");
	assert.equal(next.lastFailure, "Representative live-load CPU environment is unavailable.");
	assert.equal(isLoopRunning(next), true);
});

test("flag_uncertainty inserts a linked research item", () => {
	const initial = applyStateAction(createInitialLoopState(makeGoal()), "replace_plan", {
		items: [{ id: "code-1", title: "Implement loop", kind: "code", status: "in_progress", objectiveRefs: ["reliability"] }],
	});

	const next = applyStateAction(initial, "flag_uncertainty", {
		itemId: "code-1",
		reason: "Need evidence for batching behavior.",
		question: "Research batching behavior",
		objectiveRefs: ["reliability"],
	});

	assert.equal(next.backlog[0].status, "blocked");
	assert.equal(next.backlog[1].kind, "research");
	assert.equal(next.phase, "researching");
	assert.equal(next.currentItemId, next.backlog[1].id);
});

test("complete requires a closed backlog and a non-empty summary", () => {
	const initial = applyStateAction(createInitialLoopState(makeGoal()), "replace_plan", {
		items: [{ id: "code-1", title: "Implement loop", kind: "code", status: "pending" }],
	});

	assert.throws(
		() => applyStateAction(initial, "complete", { summary: "done" }),
		/pending or in-progress/,
	);

	const done = applyStateAction(initial, "update_item", {
		itemId: "code-1",
		patch: { status: "done" },
	});
	const completed = applyStateAction(done, "complete", { summary: "Cycle is ready to commit" });
	assert.equal(completed.phase, "committing");
	assert.equal(completed.goalSatisfied, true);
	assert.equal(completed.completionSummary, "Cycle is ready to commit");
});

test("update_objective tracks evidence and resolves all enabled quality objectives", () => {
	let state = createInitialLoopState(makeGoal());

	for (const objective of getUnresolvedQualityObjectives(state)) {
		state = applyStateAction(state, "update_objective", {
			objective,
			status: "addressed",
			evidence: `Handled ${objective}`,
		});
	}

	assert.equal(allEnabledQualityObjectivesResolved(state), true);
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

test("migrateLoopState tolerates legacy verifier-backed state and verify items", () => {
	const migrated = migrateLoopState({
		version: 4,
		goal: makeGoal(),
		mode: "delivery",
		phase: "reviewing",
		goalSatisfied: true,
		backlog: [
			{
				id: "verify-1",
				title: "Verify behavior",
				kind: "verify",
				status: "in_progress",
				verificationStatus: "running",
				objectiveRefs: ["reliability"],
			},
		],
		iteration: 3,
		currentItemId: "verify-1",
		verifierBackend: {
			repoRoot: "/tmp/project",
		},
	});

	assert.equal(migrated.version, 5);
	assert.equal(migrated.mode, "cycle");
	assert.equal(migrated.repoRoot, "/tmp/project");
	assert.equal(migrated.backlog[0].kind, "test");
	assert.equal(migrated.backlog[0].status, "pending");
	assert.equal(migrated.phase, "testing");
});

test("builds loop context and markdown for the git cycle flow", () => {
	const initial = applyStateAction(
		createInitialLoopState(makeGoal(), undefined, {
			repoRoot: "/tmp/project",
			branch: "main",
			recentCycleCommits: [{ sha: "1234567890abcdef", shortSha: "1234567890ab", subject: "autodevelop: cycle 1 - Seed", committedAt: "2026-03-25T00:00:00.000Z" }],
		}),
		"replace_plan",
		{
			items: [{ id: "test-1", title: "Validate behavior", kind: "test", status: "pending", objectiveRefs: ["reliability"] }],
		},
	);
	assert.equal(nextRunnablePhase(initial), "testing");

	const context = buildLoopContext(initial);
	const markdown = formatLoopStateMarkdown(initial);
	assert.match(context, /AUTODEVELOP LOOP ACTIVE/);
	assert.match(context, /Branch: main/);
	assert.match(context, /complete" only when no pending or in-progress items remain/i);
	assert.match(markdown, /## AutoDevelop/);
	assert.match(markdown, /Cycle: `1`/);
	assert.match(markdown, /\[pending\] \[test\] Validate behavior/);
});

test("createInitialLoopState enables all quality objectives unless explicitly opted out", () => {
	const initial = createInitialLoopState({
		...makeGoal(),
		explicitOptOuts: ["latency"],
	});

	assert.equal(initial.qualityObjectives.latency.enabled, false);
	assert.equal(initial.qualityObjectives.latency.status, "opted_out");
	assert.equal(initial.qualityObjectives.reliability.enabled, true);
	assert.equal(initial.researchProviders.local.healthy, true);
	assert.deepEqual(createDefaultResearchProviders().local.healthy, true);
	assert.equal(createDefaultQualityObjectives(["latency"]).latency.status, "opted_out");
});
