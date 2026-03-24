import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

function trimText(value) {
	return typeof value === "string" ? value.trim() : "";
}

function runGitTopLevel(cwd) {
	const baseCwd = trimText(cwd);
	if (!baseCwd) return "";

	const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
		cwd: baseCwd,
		encoding: "utf8",
	});
	if (result.status !== 0) return "";
	return trimText(result.stdout);
}

export function resolveWorkspacePaths({ cwd, state } = {}) {
	const repoRoot = trimText(state?.repoRoot) || trimText(state?.verifierBackend?.repoRoot);
	if (repoRoot) {
		return {
			workspaceRoot: repoRoot,
			autodevelopRoot: join(repoRoot, ".pi", "autodevelop"),
			source: trimText(state?.repoRoot) ? "state_repo_root" : "legacy_verifier_repo_root",
		};
	}

	const gitRoot = runGitTopLevel(cwd);
	if (gitRoot) {
		return {
			workspaceRoot: gitRoot,
			autodevelopRoot: join(gitRoot, ".pi", "autodevelop"),
			source: "git",
		};
	}

	const goalPath = trimText(state?.goal?.path);
	if (goalPath) {
		const autodevelopRoot = dirname(goalPath);
		return {
			workspaceRoot: autodevelopRoot,
			autodevelopRoot,
			source: "goal_path",
		};
	}

	const baseCwd = trimText(cwd);
	if (baseCwd) {
		return {
			workspaceRoot: baseCwd,
			autodevelopRoot: resolve(baseCwd, ".pi", "autodevelop"),
			source: "cwd",
		};
	}

	throw new Error("Cannot determine AutoDevelop workspace paths without a cwd or loop state.");
}

export async function writeFileAtomically(path, content) {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true });
	const tempPath = join(directory, `.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
	await writeFile(tempPath, content, "utf8");
	await rename(tempPath, path);
	return path;
}
