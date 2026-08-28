import assert from "node:assert/strict";
import test from "node:test";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import {
	mergeAgentRuns,
	persistedTerminalRun,
	readAgentHistory,
	TERMINAL_RUN_ENTRY_TYPE,
	TERMINAL_RUN_ENTRY_VERSION,
} from "../history.ts";
import { observationFromSnapshot } from "../render.ts";
import type { AgentSnapshot, AgentStatus } from "../types.ts";

function snapshot(id: string, status: AgentStatus = "running"): AgentSnapshot {
	return {
		id,
		originEntryId: "assistant-1",
		parentRunId: "parent-1",
		name: "worker",
		prompt: "task",
		model: "provider/model",
		thinking: "low",
		cwd: "/repo",
		access: "read",
		status,
		createdAt: 10,
		...(status === "running" ? { startedAt: 11 } : { startedAt: 11, endedAt: 20 }),
		steerCount: 0,
		revision: 3,
		lastProgressAt: status === "running" ? 15 : 20,
		phase: { kind: status === "running" ? "thinking" : status, startedAt: 14 },
		activeOperations: [],
		recentOperations: [],
		currentActivity: status,
		turns: 1,
		usage: {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		},
		tokensPerSecond15s: 4.2,
		finalOutput: status === "running" ? undefined : "done",
		liveOutput: "streaming output",
		stderr: "",
		activity: [],
	};
}

function spawnEntry(run: AgentSnapshot): unknown {
	return {
		type: "message",
		message: { role: "toolResult", toolName: "agent_spawn", details: { run } },
	};
}

function steerEntry(run: AgentSnapshot): unknown {
	return {
		type: "message",
		message: { role: "toolResult", toolName: "agent_steer", details: { run } },
	};
}

test("session history marks spawns without terminal records as interrupted", () => {
	const history = readAgentHistory([spawnEntry(snapshot("aaaaaa"))]);

	assert.equal(history.runs.length, 1);
	assert.equal(history.runs[0]?.status, "interrupted");
	assert.equal(history.runs[0]?.currentActivity, "interrupted");
	assert.match(history.runs[0]?.error ?? "", /before recording a terminal result/u);
});

test("terminal custom entries persist final snapshots, context, and steering metadata without duplicate live output", () => {
	const completed = {
		...snapshot("aaaaaa", "completed"),
		contextWindow: 200_000,
		contextTokens: 24_600,
		steerCount: 2,
		lastSteeredAt: 18,
	};
	const data = persistedTerminalRun(completed);
	const history = readAgentHistory([
		{ type: "custom", customType: TERMINAL_RUN_ENTRY_TYPE, data },
		spawnEntry(snapshot("aaaaaa")),
		{ type: "custom", customType: TERMINAL_RUN_ENTRY_TYPE, data: { version: 99, run: completed } },
	]);

	assert.equal(data.version, TERMINAL_RUN_ENTRY_VERSION);
	assert.equal(data.run.liveOutput, "");
	assert.equal(data.run.tokensPerSecond15s, undefined);
	assert.equal(history.runs[0]?.status, "completed");
	assert.equal(history.runs[0]?.finalOutput, "done");
	assert.equal(history.runs[0]?.steerCount, 2);
	assert.equal(history.runs[0]?.lastSteeredAt, 18);
	assert.equal(history.runs[0]?.contextWindow, 200_000);
	assert.equal(history.runs[0]?.contextTokens, 24_600);
	assert.deepEqual([...history.persistedTerminalIds], ["aaaaaa"]);
});

test("terminal history accepts bash access and remains compatible with prior access modes", () => {
	const runs = [
		{ ...snapshot("aaaaaa", "completed"), access: "read" as const },
		{ ...snapshot("bbbbbb", "completed"), access: "bash" as const },
		{ ...snapshot("cccccc", "completed"), access: "write" as const },
	];
	const history = readAgentHistory(runs.map((run, index) => ({
		type: "custom",
		customType: TERMINAL_RUN_ENTRY_TYPE,
		data: { version: index === 0 ? 1 : 2, run },
	})));
	assert.deepEqual(history.runs.map((run) => run.access), ["read", "bash", "write"]);
	assert.ok(history.runs.every((run) => run.contextWindow === undefined && run.contextTokens === undefined));
});

