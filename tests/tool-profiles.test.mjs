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
	const planningProfile = buildToolProfile(allTools, { phase: "planning", mode: "delivery" });
	assert.deepEqual(planningProfile.sort(), ["autodevelop_state", "bash", "find", "google_search", "grep", "ls", "read"].sort());

	const hardeningProfile = buildToolProfile(allTools, { phase: "planning", mode: "hardening" });
	assert.equal(hardeningProfile.includes("edit"), false);
	assert.equal(hardeningProfile.includes("write"), false);

	const verifyingProfile = buildToolProfile(allTools, { phase: "verifying", mode: "improvement" });
	assert.equal(verifyingProfile.includes("edit"), false);
	assert.equal(verifyingProfile.includes("write"), false);
});

test("implementation phases enable editing tools", () => {
	const implementationProfile = buildToolProfile(allTools, { phase: "implementing", mode: "hardening" });
	assert.equal(implementationProfile.includes("edit"), true);
	assert.equal(implementationProfile.includes("write"), true);
});

test("paused phases restore all discovered tools", () => {
	const pausedProfile = buildToolProfile(allTools, { phase: "paused", mode: "improvement" });
	assert.equal(pausedProfile.length, allTools.length);
});
