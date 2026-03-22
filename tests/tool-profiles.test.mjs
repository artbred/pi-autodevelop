import test from "node:test";
import assert from "node:assert/strict";

import { buildToolProfile } from "../extensions/autodevelop/lib/tool-profiles.js";

const allTools = [
	{ name: "read" },
	{ name: "bash" },
	{ name: "grep" },
	{ name: "find" },
	{ name: "ls" },
	{ name: "edit" },
	{ name: "write" },
	{ name: "autodevelop_state" },
	{ name: "google_search" },
];

test("planning and verification phases stay read-only but keep research helpers", () => {
	const planningProfile = buildToolProfile(allTools, { phase: "planning" });
	assert.deepEqual(planningProfile.sort(), ["autodevelop_state", "bash", "find", "google_search", "grep", "ls", "read"].sort());

	const verifyingProfile = buildToolProfile(allTools, { phase: "verifying" });
	assert.equal(verifyingProfile.includes("edit"), false);
	assert.equal(verifyingProfile.includes("write"), false);
});

test("implementation phases enable editing tools", () => {
	const implementationProfile = buildToolProfile(allTools, { phase: "implementing" });
	assert.equal(implementationProfile.includes("edit"), true);
	assert.equal(implementationProfile.includes("write"), true);
});

test("paused and terminal phases restore all discovered tools", () => {
	const pausedProfile = buildToolProfile(allTools, { phase: "paused" });
	assert.equal(pausedProfile.length, allTools.length);
});