test("version 1 terminal entries restore with normalized structured timing", () => {
	const completed = snapshot("aaaaaa", "completed");
	const {
		revision: _revision,
		lastProgressAt: _lastProgressAt,
		phase: _phase,
		activeOperations: _activeOperations,
		recentOperations: _recentOperations,
		steerCount: _steerCount,
		...versionOne
	} = completed;
	const history = readAgentHistory([{
		type: "custom",
		customType: TERMINAL_RUN_ENTRY_TYPE,
		data: { version: 1, run: versionOne },
	}]);
	assert.equal(history.runs[0]?.revision, 0);
	assert.equal(history.runs[0]?.lastProgressAt, 20);
	assert.equal(history.runs[0]?.phase.kind, "completed");
	assert.equal(history.runs[0]?.phase.startedAt, 20);
	assert.deepEqual(history.runs[0]?.activeOperations, []);
	assert.equal(history.runs[0]?.steerCount, 0);
	assert.equal(history.runs[0]?.lastSteeredAt, undefined);
	assert.equal(history.runs[0]?.contextWindow, undefined);
	assert.equal(history.runs[0]?.contextTokens, undefined);
});

test("agent_steer tool details restore acknowledgement metadata", () => {
	const running = snapshot("aaaaaa");
	const steered = { ...running, steerCount: 1, lastSteeredAt: 17, revision: running.revision + 1 };
	const history = readAgentHistory([spawnEntry(running), steerEntry(steered)]);
	assert.equal(history.runs[0]?.status, "interrupted");
	assert.equal(history.runs[0]?.steerCount, 1);
	assert.equal(history.runs[0]?.lastSteeredAt, 17);
});

test("agent_steer history retains the highest revision when acknowledgements are persisted in reverse order", () => {
	const running = snapshot("aaaaaa");
	const lowerRevision = { ...running, steerCount: 1, lastSteeredAt: 17, revision: 4 };
	const higherRevision = { ...running, steerCount: 2, lastSteeredAt: 19, revision: 5 };
	const history = readAgentHistory([
		spawnEntry(running),
		steerEntry(higherRevision),
		steerEntry(lowerRevision),
	]);

	assert.equal(history.runs[0]?.status, "interrupted");
	assert.equal(history.runs[0]?.revision, higherRevision.revision + 1);
	assert.equal(history.runs[0]?.steerCount, 2);
	assert.equal(history.runs[0]?.lastSteeredAt, 19);
});

test("terminal history retains the highest revision within the terminal classification", () => {
	const higherRevision = { ...snapshot("aaaaaa", "completed"), revision: 8, finalOutput: "newer terminal" };
	const lowerRevision = { ...snapshot("aaaaaa", "failed"), revision: 7, finalOutput: "older terminal" };
	const history = readAgentHistory([
		{ type: "custom", customType: TERMINAL_RUN_ENTRY_TYPE, data: persistedTerminalRun(higherRevision) },
		{ type: "custom", customType: TERMINAL_RUN_ENTRY_TYPE, data: persistedTerminalRun(lowerRevision) },
	]);

	assert.equal(history.runs[0]?.status, "completed");
	assert.equal(history.runs[0]?.revision, 8);
	assert.equal(history.runs[0]?.finalOutput, "newer terminal");
});

test("legacy terminal snapshots supersede newer nonterminal revisions in either entry order", () => {
	const running = { ...snapshot("aaaaaa"), revision: 100 };
	const { revision: _revision, ...legacyTerminal } = snapshot("aaaaaa", "completed");
	const laterRunning = { ...running, steerCount: 3, lastSteeredAt: 25, revision: 200 };
	const history = readAgentHistory([
		spawnEntry(running),
		{ type: "custom", customType: TERMINAL_RUN_ENTRY_TYPE, data: { version: 1, run: legacyTerminal } },
		steerEntry(laterRunning),
	]);

	assert.equal(history.runs[0]?.status, "completed");
	assert.equal(history.runs[0]?.revision, 0);
	assert.equal(history.runs[0]?.finalOutput, "done");
});

test("malformed terminal entries are ignored", () => {
	const history = readAgentHistory([
		{
			type: "custom",
			customType: TERMINAL_RUN_ENTRY_TYPE,
			data: { version: 1, run: { ...snapshot("aaaaaa", "completed"), usage: { cost: {} } } },
		},
	]);

	assert.deepEqual(history.runs, []);
	assert.deepEqual([...history.persistedTerminalIds], []);
});

