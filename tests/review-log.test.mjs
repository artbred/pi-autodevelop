import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { persistCycleSummary, persistResearchArtifactReview } from "../extensions/autodevelop/lib/review-log.js";
import { createInitialLoopState } from "../extensions/autodevelop/lib/state-machine.js";

function makeState(repoDir) {
	return createInitialLoopState(
		{
			path: join(repoDir, ".pi", "autodevelop", "goal.md"),
			hash: "goal-hash",
			text: "# Goal\n\nShip it.\n",
			sections: { Goal: "Ship it." },
			presentSections: ["Goal"],
			hasStructuredSections: true,
			explicitOptOuts: [],
		},
		undefined,
		{
			repoRoot: repoDir,
			branch: "main",
		},
	);
}

test("persistResearchArtifactReview writes artifact markdown and history entry", async () => {
	const repoDir = await mkdtemp(join(tmpdir(), "autodevelop-review-log-"));
	const state = makeState(repoDir);

	const artifactPath = await persistResearchArtifactReview({
		artifact: {
			id: "research-1",
			createdAt: "2026-03-24T12:00:00.000Z",
			action: "query",
			scope: "repo",
			provider: "local",
			query: "bounded refresh design",
			target: "",
			summary: "Chunk aggregation can stay inside ClickHouse.",
			content: "Use aggregate states and bounded helper cleanup.",
			sources: [{ location: "/tmp/src.sql", title: "src.sql", line: 12 }],
			objectiveRefs: ["memory", "throughput"],
		},
		cwd: repoDir,
		state,
		itemTitle: "Research chunked refresh",
	});

	const artifactMarkdown = await readFile(artifactPath, "utf8");
	const historyMarkdown = await readFile(join(repoDir, ".pi", "autodevelop", "history.md"), "utf8");

	assert.match(artifactMarkdown, /# Research Artifact/);
	assert.match(artifactMarkdown, /Related item: Research chunked refresh/);
	assert.match(artifactMarkdown, /Chunk aggregation can stay inside ClickHouse/);
	assert.match(historyMarkdown, /## Research research-1/);
	assert.match(historyMarkdown, /File: /);
});

test("persistCycleSummary writes a per-cycle file and readable history entry", async () => {
	const repoDir = await mkdtemp(join(tmpdir(), "autodevelop-review-log-cycle-"));
	const state = makeState(repoDir);

	const cyclePath = await persistCycleSummary({
		cycleNumber: 3,
		branch: "main",
		completionSummary: "Completed the first bounded refresh cycle.",
		commitSha: "abc123def456",
		diffStat: " src/index.js | 12 ++++++++++--",
		changedFiles: ["src/index.js"],
		blockers: ["Need broader production validation"],
		noop: false,
		cwd: repoDir,
		state,
	});

	const cycleMarkdown = await readFile(cyclePath, "utf8");
	const historyMarkdown = await readFile(join(repoDir, ".pi", "autodevelop", "history.md"), "utf8");
	assert.match(cycleMarkdown, /# Cycle 3/);
	assert.match(cycleMarkdown, /Commit: abc123def456/);
	assert.match(cycleMarkdown, /Need broader production validation/);
	assert.match(historyMarkdown, /## Cycle 3/);
	assert.match(historyMarkdown, /Completed the first bounded refresh cycle/);
});

test("persistResearchArtifactReview resolves the repo root when cwd is a subdirectory", async () => {
	const repoDir = await mkdtemp(join(tmpdir(), "autodevelop-review-log-subdir-"));
	const state = makeState(repoDir);
	const subdir = join(repoDir, "nested", "work");
	await mkdir(subdir, { recursive: true });

	await persistResearchArtifactReview({
		artifact: {
			id: "research-subdir",
			createdAt: "2026-03-24T12:20:00.000Z",
			action: "query",
			scope: "repo",
			provider: "local",
			query: "lease recovery",
			summary: "Recovered through repo root lookup.",
			content: "Checkpoint, review-log, and lease now share the same workspace resolver.",
			sources: [],
			objectiveRefs: ["reliability"],
		},
		cwd: subdir,
		state,
		itemTitle: "Review workspace resolution",
	});

	const historyMarkdown = await readFile(join(repoDir, ".pi", "autodevelop", "history.md"), "utf8");
	assert.match(historyMarkdown, /research-subdir/);
	assert.match(historyMarkdown, /Review workspace resolution/);
});
