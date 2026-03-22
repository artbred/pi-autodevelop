import { BUILT_IN_TOOL_NAMES, EXECUTION_PHASES, PAUSED_OR_TERMINAL_PHASES, READ_ONLY_PHASES } from "./constants.js";

const RESEARCH_TOOL_HINT = /(search|web|wiki|docs|browser|fetch|crawl|http)/i;

function unique(values) {
	return [...new Set(values)];
}

function hasTool(allToolNames, name) {
	return allToolNames.includes(name);
}

function getExtraTools(allToolNames) {
	return allToolNames.filter((name) => !BUILT_IN_TOOL_NAMES.has(name) && name !== "autodevelop_state" && RESEARCH_TOOL_HINT.test(name));
}

export function buildToolProfile(allTools, loopState) {
	if (!loopState) return null;

	const allToolNames = allTools.map((tool) => tool.name);
	const readOnlyBase = ["read", "bash", "grep", "find", "ls", "autodevelop_state"].filter((name) => hasTool(allToolNames, name));
	const executionBase = [...readOnlyBase, "edit", "write"].filter((name) => hasTool(allToolNames, name));
	const extraTools = getExtraTools(allToolNames);

	if (READ_ONLY_PHASES.has(loopState.phase)) {
		return unique([...readOnlyBase, ...extraTools]);
	}

	if (EXECUTION_PHASES.has(loopState.phase)) {
		return unique([...executionBase, ...extraTools]);
	}

	if (PAUSED_OR_TERMINAL_PHASES.has(loopState.phase)) {
		return allToolNames;
	}

	return unique([...readOnlyBase, ...extraTools]);
}
