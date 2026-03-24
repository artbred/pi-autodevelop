import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveWorkspacePaths } from "../extensions/autodevelop/lib/workspace.js";

function normalizePath(path) {
	return path.replace(/^\/private/, "");
}

function runGit(cwd, args) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

test("resolveWorkspacePaths prefers the repo root carried in state", () => {
	const paths = resolveWorkspacePaths({
		cwd: "/tmp/other",
		state: {
			repoRoot: "/tmp/project",
		},
	});

	assert.equal(paths.workspaceRoot, "/tmp/project");
	assert.equal(paths.autodevelopRoot, "/tmp/project/.pi/autodevelop");
	assert.equal(paths.source, "state_repo_root");
});

test("resolveWorkspacePaths uses the git repo root for subdirectory sessions", async () => {
	const repoDir = await mkdtemp(join(tmpdir(), "autodevelop-workspace-git-"));
	const subdir = join(repoDir, "src", "feature");
	runGit(repoDir, ["init"]);
	await mkdir(subdir, { recursive: true });

	const paths = resolveWorkspacePaths({ cwd: subdir });

	assert.equal(normalizePath(paths.workspaceRoot), normalizePath(repoDir));
	assert.equal(normalizePath(paths.autodevelopRoot), normalizePath(join(repoDir, ".pi", "autodevelop")));
	assert.equal(paths.source, "git");
});

test("resolveWorkspacePaths falls back to the goal file directory outside git", () => {
	const paths = resolveWorkspacePaths({
		state: {
			goal: {
				path: "/tmp/project/.pi/autodevelop/goal.md",
			},
		},
	});

	assert.equal(paths.workspaceRoot, "/tmp/project/.pi/autodevelop");
	assert.equal(paths.autodevelopRoot, "/tmp/project/.pi/autodevelop");
	assert.equal(paths.source, "goal_path");
});
