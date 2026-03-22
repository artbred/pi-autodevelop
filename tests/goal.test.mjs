import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createGoalScaffoldContent,
	parseGoalDocument,
	readGoalSnapshot,
	scaffoldGoalFile,
	sha256Text,
	verifyGoalSnapshot,
} from "../extensions/autodevelop/lib/goal.js";

test("parses structured goal headings when present", () => {
	const content = `# Goal

Ship the extension.

# Success Criteria

- Tests pass

# Constraints

- Goal file is immutable
`;
	const parsed = parseGoalDocument(content);
	assert.equal(parsed.hasStructuredSections, true);
	assert.equal(parsed.sections.Goal, "Ship the extension.");
	assert.match(parsed.sections["Success Criteria"], /Tests pass/);
	assert.match(parsed.sections.Constraints, /immutable/);
});

test("treats plain markdown as unstructured but hashable goal content", () => {
	const content = "Build the extension without changing this file.\n";
	const parsed = parseGoalDocument(content);
	assert.equal(parsed.hasStructuredSections, false);
	assert.equal(sha256Text(content).length, 64);
});

test("snapshots and verifies goal file contents", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "autodevelop-goal-"));
	const goalPath = join(tempDir, "goal.md");
	await writeFile(goalPath, "# Goal\n\nBuild something real.\n", "utf8");

	const snapshot = await readGoalSnapshot(tempDir, "./goal.md");
	assert.equal(snapshot.path, await realpath(goalPath));
	assert.equal(snapshot.hash.length, 64);

	const unchanged = await verifyGoalSnapshot(snapshot);
	assert.equal(unchanged.ok, true);

	await writeFile(goalPath, "# Goal\n\nChanged outside the loop.\n", "utf8");
	const changed = await verifyGoalSnapshot(snapshot);
	assert.equal(changed.ok, false);
	assert.notEqual(changed.currentHash, snapshot.hash);
});

test("scaffold creates the expected goal template", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "autodevelop-scaffold-"));
	const createdPath = await scaffoldGoalFile(tempDir, "docs/goal.md");
	const contents = await readFile(createdPath, "utf8");

	assert.equal(contents, createGoalScaffoldContent());
	assert.match(contents, /^# Goal/m);
	assert.match(contents, /^# Success Criteria/m);
	assert.match(contents, /^# Constraints/m);
});
