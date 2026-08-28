import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readAgentHistory, TERMINAL_RUN_ENTRY_TYPE } from "../history.ts";
import { modelParameterDescription, registerSubAgentExtension } from "../index.ts";
import { AgentManager } from "../manager.ts";
import { createInitialProgress } from "../runner.ts";
import type {
	AgentRunConfig,
	AgentRunner,
	RunnerProgress,
	RunnerResult,
	RunningAgentProcess,
} from "../types.ts";

type Handler = (event: any, ctx: any) => unknown;

class FakeExtensionApi {
	readonly handlers = new Map<string, Handler[]>();
	readonly tools = new Map<string, any>();
	readonly entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];

	on(event: string, handler: Handler): void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
	}

	registerTool(tool: any): void {
		this.tools.set(tool.name, tool);
	}

	registerCommand(): void {}

	appendEntry(customType: string, data: unknown): string {
		this.entries.push({ type: "custom", customType, data });
		return `custom-${this.entries.length}`;
	}

	async emit(event: string, value: any, ctx: any = {}): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) await handler(value, ctx);
	}
}

class FakeRunner implements AgentRunner {
	readonly cancelCalls = new Map<string, number>();
	private readonly resolvers = new Map<string, (result: RunnerResult) => void>();

	start(config: AgentRunConfig, _onProgress: (progress: RunnerProgress) => void): RunningAgentProcess {
		let resolve!: (result: RunnerResult) => void;
		let cancelled = false;
		const result = new Promise<RunnerResult>((done) => {
			resolve = done;
		});
		this.resolvers.set(config.id, resolve);
		return {
			result,
			cancel: () => {
				this.cancelCalls.set(config.id, (this.cancelCalls.get(config.id) ?? 0) + 1);
				if (cancelled) return;
				cancelled = true;
				resolve({
					exitCode: 0,
					signal: null,
					stderr: "",
					progress: createInitialProgress(),
					timedOut: false,
				});
			},
		};
	}

	complete(id: string, overrides: Partial<RunnerProgress> = {}): void {
		const progress = createInitialProgress();
		progress.finalOutput = "done";
		progress.liveOutput = "done";
		progress.finalAssistantSeen = true;
		progress.agentSettled = true;
		Object.assign(progress, overrides);
		this.resolvers.get(id)?.({ exitCode: 0, signal: null, stderr: "", progress, timedOut: false });
	}
}

function ids(): () => string {
	const values = ["aaaaaa", "bbbbbb", "cccccc", "dddddd", "eeeeee", "ffffff"];
	let sequence = 100;
	return () => values.shift() ?? (sequence++).toString(36).padStart(6, "0").slice(-6);
}

function request(originEntryId: string, parentRunId: string) {
	return {
		originEntryId,
		parentRunId,
		prompt: "task",
		model: "provider/model",
		thinking: "low" as const,
		cwd: "/repo",
		access: "read" as const,
	};
}

function setup(maxConcurrency = 10, maxTerminalRuns = 20) {
	const api = new FakeExtensionApi();
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, { idFactory: ids(), maxConcurrency, maxTerminalRuns });
	registerSubAgentExtension(api as unknown as ExtensionAPI, {
		manager,
		parentRunIdFactory: (() => {
			let sequence = 0;
			return () => `parent-${++sequence}`;
		})(),
	});
	return { api, manager, runner };
}

async function tick(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

test("agent_spawn model parameter lists only scoped models", async () => {
	const { api, manager } = setup();
	const context = {
		scopedModels: [
			{ model: { provider: "openai-codex", id: "gpt-5.6-sol" } },
			{ model: { provider: "openai-codex", id: "gpt-5.6-luna" } },
		],
		modelRegistry: {
			getAvailable: () => {
				throw new Error("must not enumerate all available models");
			},
		},
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
		},
		ui: { setStatus: () => {} },
	};

	await api.emit("session_start", { type: "session_start", reason: "startup" }, context);

	assert.equal(
		api.tools.get("agent_spawn")?.parameters.properties.model.description,
		[
			"Exact provider/model identifier. Defaults to the parent model.",
			"Scoped models:",
			"- openai-codex/gpt-5.6-sol",
			"- openai-codex/gpt-5.6-luna",
		].join("\n"),
	);
	await api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);
	await manager.shutdown();
});

test("empty model scope does not expose alternative models", () => {
	assert.equal(
		modelParameterDescription([]),
		"Exact provider/model identifier. Defaults to the parent model.",
	);
});

test("agent_spawn publicly exposes read, bash, and write access semantics", async () => {
	const { api, manager } = setup();
	const spawnTool = api.tools.get("agent_spawn");
	assert.ok(spawnTool);
	const accessSchema = spawnTool.parameters.properties.access;
	assert.deepEqual(accessSchema.enum, ["read", "bash", "write"]);
	assert.equal(accessSchema.default, "read");
	assert.match(accessSchema.description, /bash: read, bash, grep, find, ls for non-mutating commands/u);
	assert.match(spawnTool.description, /write agents sharing a working directory/u);
	await manager.shutdown();
});