test("agent_status observations restore structured terminal state and context", () => {
	const running = snapshot("aaaaaa");
	const completed = {
		...snapshot("aaaaaa", "completed"),
		contextWindow: 200_000,
		contextTokens: 24_600,
	};
	const observation = observationFromSnapshot(completed, 20);
	const history = readAgentHistory([
		spawnEntry(running),
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "agent_status",
				details: {
					observedAt: observation.endedAt,
					waited: true,
					timedOut: false,
					waitedMs: 15,
					allTerminal: true,
					agents: [observation],
				},
			},
		},
	]);
	assert.equal(history.runs[0]?.status, "completed");
	assert.equal(history.runs[0]?.revision, completed.revision);
	assert.equal(history.runs[0]?.phase.kind, "completed");
	assert.equal(history.runs[0]?.finalOutput, "done");
	assert.equal(history.runs[0]?.contextWindow, 200_000);
	assert.equal(history.runs[0]?.contextTokens, 24_600);
});

test("malformed persisted context values are ignored", () => {
	const completed = {
		...snapshot("aaaaaa", "completed"),
		contextWindow: Number.POSITIVE_INFINITY,
		contextTokens: -1,
	};
	const history = readAgentHistory([{
		type: "custom",
		customType: TERMINAL_RUN_ENTRY_TYPE,
		data: { version: TERMINAL_RUN_ENTRY_VERSION, run: completed },
	}]);
	assert.equal(history.runs.length, 1);
	assert.equal(history.runs[0]?.contextWindow, undefined);
	assert.equal(history.runs[0]?.contextTokens, undefined);

	const running = { ...snapshot("bbbbbb"), contextWindow: 200_000, contextTokens: 10_000 };
	const observation = {
		...observationFromSnapshot({ ...snapshot("bbbbbb", "completed"), contextWindow: 200_000, contextTokens: 20_000 }),
		contextUsage: { tokens: -1, contextWindow: 200_000, percent: -1 },
	};
	const observed = readAgentHistory([
		spawnEntry(running),
		{ type: "message", message: { role: "toolResult", toolName: "agent_status", details: { agents: [observation] } } },
	]);
	assert.equal(observed.runs[0]?.contextWindow, 200_000);
	assert.equal(observed.runs[0]?.contextTokens, 10_000);
});

test("agent_status history preserves output truncation across re-projection", () => {
	const fullOutput = "line\n".repeat(20_000);
	const truncation = truncateHead(fullOutput);
	const completed: AgentSnapshot = {
		...snapshot("aaaaaa", "completed"),
		finalOutput: truncation.content,
		finalOutputTruncation: truncation,
		fullOutputPath: "/tmp/full-agent-output.log",
	};
	const observation = observationFromSnapshot(completed, 20, { outputBytes: 100 });
	const history = readAgentHistory([
		spawnEntry(snapshot("aaaaaa")),
		{
			type: "message",
			message: { role: "toolResult", toolName: "agent_status", details: { agents: [observation] } },
		},
	]);
	const restored = history.runs[0]!;
	const projected = observationFromSnapshot(restored, 20, { outputBytes: 100 });
	assert.equal(projected.outputTruncation?.truncated, true);
	assert.equal(projected.outputTruncation?.originalBytes, truncation.totalBytes);
	assert.equal(projected.outputTruncation?.originalLines, truncation.totalLines);
	assert.equal(projected.outputTruncation?.fullOutputPath, "/tmp/full-agent-output.log");
});

test("existing agent_wait results restore terminal state and live runs override history", () => {
	const running = snapshot("aaaaaa");
	const history = readAgentHistory([
		spawnEntry(running),
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "agent_wait",
				details: {
					results: [
						{
							id: "aaaaaa",
							name: "worker",
							status: "completed",
							output: "restored",
							model: "provider/model",
							thinking: "low",
							cwd: "/repo",
							elapsedMs: 9,
							turns: 2,
							usage: running.usage,
						},
					],
				},
			},
		},
	]);

	assert.equal(history.runs[0]?.status, "completed");
	assert.equal(history.runs[0]?.finalOutput, "restored");
	assert.equal(mergeAgentRuns(history.runs, [running])[0]?.status, "running");
});
