import assert from "node:assert/strict";
import test from "node:test";
import {
	mergeAgentRuns,
	persistedTerminalRun,
	readAgentHistory,
	TERMINAL_RUN_ENTRY_TYPE,
} from "../history.ts";
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

test("session history marks spawns without terminal records as interrupted", () => {
	const history = readAgentHistory([spawnEntry(snapshot("aaaaaa"))]);

	assert.equal(history.runs.length, 1);
	assert.equal(history.runs[0]?.status, "interrupted");
	assert.equal(history.runs[0]?.currentActivity, "interrupted");
	assert.match(history.runs[0]?.error ?? "", /before recording a terminal result/u);
});

test("terminal custom entries persist final snapshots without duplicate live output", () => {
	const completed = snapshot("aaaaaa", "completed");
	const data = persistedTerminalRun(completed);
	const history = readAgentHistory([
		{ type: "custom", customType: TERMINAL_RUN_ENTRY_TYPE, data },
		spawnEntry(snapshot("aaaaaa")),
		{ type: "custom", customType: TERMINAL_RUN_ENTRY_TYPE, data: { version: 99, run: completed } },
	]);

	assert.equal(data.run.liveOutput, "");
	assert.equal(data.run.tokensPerSecond15s, undefined);
	assert.equal(history.runs[0]?.status, "completed");
	assert.equal(history.runs[0]?.finalOutput, "done");
	assert.deepEqual([...history.persistedTerminalIds], ["aaaaaa"]);
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
