import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { probeResearchProviders, runResearchAction } from "../extensions/autodevelop/lib/research.js";

function makeState() {
	return {
		currentItemId: "code-1",
		backlog: [{ id: "code-1", title: "Implement", kind: "code", objectiveRefs: ["reliability"] }],
		researchArtifacts: [],
	};
}

async function withServer(handler, fn) {
	const server = createServer(handler);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const baseUrl = `http://127.0.0.1:${address.port}`;

	try {
		return await fn(baseUrl);
	} finally {
		await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve(undefined))));
	}
}

test("local-only mode keeps builtin provider healthy", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "autodevelop-research-local-"));
	await writeFile(join(tempDir, "notes.md"), "chunking matters for large inputs\n", "utf8");

	const providers = await probeResearchProviders({ env: {} });
	assert.equal(providers.local.healthy, true);
	assert.equal(providers.searxng.configured, false);
	assert.equal(providers.pinchtab.configured, false);

	const result = await runResearchAction({
		params: { action: "query", scope: "auto", query: "chunking" },
		cwd: tempDir,
		state: makeState(),
		env: {},
	});

	assert.equal(result.result.provider, "local");
	assert.equal(result.artifact.provider, "local");
	assert.equal(result.artifact.objectiveRefs[0], "reliability");
});

test("searxng health and query path work when configured", async () => {
	await withServer((request, response) => {
		if (request.url.startsWith("/search")) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					results: [{ title: "Result", url: "https://example.com", content: "A useful search result" }],
				}),
			);
			return;
		}

		response.writeHead(404).end();
	}, async (baseUrl) => {
		const env = {
			AUTODEVELOP_SEARXNG_URL: baseUrl,
			AUTODEVELOP_RESEARCH_TIMEOUT_MS: "1000",
		};

		const providers = await probeResearchProviders({ env });
		assert.equal(providers.searxng.healthy, true);

		const result = await runResearchAction({
			params: { action: "query", scope: "web", query: "throughput patterns" },
			cwd: process.cwd(),
			state: makeState(),
			env,
		});

		assert.equal(result.result.provider, "searxng");
		assert.equal(result.artifact.provider, "searxng");
		assert.match(result.result.content, /Result/);
	});
});

test("pinchtab fallback is used when configured and needed", async () => {
	await withServer((request, response) => {
		if (request.url === "/health") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ status: "ok", tabs: 1 }));
			return;
		}

		if (request.url === "/navigate" && request.method === "POST") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: true }));
			return;
		}

		if (request.url.startsWith("/text")) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					url: "https://search.example?q=batching",
					title: "Search Page",
					text: "batching is recommended for large datasets",
					truncated: false,
				}),
			);
			return;
		}

		response.writeHead(404).end();
	}, async (baseUrl) => {
		const env = {
			AUTODEVELOP_PINCHTAB_URL: baseUrl,
			AUTODEVELOP_PINCHTAB_SEARCH_URL_TEMPLATE: "https://search.example?q={query}",
			AUTODEVELOP_RESEARCH_TIMEOUT_MS: "1000",
		};

		const providers = await probeResearchProviders({ env });
		assert.equal(providers.pinchtab.healthy, true);

		const result = await runResearchAction({
			params: { action: "query", scope: "web", query: "batching" },
			cwd: process.cwd(),
			state: makeState(),
			env,
		});

		assert.equal(result.result.provider, "pinchtab");
		assert.equal(result.artifact.provider, "pinchtab");
		assert.match(result.result.content, /large datasets/);
	});
});

test("web scope degrades cleanly when no external provider is available", async () => {
	const result = await runResearchAction({
		params: { action: "query", scope: "web", query: "external search" },
		cwd: process.cwd(),
		state: makeState(),
		env: {},
	});

	assert.equal(result.artifact, null);
	assert.equal(result.result.ok, false);
	assert.match(result.result.summary, /No web research provider is available/);
});

