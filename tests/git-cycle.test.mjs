import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	assertCommitEligibility,
	createCycleCommit,
	getCommitEligibleChanges,
	getRecentAutoDevelopCommits,
	isRuntimeLocalPath,
	resolveGitCycleContext,
	stageCommitEligibleChanges,
} from "../extensions/autodevelop/lib/git-cycle.js";

function runGit(cwd, args) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

function normalizePath(path) {
	return path.replace(/^\/private/, "");
}

async function createRepo() {
	const repoDir = await mkdtemp(join(tmpdir(), "autodevelop-git-cycle-"));
	await mkdir(join(repoDir, "src"), { recursive: true });
	await mkdir(join(repoDir, ".pi", "autodevelop"), { recursive: true });
	await writeFile(join(repoDir, "src", "app.js"), "export const value = 1;\n", "utf8");
	await writeFile(join(repoDir, ".pi", "autodevelop", "goal.md"), "# Goal\n\nShip it.\n", "utf8");
	runGit(repoDir, ["init"]);
	runGit(repoDir, ["config", "user.email", "autodevelop@example.com"]);
	runGit(repoDir, ["config", "user.name", "AutoDevelop"]);
	runGit(repoDir, ["add", "src/app.js"]);
	runGit(repoDir, ["commit", "-m", "initial"]);
	return repoDir;
}

test("runtime-local paths are recognized and excluded from commit eligibility", async () => {
	const repoDir = await createRepo();
	await writeFile(join(repoDir, "src", "app.js"), "export const value = 2;\n", "utf8");
	await writeFile(join(repoDir, ".pi", "autodevelop", "loop-state.json"), "{}\n", "utf8");

	assert.equal(isRuntimeLocalPath(".pi/autodevelop/loop-state.json"), true);
	assert.equal(isRuntimeLocalPath(".autodevelop/runtime/report.json"), true);
	assert.equal(isRuntimeLocalPath("src/app.js"), false);

	const changes = getCommitEligibleChanges(repoDir);
	assert.deepEqual(changes.map((change) => change.path), ["src/app.js"]);
});

test("assertCommitEligibility rejects dirty non-runtime changes", async () => {
	const repoDir = await createRepo();
	await writeFile(join(repoDir, "src", "app.js"), "export const value = 3;\n", "utf8");

	assert.throws(() => assertCommitEligibility(repoDir), /uncommitted non-runtime changes/);
});

test("stageCommitEligibleChanges excludes runtime-local files and creates deterministic commits", async () => {
	const repoDir = await createRepo();
	await writeFile(join(repoDir, "src", "app.js"), "export const value = 4;\n", "utf8");
	await writeFile(join(repoDir, ".pi", "autodevelop", "history.md"), "runtime\n", "utf8");

	const gitContext = resolveGitCycleContext(repoDir);
	assert.equal(normalizePath(gitContext.repoRoot), normalizePath(repoDir));

	const staged = stageCommitEligibleChanges(repoDir);
	assert.deepEqual(staged.changedFiles, ["src/app.js"]);
	assert.match(staged.diffStat, /src\/app\.js/);

	const commit = createCycleCommit(repoDir, 2, "Tighten the bounded refresh path");
	assert.match(commit.message, /^autodevelop: cycle 2 - Tighten the bounded refresh path$/);

	const files = runGit(repoDir, ["show", "--name-only", "--format=", "HEAD"]).split(/\r?\n/).filter(Boolean);
	assert.deepEqual(files, ["src/app.js"]);
});

test("getRecentAutoDevelopCommits returns recent cycle history from git", async () => {
	const repoDir = await createRepo();

	await writeFile(join(repoDir, "src", "app.js"), "export const value = 5;\n", "utf8");
	stageCommitEligibleChanges(repoDir);
	createCycleCommit(repoDir, 1, "First cycle");

	await writeFile(join(repoDir, "src", "app.js"), "export const value = 6;\n", "utf8");
	stageCommitEligibleChanges(repoDir);
	createCycleCommit(repoDir, 2, "Second cycle");

	const commits = getRecentAutoDevelopCommits(repoDir, 5);
	assert.equal(commits.length, 2);
	assert.match(commits[0].subject, /^autodevelop: cycle 2 - Second cycle$/);
	assert.match(commits[1].subject, /^autodevelop: cycle 1 - First cycle$/);
});
