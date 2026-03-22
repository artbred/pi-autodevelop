import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../", import.meta.url);

test("package manifest exposes pi extension and skills", async () => {
	const packageJsonPath = new URL("../package.json", import.meta.url);
	const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));

	assert.equal(packageJson.pi.extensions[0], "./extensions/autodevelop/index.ts");
	assert.equal(packageJson.pi.skills[0], "./skills");

	for (const relativePath of [
		packageJson.pi.extensions[0],
		"./skills/auto-develop-loop/SKILL.md",
		"./skills/auto-develop-loop/references/protocol.md",
	]) {
		await access(join(root.pathname, relativePath));
	}
});