test("parent abort leaves background sub-agents running", async () => {
	const { api, manager } = setup();
	await api.emit("agent_start", { type: "agent_start" });
	const run = manager.spawn(request("assistant-1", "parent-1"));

	await api.emit("agent_end", {
		type: "agent_end",
		messages: [{ role: "toolResult" }, { role: "assistant", stopReason: "aborted" }],
	});
	await tick();

	assert.equal(manager.get(run.id)?.status, "running");
	await manager.shutdown();
});

test("successful tree navigation cancels abandoned runs and preserves ancestor-owned runs", async () => {
	const { api, manager } = setup();
	const ancestor = manager.spawn(request("root", "parent-1"));
	const abandoned = manager.spawn(request("branch-a", "parent-1"));

	assert.equal(manager.get(abandoned.id)?.status, "running");
	assert.equal(api.handlers.has("session_before_tree"), false);
	await api.emit(
		"session_tree",
		{ type: "session_tree", oldLeafId: "branch-a", newLeafId: "branch-b" },
		{ sessionManager: { getBranch: () => [{ id: "root" }, { id: "branch-b" }] } },
	);
	await tick();

	assert.equal(manager.get(ancestor.id)?.status, "running");
	assert.equal(manager.get(abandoned.id)?.status, "cancelled");
	await api.emit(
		"session_tree",
		{ type: "session_tree", oldLeafId: "branch-a", newLeafId: "branch-b" },
		{ sessionManager: { getBranch: () => [{ id: "root" }, { id: "branch-b" }] } },
	);
	assert.equal(manager.get(abandoned.id)?.status, "cancelled");
	await manager.shutdown();
});

test("tree cleanup cancels a child left running after parent abort", async () => {
	const { api, manager, runner } = setup();
	await api.emit("agent_start", { type: "agent_start" });
	const run = manager.spawn(request("branch-a", "parent-1"));

	await api.emit("agent_end", {
		type: "agent_end",
		messages: [{ role: "assistant", stopReason: "aborted" }],
	});
	assert.equal(manager.get(run.id)?.status, "running");
	assert.equal(runner.cancelCalls.get(run.id), undefined);

	await api.emit(
		"session_tree",
		{ type: "session_tree", oldLeafId: "branch-a", newLeafId: "branch-b" },
		{ sessionManager: { getBranch: () => [{ id: "branch-b" }] } },
	);
	await tick();

	assert.equal(runner.cancelCalls.get(run.id), 1);
	assert.equal(manager.get(run.id)?.status, "cancelled");
	await manager.shutdown();
});

test("footer follows branch scope and shutdown still cancels every branch", async () => {
	const { api, manager } = setup();
	const branchA = manager.spawn(request("branch-a", "parent-1"));
	const branchASecond = manager.spawn(request("branch-a", "parent-1"));
	const branchB = manager.spawn(request("branch-b", "parent-2"));
	let branch = [{ id: "root" }, { id: "branch-a" }];
	const statuses: Array<string | undefined> = [];
	const context = {
		scopedModels: [],
		sessionManager: { getBranch: () => branch, getEntries: () => api.entries },
		ui: { setStatus: (_key: string, value: string | undefined) => statuses.push(value) },
	};

	await api.emit("session_start", { type: "session_start", reason: "startup" }, context);
	assert.equal(statuses.at(-1), "Agents: 2 running");
	branch = [{ id: "root" }, { id: "branch-b" }];
	await api.emit(
		"session_tree",
		{ type: "session_tree", oldLeafId: "branch-a", newLeafId: "branch-b" },
		context,
	);
	assert.equal(statuses.at(-1), "Agents: 1 running");

	await api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);
	assert.equal(statuses.at(-1), undefined);
	assert.equal(manager.get(branchA.id)?.status, "cancelled");
	assert.equal(manager.get(branchASecond.id)?.status, "cancelled");
	assert.equal(manager.get(branchB.id)?.status, "cancelled");
	assert.equal(api.entries.length, 3);
	assert.ok(readAgentHistory(api.entries).runs.every((run) => run.status === "cancelled"));
});

