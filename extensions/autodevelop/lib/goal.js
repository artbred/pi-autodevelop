import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { GOAL_SECTION_ORDER, QUALITY_OBJECTIVE_NAMES } from "./constants.js";

function trimSectionLines(lines) {
	return lines.join("\n").trim();
}

function normalizeHeading(text) {
	return text.trim().toLowerCase();
}

export function sha256Text(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export function parseExplicitOptOuts(sectionText) {
	if (!sectionText?.trim()) return [];

	const supported = new Set(QUALITY_OBJECTIVE_NAMES);
	const matches = new Set();

	for (const line of sectionText.split(/\r?\n/)) {
		const bulletMatch = line.match(/^\s*[-*+]\s+(.+?)\s*$/);
		if (!bulletMatch) continue;

		const candidate = bulletMatch[1].trim().toLowerCase();
		if (supported.has(candidate)) {
			matches.add(candidate);
		}
	}

	return [...matches];
}

export function parseGoalDocument(text) {
	const headings = new Set(GOAL_SECTION_ORDER.map((heading) => normalizeHeading(heading)));
	const sections = {};
	const lines = text.split(/\r?\n/);
	let currentHeading = null;
	let buffer = [];

	for (const line of lines) {
		const match = line.match(/^#{1,6}\s+(.+?)\s*$/);
		if (match) {
			const heading = match[1].trim();
			const normalized = normalizeHeading(heading);
			if (headings.has(normalized)) {
				if (currentHeading) {
					sections[currentHeading] = trimSectionLines(buffer);
				}
				currentHeading = GOAL_SECTION_ORDER.find((value) => normalizeHeading(value) === normalized) ?? heading;
				buffer = [];
				continue;
			}
		}

		if (currentHeading) {
			buffer.push(line);
		}
	}

	if (currentHeading) {
		sections[currentHeading] = trimSectionLines(buffer);
	}

	const presentSections = GOAL_SECTION_ORDER.filter((heading) => sections[heading]);

	return {
		text,
		sections,
		hasStructuredSections: presentSections.length > 0,
		presentSections,
		explicitOptOuts: parseExplicitOptOuts(sections["Explicit Opt-Outs"]),
	};
}

export async function resolveExistingGoalPath(cwd, goalPath) {
	const absolutePath = resolve(cwd, goalPath);
	return realpath(absolutePath);
}

export async function readGoalSnapshot(cwd, goalPath) {
	const canonicalPath = await resolveExistingGoalPath(cwd, goalPath);
	const text = await readFile(canonicalPath, "utf8");
	const parsed = parseGoalDocument(text);

	return {
		path: canonicalPath,
		text,
		hash: sha256Text(text),
		sections: parsed.sections,
		presentSections: parsed.presentSections,
		hasStructuredSections: parsed.hasStructuredSections,
		explicitOptOuts: parsed.explicitOptOuts,
		readonlyProtection: false,
	};
}

export async function verifyGoalSnapshot(snapshot) {
	try {
		const currentText = await readFile(snapshot.path, "utf8");
		const currentHash = sha256Text(currentText);

		return {
			ok: currentHash === snapshot.hash,
			currentHash,
			currentText,
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function makeGoalReadOnly(path) {
	try {
		const info = await stat(path);
		const readonlyMode = info.mode & ~0o222;
		await chmod(path, readonlyMode);
		return true;
	} catch {
		return false;
	}
}

export function createGoalScaffoldContent() {
	return `# Goal

Describe the final outcome the auto-develop loop must achieve.

# Success Criteria

- Define the observable conditions that mean the goal is complete.

# Constraints

- List hard constraints, required technologies, forbidden approaches, or safety limits.

# Out of Scope

- List items the loop must not change or attempt.

# Notes

- Add context, links, examples, or research hints.

# Explicit Opt-Outs

Leave this section empty unless you intentionally want to disable one of the default quality objectives.
Allowed values when needed: \`performance\`, \`latency\`, \`throughput\`, \`memory\`, \`scalability\`, \`reliability\`.
`;
}

export async function scaffoldGoalFile(cwd, goalPath) {
	const absolutePath = resolve(cwd, goalPath);
	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, createGoalScaffoldContent(), { flag: "wx", encoding: "utf8" });
	return absolutePath;
}
