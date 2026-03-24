import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { writeLoopStateCheckpoint } from "../extensions/autodevelop/lib/checkpoint.js";
import { readGoalSnapshot } from "../extensions/autodevelop/lib/goal.js";
import { acquireLoopLease, readLoopLease } from "../extensions/autodevelop/lib/lease.js";
import { applyStateAction, createInitialLoopState } from "../extensions/autodevelop/lib/state-machine.js";

registerHooks({
	resolve(specifier, context, nextResolve) {
		const stubMap = new Map([
			["@mariozechner/pi-ai", pathToFileURL(join(process.cwd(), "tests", "stubs", "pi-ai.mjs")).href],
			["@mariozechner/pi-coding-agent", pathToFileURL(join(process.cwd(), "tests", "stubs", "pi-coding-agent.mjs")).href],
			["@sinclair/typebox", pathToFileURL(join(process.cwd(), "tests", "stubs", "typebox.mjs")).href],
		]);
		if (stubMap.has(specifier)) {
			return {
				url: stubMap.get(specifier),
				shortCircuit: true,
			};
		}
		return nextResolve(specifier, context);
	},
});

const { default: autodevelopExtension } = await import("../extensions/autodevelop/index.ts");

function runGit(cwd, args) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	return result.stdout.trim();
}

function normalizePath(path) {
	return path.replace(/^\/private/, "");
}

async function createRepo() {
	const repoDir = await mkdtemp(join(tmpdir(), "autodevelop-extension-"));
	await mkdir(join(repoDir, ".pi", "autodevelop"), { recursive: true });
	await mkdir(join(repoDir, "src"), { recursive: true });
	await writeFile(join(repoDir, ".pi", "autodevelop", "goal.md"), "# Goal\n\nShip it.\n", "utf8");
	await writeFile(join(repoDir, "src", "app.js"), "export const value = 1;\n", "utf8");
	runGit(repoDir, ["init"]);
	runGit(repoDir, ["branch", "-M", "main"]);
	runGit(repoDir, ["config", "user.email", "autodevelop@example.com"]);
	runGit(repoDir, ["config", "user.name", "AutoDevelop"]);
	runGit(repoDir, ["add", "src/app.js"]);
	runGit(repoDir, ["commit", "-m", "initial"]);
	return repoDir;
}

async function makeCheckpointState(repoDir) {
	const goal = await readGoalSnapshot(repoDir, ".pi/autodevelop/goal.md");
	const state = createInitialLoopState(goal, undefined, {
		repoRoot: repoDir,
		branch: "main",
	});

	return applyStateAction(
		applyStateAction(state, "replace_plan", {
			items: [
				{
					id: "code-1",
					title: "Implement loop",
					kind: "code",
					status: "in_progress",
					acceptanceCriteria: "Command works",
				},
			],
		}),
		"set_phase",
		{ phase: "paused", currentItemId: "code-1" },
	);
}

