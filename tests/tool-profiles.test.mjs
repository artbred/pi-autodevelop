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
	{ name: "autodevelop_research" },
	{ name: "google_search" },
];

test("planning, researching, committing, and relaunching stay read-only but keep research helpers", () => {
	const planningProfile = buildToolProfile(allTools, { phase: "planning", mode: "cycle" });
	assert.deepEqual(
		planningProfile.sort(),
		["autodevelop_research", "autodevelop_state", "bash", "find", "google_search", "grep", "ls", "read"].sort(),
	);

	const researchingProfile = buildToolProfile(allTools, { phase: "researching", mode: "cycle" });
	assert.equal(researchingProfile.includes("edit"), false);
	assert.equal(researchingProfile.includes("write"), false);

	const committingProfile = buildToolProfile(allTools, { phase: "committing", mode: "cycle" });
	assert.equal(committingProfile.includes("edit"), false);
	assert.equal(committingProfile.includes("write"), false);

	const relaunchingProfile = buildToolProfile(allTools, { phase: "relaunching", mode: "cycle" });
	assert.equal(relaunchingProfile.includes("edit"), false);
	assert.equal(relaunchingProfile.includes("write"), false);
	assert.equal(relaunchingProfile.includes("autodevelop_research"), true);
});

test("implementation phases enable editing tools", () => {
	const implementationProfile = buildToolProfile(allTools, { phase: "implementing", mode: "cycle" });
	assert.equal(implementationProfile.includes("edit"), true);
	assert.equal(implementationProfile.includes("write"), true);
	assert.equal(implementationProfile.includes("autodevelop_research"), true);

	const testingProfile = buildToolProfile(allTools, { phase: "testing", mode: "cycle" });
	assert.equal(testingProfile.includes("edit"), true);
	assert.equal(testingProfile.includes("write"), true);
});

test("paused phases restore all discovered tools", () => {
	const pausedProfile = buildToolProfile(allTools, { phase: "paused", mode: "cycle" });
	assert.equal(pausedProfile.length, allTools.length);
});
