import test from "node:test";
import assert from "node:assert/strict";

import {
	applyStateAction,
	buildLoopContext,
	createInitialLoopState,
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
		readonlyProtection: true,
	};
}

test("replace_plan normalizes backlog items and keeps loop planning by default", () => {
	const initial = createInitialLoopState(makeGoal());
	const next = applyStateAction(initial, "replace_plan", {
		items: [
			{ title: "Inspect repo", kind: "research" },
			{ title: "Implement loop", kind: "code", acceptanceCriteria: "Core command works" },
		],
	});

	assert.equal(next.backlog.length, 2);
	assert.ok(next.backlog[0].id.startsWith("item-1-"));
	assert.equal(next.backlog[1].acceptanceCriteria, "Core command works");
	assert.equal(next.phase, "planning");
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

test("block and complete record stop reasons and summaries", () => {
	const blocked = applyStateAction(createInitialLoopState(makeGoal()), "block", {
		reason: "Missing API key",
	});
	assert.equal(blocked.phase, "blocked");
	assert.equal(blocked.stopReason, "Missing API key");

	const completed = applyStateAction(createInitialLoopState(makeGoal()), "complete", {
		summary: "All checks passed",
	});
	assert.equal(completed.phase, "improving");
	assert.equal(completed.goalSatisfied, true);
	assert.equal(completed.lastVerificationSummary, "All checks passed");
	assert.equal(completed.stopReason, "");
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

test("builds loop context and computes the next runnable phase", () => {
	const initial = applyStateAction(createInitialLoopState(makeGoal()), "replace_plan", {
		items: [{ id: "verify-1", title: "Verify behavior", kind: "verify", status: "pending" }],
	});
	assert.equal(nextRunnablePhase(initial), "verifying");

	const context = buildLoopContext(initial);
	assert.match(context, /AUTODEVELOP LOOP ACTIVE/);
	assert.match(context, /Goal file: \/tmp\/project\/goal.md/);
	assert.match(context, /\[pending\] \[verify\] Verify behavior/);
});

test("nextRunnablePhase stays in improvement mode after the primary goal is satisfied", () => {
	const improving = applyStateAction(createInitialLoopState(makeGoal()), "complete", {
		summary: "Primary goal satisfied",
	});

	assert.equal(nextRunnablePhase(improving), "improving");
	assert.match(buildLoopContext(improving), /Primary goal satisfied: yes/);
});
