import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 120000;

function sha256(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function slugify(value, fallback = "request") {
	const slug = String(value ?? fallback)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug || fallback;
}

function trimText(value) {
	return typeof value === "string" ? value.trim() : "";
}

function unique(values) {
	return [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))];
}

function getTimeoutMs(env = process.env) {
	const raw = Number(env.AUTODEVELOP_VERIFIER_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function buildPromptPath(paths, requestId) {
	return join(paths.sessionsDir, `${requestId}.prompt.txt`);
}

function normalizeArray(values) {
	return Array.isArray(values) ? values : [];
}

function appendSection(title, body) {
	return `## ${title}\n${body || "None."}`;
}

function spawnCommand(command, args, options = {}) {
	return new Promise((resolvePromise) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let finished = false;
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const timer = setTimeout(() => {
			if (finished) return;
			finished = true;
			child.kill("SIGKILL");
			resolvePromise({
				ok: false,
				code: null,
				stdout,
				stderr: `${stderr}\nTimed out after ${timeoutMs}ms`.trim(),
				timedOut: true,
			});
		}, timeoutMs);

		if (options.stdinText) {
			child.stdin.write(options.stdinText);
			child.stdin.end();
		} else {
			child.stdin.end();
		}

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			resolvePromise({
				ok: false,
				code: null,
				stdout,
				stderr: error instanceof Error ? error.message : String(error),
				timedOut: false,
			});
		});
		child.on("close", (code) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			resolvePromise({
				ok: code === 0,
				code,
				stdout,
				stderr,
				timedOut: false,
			});
		});
	});
}

