import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { resolveWorkspacePaths, writeFileAtomically } from "./workspace.js";

export const LEASE_VERSION = 1;
export const LEASE_HEARTBEAT_INTERVAL_MS = 30000;
export const LEASE_STALE_TTL_MS = 120000;

function trimText(value) {
	return typeof value === "string" ? value.trim() : "";
}

function toIsoString(value = new Date()) {
	if (typeof value === "string") return value;
	if (value instanceof Date) return value.toISOString();
	return new Date(value).toISOString();
}

function normalizeLease(rawLease) {
	if (!rawLease) return null;

	return {
		version: Number.isFinite(rawLease.version) ? rawLease.version : LEASE_VERSION,
		sessionId: trimText(rawLease.sessionId),
		sessionFile: trimText(rawLease.sessionFile),
		cwd: trimText(rawLease.cwd),
		goalPath: trimText(rawLease.goalPath),
		mode: trimText(rawLease.mode),
		phase: trimText(rawLease.phase),
		acquiredAt: trimText(rawLease.acquiredAt),
		heartbeatAt: trimText(rawLease.heartbeatAt),
	};
}

export function getLoopLeasePath({ cwd, state } = {}) {
	return join(resolveWorkspacePaths({ cwd, state }).autodevelopRoot, "lease.json");
}

export async function readLoopLease({ cwd, state } = {}) {
	const path = getLoopLeasePath({ cwd, state });
	try {
		const lease = JSON.parse(await readFile(path, "utf8"));
		const normalized = normalizeLease(lease);
		return normalized?.sessionId ? normalized : null;
	} catch {
		return null;
	}
}

export function getLeaseAgeMs(lease, now = Date.now()) {
	if (!lease) return Number.POSITIVE_INFINITY;
	const anchor = Date.parse(lease.heartbeatAt || lease.acquiredAt || "");
	if (!Number.isFinite(anchor)) return Number.POSITIVE_INFINITY;
	return Math.max(0, now - anchor);
}

export function isLeaseStale(lease, { now = Date.now(), staleAfterMs = LEASE_STALE_TTL_MS } = {}) {
	if (!lease) return false;
	return getLeaseAgeMs(lease, now) >= staleAfterMs;
}

export function describeLoopLease(lease, { currentSessionId, now = Date.now(), staleAfterMs = LEASE_STALE_TTL_MS } = {}) {
	if (!lease) {
		return {
			present: false,
			isOwner: false,
			isStale: false,
			ageMs: 0,
			ownerLabel: "none",
			ageLabel: "n/a",
		};
	}

	const ageMs = getLeaseAgeMs(lease, now);
	const isStale = isLeaseStale(lease, { now, staleAfterMs });
	const isOwner = trimText(currentSessionId) !== "" && trimText(currentSessionId) === lease.sessionId;
	const ageSeconds = Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : 0;

	return {
		present: true,
		isOwner,
		isStale,
		ageMs,
		ownerLabel: lease.sessionId,
		ageLabel: Number.isFinite(ageMs) ? `${ageSeconds}s` : "unknown",
		freshness: isStale ? "stale" : "fresh",
	};
}

function buildLeasePayload({ sessionId, sessionFile, cwd, goalPath, mode, phase, acquiredAt, heartbeatAt }) {
	return {
		version: LEASE_VERSION,
		sessionId: trimText(sessionId),
		sessionFile: trimText(sessionFile),
		cwd: trimText(cwd),
		goalPath: trimText(goalPath),
		mode: trimText(mode),
		phase: trimText(phase),
		acquiredAt: toIsoString(acquiredAt),
		heartbeatAt: toIsoString(heartbeatAt),
	};
}

export async function acquireLoopLease({
	cwd,
	state,
	sessionId,
	sessionFile,
	force = false,
	now = new Date(),
} = {}) {
	const existing = await readLoopLease({ cwd, state });
	if (existing && existing.sessionId && existing.sessionId !== trimText(sessionId) && !force) {
		return {
			ok: false,
			lease: existing,
		};
	}

	const path = getLoopLeasePath({ cwd, state });
	const acquiredAt = existing?.sessionId === trimText(sessionId) ? existing.acquiredAt || toIsoString(now) : toIsoString(now);
	const lease = buildLeasePayload({
		sessionId,
		sessionFile,
		cwd,
		goalPath: state?.goal?.path,
		mode: state?.mode,
		phase: state?.phase,
		acquiredAt,
		heartbeatAt: now,
	});
	await writeFileAtomically(path, `${JSON.stringify(lease, null, 2)}\n`);
	return {
		ok: true,
		lease,
		previousLease: existing,
		stolen: Boolean(existing && existing.sessionId && existing.sessionId !== trimText(sessionId)),
	};
}

export async function refreshLoopLease({
	cwd,
	state,
	sessionId,
	sessionFile,
	now = new Date(),
} = {}) {
	const existing = await readLoopLease({ cwd, state });
	if (!existing || existing.sessionId !== trimText(sessionId)) {
		return null;
	}

	const path = getLoopLeasePath({ cwd, state });
	const lease = buildLeasePayload({
		sessionId,
		sessionFile,
		cwd: state?.repoRoot || state?.verifierBackend?.repoRoot || cwd || existing.cwd,
		goalPath: state?.goal?.path || existing.goalPath,
		mode: state?.mode || existing.mode,
		phase: state?.phase || existing.phase,
		acquiredAt: existing.acquiredAt || now,
		heartbeatAt: now,
	});
	await writeFileAtomically(path, `${JSON.stringify(lease, null, 2)}\n`);
	return lease;
}

export async function releaseLoopLease({ cwd, state, sessionId, force = false } = {}) {
	const path = getLoopLeasePath({ cwd, state });
	const existing = await readLoopLease({ cwd, state });
	if (!existing) return false;
	if (!force && existing.sessionId !== trimText(sessionId)) return false;

	try {
		await rm(path, { force: true });
		return true;
	} catch {
		return false;
	}
}

export async function hasLoopLease({ cwd, state } = {}) {
	try {
		await stat(getLoopLeasePath({ cwd, state }));
		return true;
	} catch {
		return false;
	}
}