function createHarness() {
	const commands = new Map();
	const tools = new Map();
	const eventHandlers = new Map();
	const builtinTools = ["read", "bash", "grep", "find", "ls", "edit", "write"].map((name) => ({ name }));
	const messages = [];
	const userMessages = [];
	const activeTools = [];
	const notifications = [];
	let activeSession = null;

	const api = {
		registerCommand(name, spec) {
			commands.set(name, spec);
		},
		registerTool(spec) {
			tools.set(spec.name, spec);
		},
		on(eventName, handler) {
			eventHandlers.set(eventName, handler);
		},
		sendMessage(message) {
			messages.push(message);
		},
		sendUserMessage(text) {
			userMessages.push(text);
		},
		appendEntry(customType, data) {
			assert.ok(activeSession, "appendEntry called without an active session");
			activeSession.branch.push({
				type: "custom",
				customType,
				data,
			});
		},
		getAllTools() {
			return [...builtinTools, ...tools.values()].map((tool) => ({ name: tool.name }));
		},
		setActiveTools(toolNames) {
			activeTools.push(toolNames);
		},
	};

	autodevelopExtension(api);

	function createContext({ sessionId, cwd, hasUI = false, confirmResult = true } = {}) {
		const branch = [];
		const statusByKey = new Map();
		const widgetByKey = new Map();
		const notificationLog = [];

		const ctx = {
			hasUI,
			cwd,
			ui: {
				select: async () => undefined,
				confirm: async () => confirmResult,
				input: async () => undefined,
				notify(message, type = "info") {
					notificationLog.push({ message, type });
					notifications.push({ sessionId, message, type });
				},
				setStatus(key, text) {
					statusByKey.set(key, text);
				},
				setWorkingMessage() {},
				setWidget(key, content) {
					widgetByKey.set(key, content);
				},
				setFooter() {},
				setHeader() {},
				setTitle() {},
				custom: async () => undefined,
				setEditorText() {},
				getEditorText() {
					return "";
				},
				editor: async () => undefined,
				setEditorComponent() {},
				theme: {},
				getAllThemes() {
					return [];
				},
				getTheme() {
					return undefined;
				},
				setTheme() {
					return { success: false };
				},
			},
			sessionManager: {
				getBranch() {
					return branch;
				},
				getSessionId() {
					return sessionId;
				},
				getSessionFile() {
					return join(cwd, ".pi", "sessions", `${sessionId}.jsonl`);
				},
			},
			modelRegistry: {
				async getApiKey() {
					return null;
				},
			},
			model: undefined,
			isIdle() {
				return true;
			},
			abort() {},
			hasPendingMessages() {
				return false;
			},
			shutdown() {},
			getContextUsage() {
				return undefined;
			},
			compact() {},
			waitForIdle: async () => undefined,
			newSession: async () => ({ cancelled: false }),
			fork: async () => ({ cancelled: false }),
			navigateTree: async () => ({ cancelled: false }),
			_branch: branch,
			_statusByKey: statusByKey,
			_widgetByKey: widgetByKey,
			_notificationLog: notificationLog,
		};

		return ctx;
	}

	async function callCommand(ctx, name, args = "") {
		activeSession = { id: ctx.sessionManager.getSessionId(), branch: ctx._branch };
		return commands.get(name).handler(args, ctx);
	}

	async function callTool(ctx, name, params) {
		activeSession = { id: ctx.sessionManager.getSessionId(), branch: ctx._branch };
		return tools.get(name).execute("tool-call", params, AbortSignal.timeout(1000), () => {}, ctx);
	}

	async function callEvent(ctx, name, event = {}) {
		activeSession = { id: ctx.sessionManager.getSessionId(), branch: ctx._branch };
		const handler = eventHandlers.get(name);
		if (!handler) return undefined;
		return handler(event, ctx);
	}

	return {
		createContext,
		callCommand,
		callTool,
		callEvent,
		messages,
		userMessages,
		activeTools,
		notifications,
	};
}

test("start creates a lease and checkpoint", async () => {
	const repoDir = await createRepo();
	const harness = createHarness();
	const ctx = harness.createContext({ sessionId: "session-start", cwd: repoDir });

	await harness.callCommand(ctx, "autodevelop", "start .pi/autodevelop/goal.md");

	const lease = await readLoopLease({ cwd: repoDir });
	const checkpoint = JSON.parse(await readFile(join(repoDir, ".pi", "autodevelop", "loop-state.json"), "utf8"));

	assert.equal(lease.sessionId, "session-start");
	assert.equal(normalizePath(checkpoint.state.goal.path), normalizePath(join(repoDir, ".pi", "autodevelop", "goal.md")));
	assert.equal(checkpoint.state.branch, "main");
	assert.equal(harness.userMessages.length, 1);
});

test("start refuses dirty non-runtime worktrees", async () => {
	const repoDir = await createRepo();
	await writeFile(join(repoDir, "src", "app.js"), "export const value = 2;\n", "utf8");
	const harness = createHarness();
	const ctx = harness.createContext({ sessionId: "session-start-dirty", cwd: repoDir });

	await harness.callCommand(ctx, "autodevelop", "start .pi/autodevelop/goal.md");

	assert.equal(ctx._notificationLog.length > 0, true);
	assert.match(ctx._notificationLog.at(-1).message, /uncommitted non-runtime changes/i);
});