test("terminal runs persist without agent_wait and restore from session history", async () => {
	const { api, manager, runner } = setup();
	const context = {
		scopedModels: [],
		sessionManager: {
			getBranch: () => [{ id: "assistant-1" }],
			getEntries: () => api.entries,
		},
		ui: { setStatus: () => {} },
	};
	await api.emit("session_start", { type: "session_start", reason: "startup" }, context);
	const run = manager.spawn(request("assistant-1", "parent-1"));

	runner.complete(run.id);
	await tick();

	assert.equal(api.entries.length, 1);
	assert.equal(api.entries[0]?.customType, TERMINAL_RUN_ENTRY_TYPE);
	const history = readAgentHistory(api.entries);
	assert.equal(history.runs[0]?.id, run.id);
	assert.equal(history.runs[0]?.status, "completed");
	assert.equal(history.runs[0]?.finalOutput, "done");

	await api.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context);
	assert.equal(api.entries.length, 1);
});

test("agent_status replaces agent_wait and requires wait", () => {
	const { api, manager } = setup();
	assert.equal(api.tools.has("agent_wait"), false);
	const statusTool = api.tools.get("agent_status");
	assert.ok(statusTool);
	assert.ok(statusTool.parameters.required.includes("wait"));
	void manager.shutdown();
});

test("aborting agent_status wait stops only the wait", async () => {
	const { api, manager, runner } = setup(1);
	const running = manager.spawn(request("branch-a", "parent-1"));
	const queued = manager.spawn(request("branch-a", "parent-1"));
	const statusTool = api.tools.get("agent_status");
	assert.ok(statusTool);
	const controller = new AbortController();
	const context = { sessionManager: { getBranch: () => [{ id: "branch-a" }] } };
	const waiting = statusTool.execute(
		"status-1",
		{ ids: [running.id, queued.id], wait: true },
		controller.signal,
		undefined,
		context,
	);
	controller.abort();

	await assert.rejects(waiting, { name: "AbortError" });
	await tick();
	assert.equal(manager.get(running.id)?.status, "running");
	assert.equal(manager.get(queued.id)?.status, "queued");
	assert.equal(runner.cancelCalls.size, 0);
	await manager.shutdown();
});

test("agent_status snapshots immediately, preserves input order, and deduplicates IDs", async () => {
	const { api, manager } = setup(2);
	const first = manager.spawn(request("branch-a", "parent-1"));
	const second = manager.spawn(request("branch-a", "parent-1"));
	const statusTool = api.tools.get("agent_status");
	const context = { sessionManager: { getBranch: () => [{ id: "branch-a" }] } };
	const result = await statusTool.execute(
		"status-1",
		{ ids: [second.id, first.id, second.id], wait: false },
		undefined,
		undefined,
		context,
	);

	assert.equal(result.details.waited, false);
	assert.equal(result.details.allTerminal, false);
	assert.deepEqual(result.details.agents.map((run: any) => run.id), [second.id, first.id]);
	assert.deepEqual(JSON.parse(result.content[0].text).agents.map((run: any) => run.id), [second.id, first.id]);
	await manager.shutdown();
});

test("agent_status validates branch-visible IDs before waiting", async () => {
	const { api, manager, runner } = setup(1);
	const visible = manager.spawn(request("branch-a", "parent-1"));
	const hidden = manager.spawn(request("branch-b", "parent-1"));
	const statusTool = api.tools.get("agent_status");
	const context = { sessionManager: { getBranch: () => [{ id: "branch-a" }] } };

	await assert.rejects(
		statusTool.execute(
			"status-1",
			{ ids: [visible.id, hidden.id], wait: true },
			undefined,
			undefined,
			context,
		),
		new RegExp(`Unknown sub-agent ID: ${hidden.id}`, "u"),
	);
	assert.equal(manager.get(visible.id)?.status, "running");
	assert.equal(runner.cancelCalls.size, 0);
	await manager.shutdown();
});

test("agent_status wait returns mixed terminal results and attributes usage once", async () => {
	const { api, manager, runner } = setup(2);
	const first = manager.spawn(request("branch-a", "parent-1"));
	const second = manager.spawn(request("branch-a", "parent-1"));
	const statusTool = api.tools.get("agent_status");
	const context = { sessionManager: { getBranch: () => [{ id: "branch-a" }] } };
	const waiting = statusTool.execute(
		"status-1",
		{ ids: [first.id, second.id], wait: true },
		undefined,
		undefined,
		context,
	);
	const pricedUsage = {
		input: 10,
		output: 2,
		cacheRead: 3,
		cacheWrite: 1,
		totalTokens: 16,
		cost: { input: 0.02, output: 0.04, cacheRead: 0.01, cacheWrite: 0.01, total: 0.08 },
	};
	runner.complete(second.id, { usage: pricedUsage });
	runner.complete(first.id, { usage: pricedUsage });
	const result = await waiting;
	assert.equal(result.details.waited, true);
	assert.equal(result.details.allTerminal, true);
	assert.deepEqual(result.details.agents.map((run: any) => run.id), [first.id, second.id]);
	assert.deepEqual(result.details.agents.map((run: any) => run.usage), [pricedUsage, pricedUsage]);
	assert.deepEqual(result.details.attributedIds, [first.id, second.id]);
	assert.deepEqual(result.usage, {
		input: 20,
		output: 4,
		cacheRead: 6,
		cacheWrite: 2,
		totalTokens: 32,
		cost: { input: 0.04, output: 0.08, cacheRead: 0.02, cacheWrite: 0.02, total: 0.16 },
	});

	const repeated = await statusTool.execute(
		"status-2",
		{ ids: [first.id, second.id], wait: false },
		undefined,
		undefined,
		context,
	);
	assert.deepEqual(repeated.details.attributedIds, []);
	assert.equal(repeated.usage, undefined);
	await manager.shutdown();
});

