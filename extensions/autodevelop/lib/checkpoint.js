import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { cloneLoopState, formatLoopStateMarkdown, migrateLoopState } from "./state-machine.js";
import { resolveWorkspacePaths, writeFileAtomically } from "./workspace.js";

export function getLoopStateCheckpointPath({ cwd, state } = {}) {
	return join(resolveWorkspacePaths({ cwd, state }).autodevelopRoot, "loop-state.json");
}

export async function writeLoopStateCheckpoint(state, { cwd } = {}) {
	if (!state) return null;

	const path = getLoopStateCheckpointPath({ cwd, state });
	const markdownPath = join(resolveWorkspacePaths({ cwd, state }).autodevelopRoot, "loop-state.md");
	await writeFileAtomically(
		path,
		`${JSON.stringify(
			{
				version: 1,
				updatedAt: new Date().toISOString(),
				state: cloneLoopState(state),
			},
			null,
			2,
			)}\n`,
	);
	await writeFileAtomically(markdownPath, `${formatLoopStateMarkdown(state)}\n`);
	return path;
}

export async function readLoopStateCheckpoint(cwd, { state } = {}) {
	const path = getLoopStateCheckpointPath({ cwd, state });
	try {
		const text = await readFile(path, "utf8");
		const parsed = JSON.parse(text);
		const nextState = migrateLoopState(parsed?.state ?? parsed);
		return nextState?.goal?.path ? nextState : null;
	} catch {
		return null;
	}
}