test("resume restores from checkpoint when started from a repo subdirectory", async () => {
	const repoDir = await createRepo();
	const subdir = join(repoDir, "src", "feature");
	await mkdir(subdir, { recursive: true });
	await writeLoopStateCheckpoint(await makeCheckpointState(repoDir));

	const harness = createHarness();
	const ctx = harness.createContext({ sessionId: "session-resume", cwd: subdir });

	await harness.callCommand(ctx, "autodevelop", "resume");

	const lease = await readLoopLease({ cwd: repoDir });
	assert.equal(lease.sessionId, "session-resume");
	assert.equal(harness.userMessages.length, 1);
});

test("resume refuses to steal a fresh foreign lease", async () => {
	const repoDir = await createRepo();
	const state = await makeCheckpointState(repoDir);
	await writeLoopStateCheckpoint(state);
	await acquireLoopLease({
		cwd: repoDir,
		state,
		sessionId: "session-foreign",
		sessionFile: join(repoDir, ".pi", "sessions", "session-foreign.jsonl"),
		now: new Date("2026-03-24T12:00:00.000Z"),
	});

	const harness = createHarness();
	const ctx = harness.createContext({ sessionId: "session-local", cwd: repoDir });

	await harness.callCommand(ctx, "autodevelop", "resume");

	assert.equal(ctx._notificationLog.length > 0, true);
	assert.match(ctx._notificationLog.at(-1).message, /Another session owns the AutoDevelop workspace lease/);
	assert.equal(harness.userMessages.length, 0);
	const lease = await readLoopLease({ cwd: repoDir, state });
	assert.equal(lease.sessionId, "session-foreign");
});

test("recover explicitly steals a foreign lease", async () => {
	const repoDir = await createRepo();
	const state = await makeCheckpointState(repoDir);
	await writeLoopStateCheckpoint(state);
	await acquireLoopLease({
		cwd: repoDir,
		state,
		sessionId: "session-foreign",
		sessionFile: join(repoDir, ".pi", "sessions", "session-foreign.jsonl"),
		now: new Date("2026-03-24T12:00:00.000Z"),
	});

	const harness = createHarness();
	const ctx = harness.createContext({ sessionId: "session-local", cwd: repoDir, hasUI: false });

	await harness.callCommand(ctx, "autodevelop", "recover");

	const lease = await readLoopLease({ cwd: repoDir, state });
	assert.equal(lease.sessionId, "session-local");
	assert.equal(harness.userMessages.length, 1);
});

test("stop releases the owned lease", async () => {
	const repoDir = await createRepo();
	const harness = createHarness();
	const ctx = harness.createContext({ sessionId: "session-stop", cwd: repoDir });

	await harness.callCommand(ctx, "autodevelop", "start .pi/autodevelop/goal.md");
	await harness.callCommand(ctx, "autodevelop", "stop");

	await assert.rejects(access(join(repoDir, ".pi", "autodevelop", "lease.json"), fsConstants.F_OK));
});