test("failed agent_status projection does not consume usage attribution", async () => {
	const { api, manager, runner } = setup(120, 200);
	const runs = Array.from({ length: 120 }, () => manager.spawn(request("branch-a", "parent-1")));
	const usage = {
		input: 10,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 12,
		cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
	};
	for (const run of runs) runner.complete(run.id, { usage });
	await tick();
	const statusTool = api.tools.get("agent_status");
	const context = { sessionManager: { getBranch: () => [{ id: "branch-a" }] } };
	await assert.rejects(
		statusTool.execute(
			"status-large",
			{ ids: runs.map((run) => run.id), wait: false },
			undefined,
			undefined,
			context,
		),
		/metadata exceeds the 50 KB response limit/u,
	);

	const retry = await statusTool.execute(
		"status-small",
		{ ids: [runs[0]!.id], wait: false },
		undefined,
		undefined,
		context,
	);
	assert.deepEqual(retry.details.attributedIds, [runs[0]!.id]);
	assert.equal(retry.usage.totalTokens, 12);
	await manager.shutdown();
});

test("agent_cancel explicitly cancels selected active runs", async () => {
	const { api, manager, runner } = setup(1);
	const running = manager.spawn(request("branch-a", "parent-1"));
	const queued = manager.spawn(request("branch-a", "parent-1"));
	const cancelTool = api.tools.get("agent_cancel");
	assert.ok(cancelTool);

	const result = await cancelTool.execute("cancel-1", { ids: [running.id, queued.id] });
	await tick();

	assert.deepEqual(result.details.cancelledIds, [running.id, queued.id]);
	assert.equal(manager.get(running.id)?.status, "cancelled");
	assert.equal(manager.get(queued.id)?.status, "cancelled");
	assert.equal(runner.cancelCalls.get(running.id), 1);
	await manager.shutdown();
});

test("agent_cancel validates all IDs before cancelling", async () => {
	const { api, manager, runner } = setup();
	const running = manager.spawn(request("branch-a", "parent-1"));
	const cancelTool = api.tools.get("agent_cancel");
	assert.ok(cancelTool);

	await assert.rejects(
		cancelTool.execute("cancel-1", { ids: [running.id, "unknown"] }),
		/Unknown sub-agent ID: unknown/u,
	);
	assert.equal(manager.get(running.id)?.status, "running");
	assert.equal(runner.cancelCalls.size, 0);
	await manager.shutdown();
});

test("agent_start binds sibling agent_spawn calls without parent-abort cleanup", async () => {
	const { api, manager } = setup();
	const spawnTool = api.tools.get("agent_spawn");
	assert.ok(spawnTool);
	await api.emit("agent_start", { type: "agent_start" });
	const context = {
		cwd: process.cwd(),
		model: { provider: "provider", id: "model" },
		thinkingLevel: "off",
		modelRegistry: {
			find: () => ({ provider: "provider", id: "model", reasoning: false }),
			getApiKeyAndHeaders: async () => ({ ok: true }),
		},
		sessionManager: {
			getLeafId: () => "assistant-1",
		},
	};

	const first = await spawnTool.execute("spawn-1", { prompt: "one" }, undefined, undefined, context);
	const second = await spawnTool.execute("spawn-2", { prompt: "two" }, undefined, undefined, context);
	const firstRun = manager.get(first.details.run.id);
	const secondRun = manager.get(second.details.run.id);
	assert.equal(firstRun?.originEntryId, "assistant-1");
	assert.equal(firstRun?.parentRunId, "parent-1");
	assert.equal(secondRun?.parentRunId, "parent-1");

	await assert.rejects(
		spawnTool.execute(
			"spawn-3",
			{ prompt: "three" },
			undefined,
			undefined,
			{ ...context, sessionManager: { getLeafId: () => null } },
		),
		/persisted session origin/u,
	);
	await api.emit("agent_end", {
		type: "agent_end",
		messages: [{ role: "assistant", stopReason: "aborted" }],
	});
	await tick();
	assert.equal(manager.get(firstRun!.id)?.status, "running");
	assert.equal(manager.get(secondRun!.id)?.status, "running");
	await manager.shutdown();
});
