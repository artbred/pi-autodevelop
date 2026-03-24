import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	acquireLoopLease,
	describeLoopLease,
	isLeaseStale,
	readLoopLease,
	refreshLoopLease,
	releaseLoopLease,
} from "../extensions/autodevelop/lib/lease.js";
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

test("lease can be acquired, refreshed by the same owner, and released", async () => {
	const repoDir = await mkdtemp(join(tmpdir(), "autodevelop-lease-own-"));
	const state = makeState(repoDir);

	const acquired = await acquireLoopLease({
		cwd: repoDir,
		state,
		sessionId: "session-a",
		sessionFile: "/tmp/session-a.jsonl",
		now: new Date("2026-03-24T12:00:00.000Z"),
	});
	assert.equal(acquired.ok, true);
	assert.equal(acquired.lease.sessionId, "session-a");

	const refreshed = await refreshLoopLease({
		cwd: repoDir,
		state: { ...state, phase: "implementing" },
		sessionId: "session-a",
		sessionFile: "/tmp/session-a.jsonl",
		now: new Date("2026-03-24T12:00:40.000Z"),
	});
	assert.equal(refreshed.phase, "implementing");
	assert.equal(refreshed.acquiredAt, "2026-03-24T12:00:00.000Z");
	assert.equal(refreshed.heartbeatAt, "2026-03-24T12:00:40.000Z");

	const stored = await readLoopLease({ cwd: repoDir, state });
	assert.equal(stored.sessionId, "session-a");
	assert.equal(stored.phase, "implementing");

	const released = await releaseLoopLease({
		cwd: repoDir,
		state,
		sessionId: "session-a",
	});
	assert.equal(released, true);
	assert.equal(await readLoopLease({ cwd: repoDir, state }), null);
});

test("foreign leases are rejected unless takeover is explicit", async () => {
	const repoDir = await mkdtemp(join(tmpdir(), "autodevelop-lease-foreign-"));
	const state = makeState(repoDir);

	await acquireLoopLease({
		cwd: repoDir,
		state,
		sessionId: "session-a",
		sessionFile: "/tmp/session-a.jsonl",
		now: new Date("2026-03-24T12:00:00.000Z"),
	});

	const rejected = await acquireLoopLease({
		cwd: repoDir,
		state,
		sessionId: "session-b",
		sessionFile: "/tmp/session-b.jsonl",
	});
	assert.equal(rejected.ok, false);
	assert.equal(rejected.lease.sessionId, "session-a");

	const stolen = await acquireLoopLease({
		cwd: repoDir,
		state,
		sessionId: "session-b",
		sessionFile: "/tmp/session-b.jsonl",
		force: true,
		now: new Date("2026-03-24T12:03:00.000Z"),
	});
	assert.equal(stolen.ok, true);
	assert.equal(stolen.stolen, true);
	assert.equal(stolen.lease.sessionId, "session-b");
});

test("lease staleness and descriptions reflect heartbeat age", async () => {
	const repoDir = await mkdtemp(join(tmpdir(), "autodevelop-lease-stale-"));
	const state = makeState(repoDir);

	const acquired = await acquireLoopLease({
		cwd: repoDir,
		state,
		sessionId: "session-a",
		sessionFile: "/tmp/session-a.jsonl",
		now: new Date("2026-03-24T12:00:00.000Z"),
	});

	assert.equal(isLeaseStale(acquired.lease, { now: Date.parse("2026-03-24T12:01:00.000Z") }), false);
	assert.equal(isLeaseStale(acquired.lease, { now: Date.parse("2026-03-24T12:02:30.000Z") }), true);

	const description = describeLoopLease(acquired.lease, {
		currentSessionId: "session-b",
		now: Date.parse("2026-03-24T12:02:30.000Z"),
	});
	assert.equal(description.isOwner, false);
	assert.equal(description.isStale, true);
	assert.equal(description.ownerLabel, "session-a");
});
