import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveWorkspacePaths } from "./workspace.js";

export function getReviewLogPaths({ cwd, state } = {}) {
	const rootDir = resolveWorkspacePaths({ cwd, state }).autodevelopRoot;
	return {
		rootDir,
		historyPath: join(rootDir, "history.md"),
		researchDir: join(rootDir, "research"),
		cyclesDir: join(rootDir, "cycles"),
	};
}

function formatSourceLine(source) {
	const parts = [source.location?.trim?.(), source.title?.trim?.()].filter(Boolean);
	const linePart = Number.isFinite(source.line) ? `line ${source.line}` : "";
	if (linePart) parts.push(linePart);
	return parts.join(" | ");
}

function formatResearchArtifactMarkdown(artifact, context = {}) {
	const lines = [
		"# Research Artifact",
		"",
		`- Id: \`${artifact.id}\``,
		`- Created: ${artifact.createdAt || "unknown"}`,
		`- Action: ${artifact.action || "query"}`,
		`- Scope: ${artifact.scope || "auto"}`,
		`- Provider: ${artifact.provider || "unknown"}`,
	];

	if (context.itemTitle) lines.push(`- Related item: ${context.itemTitle}`);
	if (artifact.query) lines.push(`- Query: ${artifact.query}`);
	if (artifact.target) lines.push(`- Target: ${artifact.target}`);
	if (artifact.objectiveRefs?.length) lines.push(`- Objectives: ${artifact.objectiveRefs.join(", ")}`);

	lines.push("", "## Summary", "", artifact.summary || "None.", "");

	if (artifact.sources?.length) {
		lines.push("## Sources", "");
		for (const source of artifact.sources) {
			lines.push(`- ${formatSourceLine(source) || "Unknown source"}`);
		}
		lines.push("");
	}

	if (artifact.content?.trim()) {
		lines.push("## Content", "", artifact.content.trim(), "");
	}

	return `${lines.join("\n").trimEnd()}\n`;
}

function buildHistorySection(title, lines) {
	return `## ${title}\n\n${lines.filter(Boolean).join("\n")}\n\n`;
}

function formatCycleSummaryMarkdown({
	cycleNumber,
	branch,
	completionSummary,
	commitSha,
	diffStat,
	changedFiles,
	blockers,
	noop,
}) {
	const lines = [
		`# Cycle ${cycleNumber}`,
		"",
		`- Branch: ${branch || "unknown"}`,
		`- Result: ${noop ? "no-op" : "committed"}`,
		`- Commit: ${commitSha || "none"}`,
		"",
		"## Completion Summary",
		"",
		completionSummary || "None.",
		"",
		"## Changed Files",
		"",
		...(changedFiles?.length ? changedFiles.map((file) => `- ${file}`) : ["- none"]),
		"",
		"## Blockers",
		"",
		...(blockers?.length ? blockers.map((blocker) => `- ${blocker}`) : ["- none"]),
		"",
		"## Diffstat",
		"",
		diffStat || "No diffstat available.",
		"",
	];

	return lines.join("\n");
}

export async function persistResearchArtifactReview({ artifact, cwd, state, itemTitle } = {}) {
	if (!artifact) return null;

	const paths = getReviewLogPaths({ cwd, state });
	await mkdir(paths.researchDir, { recursive: true });

	const artifactPath = join(paths.researchDir, `${artifact.id}.md`);
	await writeFile(artifactPath, formatResearchArtifactMarkdown(artifact, { itemTitle }), "utf8");

	await appendFile(
		paths.historyPath,
		buildHistorySection(`Research ${artifact.id}`, [
			`- Created: ${artifact.createdAt || "unknown"}`,
			`- Provider: ${artifact.provider || "unknown"}`,
			itemTitle ? `- Related item: ${itemTitle}` : "",
			artifact.query ? `- Query: ${artifact.query}` : "",
			artifact.target ? `- Target: ${artifact.target}` : "",
			`- Summary: ${artifact.summary || "None."}`,
			`- File: ${artifactPath}`,
		]),
		"utf8",
	);

	return artifactPath;
}

export async function persistCycleSummary({
	cycleNumber,
	branch,
	completionSummary,
	commitSha,
	diffStat,
	changedFiles,
	blockers,
	noop = false,
	cwd,
	state,
} = {}) {
	if (!Number.isFinite(cycleNumber) || cycleNumber <= 0) {
		throw new Error("cycleNumber is required for persistCycleSummary");
	}

	const paths = getReviewLogPaths({ cwd, state });
	await mkdir(paths.cyclesDir, { recursive: true });

	const cyclePath = join(paths.cyclesDir, `${cycleNumber}.md`);
	await writeFile(
		cyclePath,
		formatCycleSummaryMarkdown({
			cycleNumber,
			branch,
			completionSummary,
			commitSha,
			diffStat,
			changedFiles,
			blockers,
			noop,
		}),
		"utf8",
	);

	await appendFile(
		paths.historyPath,
		buildHistorySection(`Cycle ${cycleNumber}`, [
			`- Branch: ${branch || "unknown"}`,
			`- Result: ${noop ? "no-op" : "committed"}`,
			`- Commit: ${commitSha || "none"}`,
			`- Summary: ${completionSummary || "None."}`,
			`- Changed files: ${changedFiles?.length ? changedFiles.join(" | ") : "none"}`,
			`- Blockers: ${blockers?.length ? blockers.join(" | ") : "none"}`,
			`- File: ${cyclePath}`,
		]),
		"utf8",
	);

	return cyclePath;
}
