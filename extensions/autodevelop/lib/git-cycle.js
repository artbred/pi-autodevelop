import { spawnSync } from "node:child_process";

const RUNTIME_PREFIXES = [".pi/autodevelop/", ".autodevelop/"];

function trimText(value) {
	return typeof value === "string" ? value.trim() : "";
}

function normalizeRelativePath(path) {
	return trimText(path).replace(/\\/g, "/").replace(/^\.\//, "");
}

function runGit(cwd, args) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
	});

	if (result.status !== 0) {
		throw new Error((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim());
	}

	return result.stdout;
}

function runGitAllowFailure(cwd, args) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
	});

	return {
		ok: result.status === 0,
		stdout: trimText(result.stdout),
		stderr: trimText(result.stderr),
		status: result.status,
	};
}

function unique(values) {
	return [...new Set(values)];
}

export function isRuntimeLocalPath(path) {
	const normalized = normalizeRelativePath(path);
	return RUNTIME_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

export function resolveGitCycleContext(cwd) {
	const repoRoot = trimText(runGit(cwd, ["rev-parse", "--show-toplevel"]));
	const branch = trimText(runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]));
	return {
		repoRoot,
		branch,
	};
}

export function listTrackedRuntimePaths(repoRoot) {
	const result = runGitAllowFailure(repoRoot, ["ls-files", "--", ".pi/autodevelop", ".autodevelop"]);
	if (!result.ok || !result.stdout) return [];
	return result.stdout.split(/\r?\n/).map(normalizeRelativePath).filter(Boolean);
}

export function listWorktreeChanges(repoRoot) {
	const output = runGit(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (!output) return [];

	return output.split(/\r?\n/).filter(Boolean).map((line) => {
		const status = line.slice(0, 2);
		const remainder = trimText(line.slice(3));
		const path = normalizeRelativePath(remainder.includes(" -> ") ? remainder.split(" -> ").at(-1) : remainder);
		return {
			x: status[0],
			y: status[1],
			status,
			path,
			raw: line,
			runtimeLocal: isRuntimeLocalPath(path),
			staged: status[0] !== " " && status[0] !== "?",
			unstaged: status[1] !== " ",
		};
	});
}

export function getCommitEligibleChanges(repoRoot) {
	return listWorktreeChanges(repoRoot).filter((change) => !change.runtimeLocal);
}

export function assertCommitEligibility(repoRoot, { allowDirty = false } = {}) {
	const trackedRuntimePaths = listTrackedRuntimePaths(repoRoot);
	if (trackedRuntimePaths.length) {
		throw new Error(
			`Runtime-local paths must not be tracked by git: ${trackedRuntimePaths.join(", ")}.`,
		);
	}

	if (!allowDirty) {
		const changes = getCommitEligibleChanges(repoRoot);
		if (changes.length) {
			throw new Error(
				`Repository has uncommitted non-runtime changes: ${changes.map((change) => change.path).join(", ")}.`,
			);
		}
	}
}

export function stageCommitEligibleChanges(repoRoot) {
	const changes = getCommitEligibleChanges(repoRoot);
	const changedFiles = unique(changes.map((change) => change.path)).filter(Boolean);

	if (!changedFiles.length) {
		return {
			changedFiles: [],
			diffStat: "",
			hasStagedChanges: false,
		};
	}

	runGit(repoRoot, ["add", "-A", "--", ...changedFiles]);

	const stagedRuntime = runGitAllowFailure(repoRoot, ["diff", "--cached", "--name-only", "--", ".pi/autodevelop", ".autodevelop"]);
	if (stagedRuntime.ok && stagedRuntime.stdout) {
		throw new Error(`Runtime-local paths were staged unexpectedly: ${stagedRuntime.stdout.replace(/\r?\n/g, ", ")}.`);
	}

	return {
		changedFiles: unique(runGit(repoRoot, ["diff", "--cached", "--name-only"]).split(/\r?\n/).map(normalizeRelativePath).filter(Boolean)),
		diffStat: trimText(runGit(repoRoot, ["diff", "--cached", "--stat"])),
		hasStagedChanges: Boolean(trimText(runGit(repoRoot, ["diff", "--cached", "--name-only"]))),
	};
}

export function createCycleCommit(repoRoot, cycleNumber, completionSummary) {
	const normalizedSummary = trimText(completionSummary).replace(/\s+/g, " ");
	const shortSummary = normalizedSummary.length > 72 ? `${normalizedSummary.slice(0, 69).trimEnd()}...` : normalizedSummary;
	const message = `autodevelop: cycle ${cycleNumber} - ${shortSummary}`;
	runGit(repoRoot, ["commit", "-m", message, "--no-verify"]);
	return {
		commitSha: trimText(runGit(repoRoot, ["rev-parse", "HEAD"])),
		message,
	};
}

export function getRecentAutoDevelopCommits(repoRoot, limit = 5) {
	const output = runGitAllowFailure(repoRoot, [
		"log",
		`-n`,
		String(limit),
		"--pretty=format:%H%x1f%h%x1f%s%x1f%cI",
		"--grep",
		"^autodevelop: cycle ",
	]);

	if (!output.ok || !output.stdout) return [];

	return output.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
		const [sha, shortSha, subject, committedAt] = line.split("\u001f");
		return {
			sha: trimText(sha),
			shortSha: trimText(shortSha),
			subject: trimText(subject),
			committedAt: trimText(committedAt),
		};
	});
}
