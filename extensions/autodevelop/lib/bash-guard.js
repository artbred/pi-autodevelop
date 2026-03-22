import { basename } from "node:path";

function stripQuotes(token) {
	return token.replace(/^['"`]/, "").replace(/['"`]$/, "");
}

function normalizePathValue(value) {
	return value.replace(/\\/g, "/");
}

export function shellTokens(command) {
	const tokens = command.match(/"[^"]*"|'[^']*'|`[^`]*`|[^\s]+/g);
	return tokens ?? [];
}

export function tokenMatchesGoal(token, goalPath) {
	const normalizedGoalPath = normalizePathValue(goalPath);
	const goalBasename = basename(normalizedGoalPath);
	const normalizedToken = normalizePathValue(stripQuotes(token).replace(/[;&|]+$/, ""));

	return (
		normalizedToken === normalizedGoalPath ||
		normalizedToken === goalBasename ||
		normalizedToken === `./${goalBasename}` ||
		normalizedToken === `../${goalBasename}` ||
		normalizedToken.endsWith(`/${goalBasename}`)
	);
}

function nextTokenMatchesGoal(tokens, index, goalPath) {
	const nextToken = tokens[index + 1];
	return nextToken ? tokenMatchesGoal(nextToken, goalPath) : false;
}

export function isGoalMutationCommand(command, goalPath) {
	const tokens = shellTokens(command);
	if (tokens.length === 0) return false;

	const lowered = tokens.map((token) => stripQuotes(token).toLowerCase());
	const commandName = lowered[0];
	const referencesGoal = tokens.some((token) => tokenMatchesGoal(token, goalPath));

	if (!referencesGoal) return false;

	for (let index = 0; index < lowered.length; index += 1) {
		if (/^\d*>>?$/.test(lowered[index]) && nextTokenMatchesGoal(tokens, index, goalPath)) {
			return true;
		}
	}

	if (commandName === "tee") {
		return true;
	}

	if ((commandName === "sed" || commandName === "perl") && lowered.some((token) => token === "-i" || token.startsWith("-i"))) {
		return true;
	}

	if (["rm", "mv", "cp", "chmod", "chown", "touch", "truncate", "install"].includes(commandName)) {
		return true;
	}

	return false;
}
