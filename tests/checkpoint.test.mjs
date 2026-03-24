import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getLoopStateCheckpointPath, readLoopStateCheckpoint, writeLoopStateCheckpoint } from "../extensions/autodevelop/lib/checkpoint.js";
import { createInitialLoopState } from "../extensions/autodevelop/lib/state-machine.js";

function makeGoal(repoDir) {
	return {
		path: join(repoDir, ".pi", "autodevelop", "goal.md"),
		hash: "goal-hash",
		text: "# Goal\n\nShip it.\n",
		sections: { Goal: "Ship it." },
		presentSections: ["Goal"],
		hasStructuredSections: true,
		explicitOptOuts: [],
	};
}

function runGit(cwd, args) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

test("getLoopStateCheckpointPath prefers state repo root", () => {
	const state = createInitialLoopState(makeGoal("/tmp/workspace"), undefined, {
		repoRoot: "/tmp/workspace",
		branch: "main",
	});

	assert.equal(getLoopStateCheckpointPath({ cwd: "/tmp/other", state }), "/tmp/workspace/.pi/autodevelop/loop-state.json");
});

test("writeLoopStateCheckpoint and readLoopStateCheckpoint round-trip state through the workspace checkpoint", async () => {
	const repoDir = await mkdtemp(join(tmpdir(), "autodevelop-checkpoint-"));
	const state = createInitialLoopState(makeGoal(repoDir), undefined, {
		repoRoot: repoDir,
		branch: "main",
	});

	state.phase = "implementing";
	state.iteration = 6;
	state.backlog = [
		{
			id: "code-1",
			title: "Implement loop",
			kind: "code",
			status: "in_progress",
			notes: "",
			acceptanceCriteria: "Command works",
			objectiveRefs: [],
			researchRequired: false,
			evidenceRefs: [],
			dependsOnResearchItemIds: [],
		},
	];
	state.currentItemId = "code-1";

	const path = await writeLoopStateCheckpoint(state);
	const markdown = await readFile(join(repoDir, ".pi", "autodevelop", "loop-state.md"), "utf8");
	const restored = await readLoopStateCheckpoint(repoDir);

	assert.equal(path, join(repoDir, ".pi", "autodevelop", "loop-state.json"));
	assert.match(markdown, /## AutoDevelop/);
	assert.match(markdown, /Phase: `implementing`/);
	assert.equal(restored.goal.path, state.goal.path);
	assert.equal(restored.phase, "implementing");
	assert.equal(restored.iteration, 6);
	assert.equal(restored.currentItemId, "code-1");
	assert.equal(restored.repoRoot, repoDir);
});

test("readLoopStateCheckpoint returns null when no checkpoint exists", async () => {
	const repoDir = await mkdtemp(join(tmpdir(), "autodevelop-checkpoint-empty-"));
	const restored = await readLoopStateCheckpoint(repoDir);
	assert.equal(restored, null);
});

test("readLoopStateCheckpoint resolves the repo root when started from a subdirectory", async () => {
	const repoDir = await mkdtemp(join(tmpdir(), "autodevelop-checkpoint-subdir-"));
	runGit(repoDir, ["init"]);
	const subdir = join(repoDir, "src");
	await mkdir(subdir, { recursive: true });

	const state = createInitialLoopState(makeGoal(repoDir), undefined, {
		repoRoot: repoDir,
		branch: "main",
	});
	state.phase = "testing";
	state.iteration = 3;

	await writeLoopStateCheckpoint(state);
	const restored = await readLoopStateCheckpoint(subdir);

	assert.equal(restored.goal.path, state.goal.path);
	assert.equal(restored.phase, "planning");
	assert.equal(restored.iteration, 3);
	assert.equal(restored.repoRoot, repoDir);
});