test("session switch releases the old owned lease and hydrates the next session from checkpoint", async () => {
	const repoDir = await createRepo();
	const harness = createHarness();
	const sessionA = harness.createContext({ sessionId: "session-a", cwd: repoDir });
	const sessionB = harness.createContext({ sessionId: "session-b", cwd: repoDir });

	await harness.callCommand(sessionA, "autodevelop", "start .pi/autodevelop/goal.md");
	await harness.callEvent(sessionA, "session_before_switch");
	await assert.rejects(access(join(repoDir, ".pi", "autodevelop", "lease.json"), fsConstants.F_OK));

	await harness.callEvent(sessionB, "session_switch");
	await harness.callCommand(sessionB, "autodevelop", "status");

	assert.match(harness.messages.at(-1).content, /Current session owns lease: no/);
	assert.match(harness.messages.at(-1).content, /Goal: `/);
});

test("state mutations rewrite the checkpoint after generic autodevelop_state actions", async () => {
	const repoDir = await createRepo();
	const harness = createHarness();
	const ctx = harness.createContext({ sessionId: "session-state", cwd: repoDir });

	await harness.callCommand(ctx, "autodevelop", "start .pi/autodevelop/goal.md");
	await harness.callTool(ctx, "autodevelop_state", {
		action: "replace_plan",
		items: [{ id: "code-1", title: "Implement loop", kind: "code", status: "pending", acceptanceCriteria: "Command works" }],
	});
	let checkpoint = JSON.parse(await readFile(join(repoDir, ".pi", "autodevelop", "loop-state.json"), "utf8"));
	assert.equal(checkpoint.state.backlog[0].id, "code-1");

	await harness.callTool(ctx, "autodevelop_state", {
		action: "update_item",
		itemId: "code-1",
		patch: { status: "in_progress", notes: "Working" },
	});
	checkpoint = JSON.parse(await readFile(join(repoDir, ".pi", "autodevelop", "loop-state.json"), "utf8"));
	assert.equal(checkpoint.state.currentItemId, "code-1");
	assert.equal(checkpoint.state.backlog[0].notes, "Working");

	await harness.callTool(ctx, "autodevelop_state", {
		action: "block",
		reason: "Blocked in test",
	});
	checkpoint = JSON.parse(await readFile(join(repoDir, ".pi", "autodevelop", "loop-state.json"), "utf8"));
	assert.equal(checkpoint.state.lastFailure, "Blocked in test");
});

test("complete creates a git commit, excludes runtime files, and relaunches the next cycle", async () => {
	const repoDir = await createRepo();
	const harness = createHarness();
	const ctx = harness.createContext({ sessionId: "session-complete", cwd: repoDir });

	await harness.callCommand(ctx, "autodevelop", "start .pi/autodevelop/goal.md");
	await harness.callEvent(ctx, "input", { source: "extension", text: harness.userMessages.at(-1) });
	await writeFile(join(repoDir, "src", "app.js"), "export const value = 2;\n", "utf8");
	await writeFile(join(repoDir, ".pi", "autodevelop", "local-note.md"), "runtime only\n", "utf8");
	await harness.callTool(ctx, "autodevelop_state", {
		action: "replace_plan",
		items: [{ id: "code-1", title: "Implement loop", kind: "code", status: "done", acceptanceCriteria: "Command works" }],
	});
	await harness.callTool(ctx, "autodevelop_state", {
		action: "complete",
		summary: "Ship the first cycle",
	});

	const subject = runGit(repoDir, ["log", "-1", "--pretty=%s"]);
	const files = runGit(repoDir, ["show", "--name-only", "--format=", "HEAD"]).split(/\r?\n/).filter(Boolean);
	const checkpoint = JSON.parse(await readFile(join(repoDir, ".pi", "autodevelop", "loop-state.json"), "utf8"));

	assert.match(subject, /^autodevelop: cycle 1 - Ship the first cycle$/);
	assert.deepEqual(files, ["src/app.js"]);
	assert.equal(checkpoint.state.cycleNumber, 2);
	assert.equal(checkpoint.state.lastCycleSummary, "Ship the first cycle");
	assert.equal(checkpoint.state.lastCycleNoop, false);
	assert.equal(checkpoint.state.backlog.length, 0);
	assert.equal(harness.userMessages.length >= 2, true);
});

test("complete without commit-worthy changes records a no-op cycle and schedules retry", async () => {
	const repoDir = await createRepo();
	const harness = createHarness();
	const ctx = harness.createContext({ sessionId: "session-noop", cwd: repoDir });

	await harness.callCommand(ctx, "autodevelop", "start .pi/autodevelop/goal.md");
	await harness.callTool(ctx, "autodevelop_state", {
		action: "replace_plan",
		items: [{ id: "code-1", title: "Implement loop", kind: "code", status: "done", acceptanceCriteria: "Command works" }],
	});
	await harness.callTool(ctx, "autodevelop_state", {
		action: "complete",
		summary: "Cycle had no repo changes",
	});

	const subject = runGit(repoDir, ["log", "-1", "--pretty=%s"]);
	const checkpoint = JSON.parse(await readFile(join(repoDir, ".pi", "autodevelop", "loop-state.json"), "utf8"));

	assert.equal(subject, "initial");
	assert.equal(checkpoint.state.cycleNumber, 2);
	assert.equal(checkpoint.state.lastCycleNoop, true);
	assert.match(checkpoint.state.nextCycleAt, /T/);
	assert.equal(checkpoint.state.phase, "relaunching");
});
