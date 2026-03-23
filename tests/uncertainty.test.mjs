import test from "node:test";
import assert from "node:assert/strict";

import { detectUncertaintyMarker } from "../extensions/autodevelop/lib/uncertainty.js";

test("detects explicit uncertainty markers", () => {
	assert.equal(detectUncertaintyMarker("I am not sure this retry logic is correct."), "not sure");
	assert.equal(detectUncertaintyMarker("We probably need to inspect the upstream service."), "probably");
	assert.equal(detectUncertaintyMarker("This behavior is unclear under load."), "unclear");
});

test("ignores confident statements", () => {
	assert.equal(detectUncertaintyMarker("This change is verified and the tests pass."), null);
});