function runGit(repoDir, args) {
	const result = spawnSync("git", args, {
		cwd: repoDir,
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error((result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim());
	}
	return result.stdout.trim();
}

export function resolveVerifierBackend({ cwd, env = process.env, piCliAvailable } = {}) {
	const configured = trimText(env.AUTODEVELOP_VERIFIER_BACKEND) || "auto";
	let repoRoot = null;
	try {
		repoRoot = runGit(cwd, ["rev-parse", "--show-toplevel"]);
	} catch {
		repoRoot = null;
	}

	const piAvailable =
		typeof piCliAvailable === "boolean"
			? piCliAvailable
			: spawnSync("which", [trimText(env.AUTODEVELOP_VERIFIER_PI_COMMAND) || "pi"], {
					encoding: "utf8",
				}).status === 0;

	if (!repoRoot) {
		return {
			configured,
			resolved: "inline",
			available: true,
			degradedReason: "Workspace is not a git repository. Using inline verifier mode.",
			repoRoot: null,
			isGitRepo: false,
		};
	}

	if (configured === "inline") {
		return {
			configured,
			resolved: "inline",
			available: true,
			degradedReason: null,
			repoRoot,
			isGitRepo: true,
		};
	}

	if (piAvailable) {
		return {
			configured,
			resolved: "pi_cli",
			available: true,
			degradedReason: null,
			repoRoot,
			isGitRepo: true,
		};
	}

	return {
		configured,
		resolved: "inline",
		available: true,
		degradedReason:
			configured === "pi_cli"
				? "Configured pi_cli verifier, but `pi` is not available on PATH. Using inline verifier mode."
				: "`pi` is not available on PATH. Using inline verifier mode.",
		repoRoot,
		isGitRepo: true,
	};
}

export async function ensureVerifierPaths(cwd, backend) {
	const workspaceRoot = resolve(backend?.repoRoot || cwd);
	const rootDir = join(workspaceRoot, ".autodevelop", "verifier");
	const requestsDir = join(rootDir, "requests");
	const reportsDir = join(rootDir, "reports");
	const sessionsDir = join(rootDir, "sessions");
	const worktreesDir = join(rootDir, "worktrees");

	for (const path of [rootDir, requestsDir, reportsDir, sessionsDir, worktreesDir]) {
		await mkdir(path, { recursive: true });
	}

	return {
		workspaceRoot,
		rootDir,
		requestsDir,
		reportsDir,
		sessionsDir,
		worktreesDir,
	};
}

function parseChangedFiles(statusOutput) {
	return statusOutput
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.slice(3).trim())
		.filter(Boolean);
}

export function collectLinkedResearchArtifacts(state, item) {
	if (!item?.evidenceRefs?.length) return [];
	const byId = new Map((state?.researchArtifacts ?? []).map((artifact) => [artifact.id, artifact]));
	return item.evidenceRefs.map((artifactId) => byId.get(artifactId)).filter(Boolean);
}

export function buildVerificationFingerprint(args) {
	const payload = {
		goalHash: args.goalHash,
		item: {
			id: args.item.id,
			kind: args.item.kind,
			title: args.item.title,
			notes: args.item.notes,
			acceptanceCriteria: args.item.acceptanceCriteria,
			objectiveRefs: unique(args.item.objectiveRefs),
			evidenceRefs: unique(args.item.evidenceRefs),
			dependsOnResearchItemIds: unique(args.item.dependsOnResearchItemIds),
		},
		researchArtifacts: normalizeArray(args.researchArtifacts).map((artifact) => ({
			id: artifact.id,
			summary: artifact.summary,
			provider: artifact.provider,
			query: artifact.query,
			target: artifact.target,
			sources: normalizeArray(artifact.sources).map((source) => ({
				location: source.location,
				title: source.title,
				line: source.line ?? null,
			})),
		})),
		repoSnapshot: args.repoSnapshot,
		lastVerificationSummary: args.lastVerificationSummary || "",
	};
	return sha256(JSON.stringify(payload));
}

export async function createVerificationRequest({ cwd, state, itemId, backend, requestId } = {}) {
	const item = state?.backlog?.find((candidate) => candidate.id === itemId);
	if (!item) {
		throw new Error(`Cannot create verification request for unknown item: ${itemId}`);
	}

	let repoSnapshot = {
		isGitRepo: false,
		repoRoot: null,
		headCommit: null,
		status: "",
		changedFiles: [],
		diffStat: "",
	};

	if (backend?.repoRoot) {
		try {
			const headCommit = runGit(backend.repoRoot, ["rev-parse", "HEAD"]);
			const status = runGit(backend.repoRoot, ["status", "--short"]);
			let diffStat = "";
			try {
				diffStat = runGit(backend.repoRoot, ["diff", "--stat", "HEAD"]);
			} catch {
				diffStat = "";
			}
			repoSnapshot = {
				isGitRepo: true,
				repoRoot: backend.repoRoot,
				headCommit,
				status,
				changedFiles: parseChangedFiles(status),
				diffStat,
			};
		} catch {
			repoSnapshot = {
				isGitRepo: false,
				repoRoot: null,
				headCommit: null,
				status: "",
				changedFiles: [],
				diffStat: "",
			};
		}
	}

	const linkedResearchArtifacts = collectLinkedResearchArtifacts(state, item);
	const fingerprint = buildVerificationFingerprint({
		goalHash: state.goal.hash,
		item,
		researchArtifacts: linkedResearchArtifacts,
		repoSnapshot,
		lastVerificationSummary: state.lastVerificationSummary,
	});

	const id = requestId || `verify-${Date.now()}-${slugify(item.title, item.kind)}`;
	return {
		id,
		createdAt: new Date().toISOString(),
		itemId: item.id,
		itemKind: item.kind,
		itemTitle: item.title,
		goal: {
			path: state.goal.path,
			hash: state.goal.hash,
			text: state.goal.text,
			sections: state.goal.sections,
			presentSections: state.goal.presentSections,
			explicitOptOuts: state.goal.explicitOptOuts,
		},
		item: {
			id: item.id,
			kind: item.kind,
			title: item.title,
			status: item.status,
			notes: item.notes,
			acceptanceCriteria: item.acceptanceCriteria,
			objectiveRefs: item.objectiveRefs,
			evidenceRefs: item.evidenceRefs,
			dependsOnResearchItemIds: item.dependsOnResearchItemIds,
		},
		linkedResearchArtifacts,
		repoSnapshot,
		lastVerificationSummary: state.lastVerificationSummary || "",
		lastFailure: state.lastFailure || "",
		fingerprint,
		instructions:
			"Read-only verifier. Determine whether the subtask is accomplished against the acceptance criteria and evidence. Do not edit code. Return only a structured verdict.",
	};
}

export async function persistVerificationRequest(paths, request) {
	const path = join(paths.requestsDir, `${request.id}.json`);
	await writeFile(path, `${JSON.stringify(request, null, 2)}\n`, "utf8");
	return path;
}

export async function persistVerificationReport(paths, report) {
	const path = join(paths.reportsDir, `${report.requestId}.json`);
	await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	return path;
}

export async function prepareVerifierWorktree(paths, backend, request) {
	if (!backend?.repoRoot) {
		throw new Error("Cannot create a verifier worktree outside a git repository.");
	}

	const worktreePath = join(paths.worktreesDir, request.id);
	try {
		const info = await stat(worktreePath);
		if (info.isDirectory()) {
			await rm(worktreePath, { recursive: true, force: true });
		}
	} catch {}

	await mkdir(dirname(worktreePath), { recursive: true });
	runGit(backend.repoRoot, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
	return worktreePath;
}

function extractJsonBlock(text) {
	const markerMatch = text.match(/VERIFICATION_RESULT_START\s*([\s\S]*?)\s*VERIFICATION_RESULT_END/);
	if (markerMatch) return markerMatch[1].trim();

	const fencedMatch = text.match(/```json\s*([\s\S]*?)```/i);
	if (fencedMatch) return fencedMatch[1].trim();

	const firstBrace = text.indexOf("{");
	const lastBrace = text.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		return text.slice(firstBrace, lastBrace + 1).trim();
	}

	return text.trim();
}

export function parseVerificationResultText(text, request) {
	const jsonBlock = extractJsonBlock(text);
	let parsed;
	try {
		parsed = JSON.parse(jsonBlock);
	} catch (error) {
		throw new Error(`Failed to parse verifier response JSON: ${error instanceof Error ? error.message : String(error)}`);
	}

	const status = trimText(parsed.status);
	if (!["pass", "pass_with_notes", "fail"].includes(status)) {
		throw new Error(`Verifier returned invalid status: ${status || "missing"}`);
	}

	return {
		id: `report-${request.id}`,
		requestId: request.id,
		requestFingerprint: request.fingerprint,
		createdAt: new Date().toISOString(),
		status,
		summary: trimText(parsed.summary),
		findings: unique(parsed.findings ?? []),
		missingEvidence: unique(parsed.missingEvidence ?? []),
		recommendedNextSteps: unique(parsed.recommendedNextSteps ?? []),
		rawText: trimText(text),
	};
}

export function buildVerifierPrompt(request) {
	const researchSection = request.linkedResearchArtifacts.length
		? request.linkedResearchArtifacts
				.map((artifact) => {
					const sources = normalizeArray(artifact.sources)
						.map((source) => `${source.location}${source.line ? `:${source.line}` : ""}`)
						.join(", ");
					return `- ${artifact.id} [${artifact.provider}] ${artifact.summary || artifact.query || artifact.target}${sources ? ` @ ${sources}` : ""}`;
				})
				.join("\n")
		: "- None.";

	const repoSection = request.repoSnapshot.isGitRepo
		? [
				`Repo root: ${request.repoSnapshot.repoRoot}`,
				`HEAD: ${request.repoSnapshot.headCommit || "unknown"}`,
				`Changed files: ${request.repoSnapshot.changedFiles.join(", ") || "none"}`,
				`Diff stat:\n${request.repoSnapshot.diffStat || "none"}`,
			].join("\n")
		: "Non-git workspace.";

	return `You are a strict read-only verifier for an autonomous coding loop.

Decide whether the subtask below is accomplished against its acceptance criteria and evidence.
Do not edit files. Do not propose code patches. Only evaluate completion quality.

${appendSection("Goal", `${request.goal.text || "Goal snapshot unavailable."}`)}

${appendSection(
	"Task",
	[
		`Item id: ${request.item.id}`,
		`Kind: ${request.item.kind}`,
		`Title: ${request.item.title}`,
		`Acceptance criteria: ${request.item.acceptanceCriteria || "missing"}`,
		`Notes: ${request.item.notes || "none"}`,
		`Objective refs: ${request.item.objectiveRefs.join(", ") || "none"}`,
		`Evidence refs: ${request.item.evidenceRefs.join(", ") || "none"}`,
	].join("\n"),
)}

${appendSection("Linked Research Artifacts", researchSection)}

${appendSection("Repo Snapshot", repoSection)}

${appendSection("Recent Verification Summary", request.lastVerificationSummary || "None yet.")}

Return exactly one JSON object between the markers VERIFICATION_RESULT_START and VERIFICATION_RESULT_END.
Schema:
{
  "status": "pass" | "pass_with_notes" | "fail",
  "summary": "short summary",
  "findings": ["..."],
  "missingEvidence": ["..."],
  "recommendedNextSteps": ["..."]
}

VERIFICATION_RESULT_START
{"status":"fail","summary":"placeholder","findings":[],"missingEvidence":[],"recommendedNextSteps":[]}
VERIFICATION_RESULT_END`;
}

export async function runInlineVerifier({
	request,
	model,
	apiKey,
	signal,
	completeFn,
} = {}) {
	if (!model || !apiKey) {
		return {
			id: `report-${request.id}`,
			requestId: request.id,
			requestFingerprint: request.fingerprint,
			createdAt: new Date().toISOString(),
			status: "fail",
			summary: "Inline verifier is unavailable because no model or API key is active.",
			findings: ["Verifier could not run because the extension has no active model/api key for inline review."],
			missingEvidence: [],
			recommendedNextSteps: ["Resume with a model-enabled pi session or provide an external pi verifier worker."],
			rawText: "",
		};
	}

	const response = await completeFn(
		model,
		{
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: buildVerifierPrompt(request) }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey,
			maxTokens: 1200,
			signal,
		},
	);

	const text = response.content
		.filter((item) => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();
	return parseVerificationResultText(text, request);
}

export async function runPiCliVerifier({
	request,
	backend,
	paths,
	env = process.env,
} = {}) {
	if (backend?.resolved !== "pi_cli") {
		throw new Error("pi_cli verifier requested while backend is not pi_cli.");
	}

	const worktreePath = await prepareVerifierWorktree(paths, backend, request);
	const sessionDir = join(paths.sessionsDir, request.id);
	await mkdir(sessionDir, { recursive: true });
	const promptPath = buildPromptPath(paths, request.id);
	await writeFile(promptPath, `${buildVerifierPrompt(request)}\n`, "utf8");

	const command = trimText(env.AUTODEVELOP_VERIFIER_PI_COMMAND) || "pi";
	const timeoutMs = getTimeoutMs(env);
	const shellCommand = `${command} --session-dir ${JSON.stringify(sessionDir)} < ${JSON.stringify(promptPath)}`;
	const result = await spawnCommand("bash", ["-lc", shellCommand], {
		cwd: worktreePath,
		env,
		timeoutMs,
	});

	try {
		await rm(worktreePath, { recursive: true, force: true });
	} catch {}

	if (!result.ok) {
		throw new Error((result.stderr || result.stdout || "Verifier pi_cli invocation failed").trim());
	}

	const output = `${result.stdout}\n${result.stderr}`.trim();
	return parseVerificationResultText(output, request);
}

export function isVerificationReportStale(request, state) {
	const item = state?.backlog?.find((candidate) => candidate.id === request.itemId);
	if (!item) return true;
	const currentFingerprint = buildVerificationFingerprint({
		goalHash: state.goal.hash,
		item,
		researchArtifacts: collectLinkedResearchArtifacts(state, item),
		repoSnapshot: request.repoSnapshot,
		lastVerificationSummary: state.lastVerificationSummary,
	});
	return currentFingerprint !== request.fingerprint;
}
