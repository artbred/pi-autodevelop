import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createVerificationRequest,
	isVerificationReportStale,
	parseVerificationResultText,
	resolveVerifierBackend,
	runVerifierWithFallback,
} from "../extensions/autodevelop/lib/verifier.js";

function normalizePathForAssert(path) {
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

async function createGitRepo() {
	const repoDir = await mkdtemp(join(tmpdir(), "autodevelop-verifier-"));
	await writeFile(join(repoDir, "README.md"), "# Repo\n", "utf8");
	runGit(repoDir, ["init"]);
	runGit(repoDir, ["config", "user.email", "autodevelop@example.com"]);
	runGit(repoDir, ["config", "user.name", "AutoDevelop"]);
	runGit(repoDir, ["add", "README.md"]);
	runGit(repoDir, ["commit", "-m", "init"]);
	return repoDir;
}

function makeState(repoDir) {
	return {
		goal: {
			path: join(repoDir, "goal.md"),
			hash: "goal-hash",
			text: "# Goal\n\nShip it.\n",
			sections: { Goal: "Ship it." },
			presentSections: ["Goal"],
			explicitOptOuts: [],
		},
		backlog: [
			{
				id: "code-1",
				title: "Implement loop",
				kind: "code",
				status: "in_progress",
				notes: "Work in progress",
				acceptanceCriteria: "Command works for large inputs",
				objectiveRefs: ["reliability"],
				evidenceRefs: ["artifact-1"],
				dependsOnResearchItemIds: [],
			},
		],
		researchArtifacts: [
			{
				id: "artifact-1",
				provider: "local",
				summary: "Chunking keeps memory bounded",
				query: "chunking",
				target: "",
				sources: [{ location: join(repoDir, "README.md"), title: "README" }],
			},
		],
		lastVerificationSummary: "Previous review passed",
		lastFailure: "",
	};
}

test("resolveVerifierBackend degrades to inline when pi is unavailable", async () => {
	const repoDir = await createGitRepo();
	const backend = resolveVerifierBackend({ cwd: repoDir, piCliAvailable: false });

	assert.equal(backend.resolved, "inline");
	assert.equal(backend.available, true);
	assert.equal(backend.isGitRepo, true);
	assert.match(backend.degradedReason, /pi/);
});

test("resolveVerifierBackend chooses pi_cli when pi is available in a git repo", async () => {
	const repoDir = await createGitRepo();
	const backend = resolveVerifierBackend({ cwd: repoDir, piCliAvailable: true });

	assert.equal(backend.resolved, "pi_cli");
	assert.equal(backend.degradedReason, null);
	assert.equal(normalizePathForAssert(backend.repoRoot), normalizePathForAssert(repoDir));
});

test("createVerificationRequest captures linked research and git snapshot", async () => {
	const repoDir = await createGitRepo();
	await writeFile(join(repoDir, "src.js"), "export const ok = true;\n", "utf8");

	const request = await createVerificationRequest({
		cwd: repoDir,
		state: makeState(repoDir),
		itemId: "code-1",
		backend: resolveVerifierBackend({ cwd: repoDir, piCliAvailable: false }),
		requestId: "verify-1",
	});

	assert.equal(request.id, "verify-1");
	assert.equal(request.itemId, "code-1");
	assert.equal(request.linkedResearchArtifacts.length, 1);
	assert.equal(request.repoSnapshot.isGitRepo, true);
	assert.equal(normalizePathForAssert(request.repoSnapshot.repoRoot), normalizePathForAssert(repoDir));
	assert.ok(request.fingerprint);
});

test("parseVerificationResultText extracts structured verifier JSON", () => {
	const request = { id: "verify-1", fingerprint: "fp-1" };
	const report = parseVerificationResultText(
		`VERIFICATION_RESULT_START
{"status":"pass_with_notes","summary":"Looks good","findings":["Minor note"],"missingEvidence":[],"recommendedNextSteps":["Watch this path"]}
VERIFICATION_RESULT_END`,
		request,
	);

	assert.equal(report.requestId, "verify-1");
	assert.equal(report.status, "pass_with_notes");
	assert.deepEqual(report.findings, ["Minor note"]);
});

test("isVerificationReportStale detects when the item contract changed", async () => {
	const repoDir = await createGitRepo();
	const backend = resolveVerifierBackend({ cwd: repoDir, piCliAvailable: false });
	const state = makeState(repoDir);
	const request = await createVerificationRequest({
		cwd: repoDir,
		state,
		itemId: "code-1",
		backend,
		requestId: "verify-1",
	});

	assert.equal(isVerificationReportStale(request, state), false);

	const mutated = {
		...state,
		backlog: state.backlog.map((item) =>
			item.id === "code-1" ? { ...item, acceptanceCriteria: "Command works for huge inputs with bounded memory" } : item,
		),
	};
	assert.equal(isVerificationReportStale(request, mutated), true);
});

test("runVerifierWithFallback degrades to inline review when pi_cli fails", async () => {
	const request = {
		id: "verify-1",
		fingerprint: "fp-1",
		itemTitle: "Validate pipeline correctness",
	};
	const backend = {
		configured: "auto",
		resolved: "pi_cli",
		available: true,
		degradedReason: null,
		repoRoot: "/tmp/repo",
		isGitRepo: true,
	};

	const result = await runVerifierWithFallback({
		request,
		backend,
		paths: {
			sessionsDir: "/tmp/sessions",
			worktreesDir: "/tmp/worktrees",
		},
		model: "gpt-test",
		apiKey: "test-key",
		completeFn: async () => ({ content: [] }),
		runPiCliVerifierFn: async () => {
			throw new Error("Verifier backend crashed");
		},
		runInlineVerifierFn: async () => ({
			id: "report-verify-1",
			requestId: "verify-1",
			requestFingerprint: "fp-1",
			createdAt: new Date().toISOString(),
			status: "pass",
			summary: "Inline review passed",
			findings: [],
			missingEvidence: [],
			recommendedNextSteps: [],
			rawText: "",
		}),
	});

	assert.equal(result.report.status, "pass");
	assert.equal(result.fallbackUsed, true);
	assert.equal(result.backend.resolved, "inline");
	assert.match(result.backend.degradedReason, /Verifier backend crashed/);
	assert.match(result.report.summary, /inline fallback/i);
	assert.match(result.report.findings[0], /pi_cli verifier failed/i);
});
