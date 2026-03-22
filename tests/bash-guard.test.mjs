import test from "node:test";
import assert from "node:assert/strict";

import { isGoalMutationCommand } from "../extensions/autodevelop/lib/bash-guard.js";

const goalPath = "/tmp/project/goal.md";

test("allows read-only commands against the goal file", () => {
	assert.equal(isGoalMutationCommand("cat goal.md", goalPath), false);
	assert.equal(isGoalMutationCommand("rg TODO ./goal.md", goalPath), false);
	assert.equal(isGoalMutationCommand("sed -n '1,20p' goal.md", goalPath), false);
});

test("blocks redirection and tee writes to the goal file", () => {
	assert.equal(isGoalMutationCommand("echo hello > goal.md", goalPath), true);
	assert.equal(isGoalMutationCommand("printf hi >> './goal.md'", goalPath), true);
	assert.equal(isGoalMutationCommand("tee -a /tmp/project/goal.md", goalPath), true);
});

test("blocks representative mutating shell commands that reference the goal file", () => {
	assert.equal(isGoalMutationCommand("sed -i '' 's/old/new/' goal.md", goalPath), true);
	assert.equal(isGoalMutationCommand("mv goal.md goal.bak", goalPath), true);
	assert.equal(isGoalMutationCommand("cp other.md goal.md", goalPath), true);
	assert.equal(isGoalMutationCommand("chmod 644 /tmp/project/goal.md", goalPath), true);
	assert.equal(isGoalMutationCommand("rm other.md", goalPath), false);
});
