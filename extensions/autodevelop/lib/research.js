import { spawn } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_LOCAL_MATCHES = 20;
const MAX_WEB_RESULTS = 5;
const MAX_FETCH_CHARS = 8000;
const MAX_FILE_BYTES = 256 * 1024;
const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage"]);

function truncate(text, maxChars = MAX_FETCH_CHARS) {
	if (!text) return "";
	return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated]` : text;
}

function summarizeSnippet(text) {
	return truncate(text?.replace(/\s+/g, " ").trim(), 240);
}

function ensureArray(values) {
	return Array.isArray(values) ? values : [];
}

function makeProviderState(configured, healthy, description, extras = {}) {
	return {
		configured,
		healthy,
		description,
		lastError: extras.lastError ?? "",
		lastCheckedAt: extras.lastCheckedAt ?? new Date().toISOString(),
	};
}

function createTextContent(title, body) {
	return title ? `${title}\n\n${body}` : body;
}

function buildArtifactId(prefix, label) {
	const slug = (label ?? prefix)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `${prefix}-${Date.now()}-${slug || "artifact"}`;
}

function buildTimeoutSignal(timeoutMs) {
	return AbortSignal.timeout(Math.max(1, timeoutMs));
}

function getTimeoutMs(env = process.env) {
	const raw = Number(env.AUTODEVELOP_RESEARCH_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function joinUrl(baseUrl, relativePath) {
	return new URL(relativePath.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

function getPinchtabHeaders(env = process.env) {
	const token = env.AUTODEVELOP_PINCHTAB_TOKEN?.trim();
	if (!token) return {};

	return {
		authorization: `Bearer ${token}`,
		"x-api-key": token,
	};
}

async function fetchJson(url, options, fetchImpl) {
	const response = await fetchImpl(url, options);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
	}
	return response.json();
}

async function probeSearxng(fetchImpl, env = process.env) {
	const baseUrl = env.AUTODEVELOP_SEARXNG_URL?.trim();
	if (!baseUrl) {
		return makeProviderState(false, false, "SearXNG not configured.");
	}

	try {
		const timeoutMs = getTimeoutMs(env);
		await fetchJson(
			joinUrl(baseUrl, "/search?q=autodevelop&format=json"),
			{ signal: buildTimeoutSignal(timeoutMs) },
			fetchImpl,
		);
		return makeProviderState(true, true, `SearXNG healthy at ${baseUrl}`);
	} catch (error) {
		return makeProviderState(true, false, `SearXNG configured at ${baseUrl}`, {
			lastError: error instanceof Error ? error.message : String(error),
		});
	}
}

async function probePinchtab(fetchImpl, env = process.env) {
	const baseUrl = env.AUTODEVELOP_PINCHTAB_URL?.trim();
	if (!baseUrl) {
		return makeProviderState(false, false, "PinchTab not configured.");
	}

	try {
		const timeoutMs = getTimeoutMs(env);
		await fetchJson(joinUrl(baseUrl, "/health"), { headers: getPinchtabHeaders(env), signal: buildTimeoutSignal(timeoutMs) }, fetchImpl);
		const template = env.AUTODEVELOP_PINCHTAB_SEARCH_URL_TEMPLATE?.trim();
		const description = template
			? `PinchTab healthy at ${baseUrl}`
			: `PinchTab healthy at ${baseUrl} (search template not configured)`;
		return makeProviderState(true, true, description);
	} catch (error) {
		return makeProviderState(true, false, `PinchTab configured at ${baseUrl}`, {
			lastError: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function probeResearchProviders({ env = process.env, fetchImpl = fetch } = {}) {
	return {
		local: makeProviderState(true, true, "Built-in local repo research is always available."),
		searxng: await probeSearxng(fetchImpl, env),
		pinchtab: await probePinchtab(fetchImpl, env),
	};
}

function buildProviderOrder(scope) {
	if (scope === "repo") return ["local"];
	if (scope === "web") return ["searxng", "pinchtab"];
	return ["local", "searxng", "pinchtab"];
}

function collectObjectiveRefs(explicitRefs, state) {
	const values = explicitRefs?.length
		? explicitRefs
		: state?.backlog?.find((item) => item.id === state.currentItemId)?.objectiveRefs ?? [];
	return [...new Set(ensureArray(values).map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

async function runCommand(command, args, cwd, timeoutMs) {
	return new Promise((resolvePromise) => {
		const child = spawn(command, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let finished = false;
		const timer = setTimeout(() => {
			if (finished) return;
			finished = true;
			child.kill("SIGKILL");
			resolvePromise({ ok: false, code: null, stdout, stderr: `${stderr}\nTimed out after ${timeoutMs}ms`.trim(), timedOut: true });
		}, timeoutMs);

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
			resolvePromise({ ok: false, code: null, stdout, stderr: error.message, timedOut: false });
		});
		child.on("close", (code) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			resolvePromise({ ok: code === 0 || code === 1, code, stdout, stderr, timedOut: false });
		});
	});
}

async function searchLocalWithRipgrep(cwd, query, timeoutMs) {
	const result = await runCommand(
		"rg",
		[
			"-n",
			"-F",
			"--max-count",
			String(MAX_LOCAL_MATCHES),
			"--max-columns",
			"240",
			"-g",
			"!node_modules/**",
			"-g",
			"!.git/**",
			"-g",
			"!dist/**",
			"-g",
			"!build/**",
			query,
			".",
		],
		cwd,
		timeoutMs,
	);

	if (!result.ok) {
		throw new Error(result.stderr || "ripgrep failed");
	}

	if (!result.stdout.trim()) {
		return [];
	}

	return result.stdout
		.trim()
		.split(/\r?\n/)
		.slice(0, MAX_LOCAL_MATCHES)
		.map((line) => {
			const [location, snippet] = line.split(/:(?=\d+:)/).length === 2 ? line.split(/:(?=\d+:)/) : [line, ""];
			const match = location.match(/^(.*?):(\d+)$/);
			const path = match?.[1] ?? location;
			const lineNumber = Number(match?.[2] ?? 1);
			return {
				kind: "file",
				location: resolve(cwd, path.replace(/^\.\//, "")),
				line: lineNumber,
				title: path,
				snippet: summarizeSnippet(snippet.replace(/^\d+:/, "")),
			};
		});
}

async function searchLocalFallback(cwd, query) {
	const lowerQuery = query.toLowerCase();
	const results = [];

	async function walk(directory) {
		if (results.length >= MAX_LOCAL_MATCHES) return;
		const entries = await readdir(directory, { withFileTypes: true });

		for (const entry of entries) {
			if (results.length >= MAX_LOCAL_MATCHES) return;
			if (EXCLUDED_DIRS.has(entry.name)) continue;

			const fullPath = resolve(directory, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
				continue;
			}

			if (!entry.isFile()) continue;

			let info;
			try {
				info = await stat(fullPath);
			} catch {
				continue;
			}
			if (info.size > MAX_FILE_BYTES) continue;

			let text;
			try {
				text = await readFile(fullPath, "utf8");
			} catch {
				continue;
			}

			const lines = text.split(/\r?\n/);
			const index = lines.findIndex((line) => line.toLowerCase().includes(lowerQuery));
			if (index === -1) continue;

			results.push({
				kind: "file",
				location: fullPath,
				line: index + 1,
				title: fullPath,
				snippet: summarizeSnippet(lines[index]),
			});
		}
	}

	await walk(cwd);
	return results;
}

async function runLocalQuery(cwd, query, timeoutMs) {
	let sources;
	try {
		sources = await searchLocalWithRipgrep(cwd, query, timeoutMs);
	} catch {
		sources = await searchLocalFallback(cwd, query);
	}

	const summary = sources.length
		? `Local repo research found ${sources.length} match${sources.length === 1 ? "" : "es"} for "${query}".`
		: `No local repo matches found for "${query}".`;
	const content = sources.length
		? sources.map((source) => `- ${source.location}:${source.line} ${source.snippet}`).join("\n")
		: "No local matches.";

	return {
		ok: true,
		provider: "local",
		summary,
		content,
		sources,
	};
}

async function runSearxngQuery(query, fetchImpl, env = process.env) {
	const baseUrl = env.AUTODEVELOP_SEARXNG_URL?.trim();
	if (!baseUrl) {
		return { ok: false, provider: "searxng", reason: "SearXNG is not configured." };
	}

	try {
		const params = new URLSearchParams({ q: query, format: "json" });
		const timeoutMs = getTimeoutMs(env);
		const payload = await fetchJson(joinUrl(baseUrl, `/search?${params.toString()}`), { signal: buildTimeoutSignal(timeoutMs) }, fetchImpl);
		const results = ensureArray(payload.results).slice(0, MAX_WEB_RESULTS);
		const sources = results.map((result) => ({
			kind: "url",
			location: result.url ?? "",
			title: result.title ?? result.url ?? "Untitled",
			snippet: summarizeSnippet(result.content ?? result.snippet ?? ""),
		}));
		const summary = sources.length
			? `SearXNG returned ${sources.length} web result${sources.length === 1 ? "" : "s"} for "${query}".`
			: `SearXNG returned no web results for "${query}".`;
		const content = sources.length
			? sources.map((source) => `- ${source.title}: ${source.location}\n  ${source.snippet}`).join("\n")
			: "No SearXNG results.";
		return {
			ok: true,
			provider: "searxng",
			summary,
			content,
			sources,
		};
	} catch (error) {
		return {
			ok: false,
			provider: "searxng",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

async function runPinchtabQuery(query, fetchImpl, env = process.env) {
	const baseUrl = env.AUTODEVELOP_PINCHTAB_URL?.trim();
	if (!baseUrl) {
		return { ok: false, provider: "pinchtab", reason: "PinchTab is not configured." };
	}

	const template = env.AUTODEVELOP_PINCHTAB_SEARCH_URL_TEMPLATE?.trim();
	if (!template?.includes("{query}")) {
		return { ok: false, provider: "pinchtab", reason: "PinchTab search template is not configured." };
	}

	try {
		const timeoutMs = getTimeoutMs(env);
		const headers = {
			"content-type": "application/json",
			...getPinchtabHeaders(env),
		};
		const url = template.replaceAll("{query}", encodeURIComponent(query));
		const navigateResponse = await fetchImpl(joinUrl(baseUrl, "/navigate"), {
			method: "POST",
			headers,
			body: JSON.stringify({ url }),
			signal: buildTimeoutSignal(timeoutMs),
		});
		if (!navigateResponse.ok) {
			throw new Error(`navigate failed with HTTP ${navigateResponse.status}`);
		}

		const payload = await fetchJson(
			joinUrl(baseUrl, `/text?mode=raw&maxChars=${MAX_FETCH_CHARS}`),
			{ headers: getPinchtabHeaders(env), signal: buildTimeoutSignal(timeoutMs) },
			fetchImpl,
		);
		const text = truncate(payload.text ?? "");
		return {
			ok: true,
			provider: "pinchtab",
			summary: `PinchTab extracted browser text for "${query}".`,
			content: createTextContent(payload.title ?? payload.url ?? "", text),
			sources: [
				{
					kind: "url",
					location: payload.url ?? url,
					title: payload.title ?? payload.url ?? "PinchTab page",
					snippet: summarizeSnippet(text),
				},
			],
		};
	} catch (error) {
		return {
			ok: false,
			provider: "pinchtab",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

async function fetchLocalFile(cwd, target) {
	const candidatePath = resolve(cwd, target);
	const realPath = await realpath(candidatePath);
	const info = await stat(realPath);
	if (!info.isFile()) {
		throw new Error(`Target is not a file: ${realPath}`);
	}
	if (info.size > MAX_FILE_BYTES) {
		throw new Error(`File is too large to fetch safely: ${realPath}`);
	}

	const text = truncate(await readFile(realPath, "utf8"));
	return {
		provider: "local",
		summary: `Fetched local file ${realPath}.`,
		content: createTextContent(realPath, text),
		sources: [
			{
				kind: "file",
				location: realPath,
				title: realPath,
				snippet: summarizeSnippet(text),
			},
		],
	};
}

async function fetchUrl(target, fetchImpl, env = process.env) {
	const timeoutMs = getTimeoutMs(env);
	const response = await fetchImpl(target, { signal: buildTimeoutSignal(timeoutMs) });
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
	}
	const text = truncate(await response.text());
	return {
		provider: "direct_http",
		summary: `Fetched URL ${target}.`,
		content: createTextContent(target, text),
		sources: [
			{
				kind: "url",
				location: target,
				title: target,
				snippet: summarizeSnippet(text),
			},
		],
	};
}

function fetchArtifact(state, artifactId) {
	const artifact = state?.researchArtifacts?.find((candidate) => candidate.id === artifactId);
	if (!artifact) {
		throw new Error(`Research artifact not found: ${artifactId}`);
	}

	return {
		provider: artifact.provider,
		summary: `Fetched prior research artifact ${artifactId}.`,
		content: artifact.content ?? artifact.summary ?? "",
		sources: ensureArray(artifact.sources),
	};
}

function createArtifact(result, params, state) {
	const refs = collectObjectiveRefs(params.objectiveRefs, state);
	return {
		id: buildArtifactId("research", params.query ?? params.target ?? result.provider),
		createdAt: new Date().toISOString(),
		action: params.action,
		scope: params.scope ?? "auto",
		provider: result.provider,
		query: params.query?.trim() ?? "",
		target: params.target?.trim() ?? "",
		summary: result.summary ?? "",
		content: truncate(result.content ?? ""),
		sources: ensureArray(result.sources),
		objectiveRefs: refs,
	};
}

export async function runResearchAction({
	params,
	cwd,
	state,
	env = process.env,
	fetchImpl = fetch,
} = {}) {
	const providers = await probeResearchProviders({ env, fetchImpl });
	const scope = params.scope ?? "auto";
	const timeoutMs = getTimeoutMs(env);

	if (params.action === "health") {
		return {
			artifact: null,
			providers,
			fallbackOrder: buildProviderOrder(scope),
			result: {
				ok: true,
				provider: "system",
				summary: `Research providers ready. Order: ${buildProviderOrder(scope).join(" -> ")}`,
				content: [
					`local: ${providers.local.healthy ? "healthy" : "unavailable"} (${providers.local.description})`,
					`searxng: ${providers.searxng.healthy ? "healthy" : "unavailable"} (${providers.searxng.description})`,
					`pinchtab: ${providers.pinchtab.healthy ? "healthy" : "unavailable"} (${providers.pinchtab.description})`,
				].join("\n"),
				sources: [],
			},
		};
	}

	if (params.action === "query") {
		const query = params.query?.trim();
		if (!query) {
			throw new Error("query is required for autodevelop_research action=query");
		}

		const failures = [];
		for (const provider of buildProviderOrder(scope)) {
			if (provider === "local") {
				const result = await runLocalQuery(cwd, query, timeoutMs);
				const artifact = createArtifact(result, { ...params, query }, state);
				return { artifact, providers, fallbackOrder: buildProviderOrder(scope), result };
			}

			if (provider === "searxng") {
				const result = await runSearxngQuery(query, fetchImpl, env);
				if (result.ok) {
					const artifact = createArtifact(result, { ...params, query }, state);
					return { artifact, providers, fallbackOrder: buildProviderOrder(scope), result };
				}
				failures.push(`searxng: ${result.reason}`);
			}

			if (provider === "pinchtab") {
				const result = await runPinchtabQuery(query, fetchImpl, env);
				if (result.ok) {
					const artifact = createArtifact(result, { ...params, query }, state);
					return { artifact, providers, fallbackOrder: buildProviderOrder(scope), result };
				}
				failures.push(`pinchtab: ${result.reason}`);
			}
		}

		return {
			artifact: null,
			providers,
			fallbackOrder: buildProviderOrder(scope),
			result: {
				ok: false,
				provider: "system",
				summary: `No ${scope === "web" ? "web" : "additional"} research provider is available for "${query}".`,
				content: failures.length ? failures.join("\n") : "No provider could satisfy the request.",
				sources: [],
			},
		};
	}

	if (params.action === "fetch") {
		if (!params.target?.trim() && !params.artifactId?.trim()) {
			throw new Error("target or artifactId is required for autodevelop_research action=fetch");
		}

		let result;
		if (params.artifactId?.trim()) {
			result = fetchArtifact(state, params.artifactId.trim());
		} else if (/^https?:\/\//i.test(params.target.trim())) {
			result = await fetchUrl(params.target.trim(), fetchImpl, env);
		} else {
			result = await fetchLocalFile(cwd, params.target.trim());
		}

		const artifact = createArtifact(result, params, state);
		return {
			artifact,
			providers,
			fallbackOrder: buildProviderOrder(scope),
			result: {
				ok: true,
				...result,
			},
		};
	}

	throw new Error(`Unsupported autodevelop_research action: ${params.action}`);
}

