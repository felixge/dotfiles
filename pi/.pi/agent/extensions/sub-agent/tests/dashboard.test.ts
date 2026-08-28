import assert from "node:assert/strict";
import test from "node:test";
import { structuredActivity } from "../dashboard.ts";
import type { AgentSnapshot } from "../types.ts";

function snapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
	return {
		id: "abc123",
		originEntryId: "assistant-1",
		parentRunId: "parent-1",
		prompt: "task",
		model: "provider/model",
		thinking: "medium",
		cwd: "/repo",
		access: "read",
		status: "running",
		createdAt: 1_000,
		startedAt: 2_000,
		steerCount: 0,
		revision: 1,
		lastProgressAt: 9_000,
		phase: { kind: "thinking", startedAt: 5_000 },
		activeOperations: [],
		recentOperations: [],
		turns: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		liveOutput: "",
		stderr: "",
		activity: [],
		...overrides,
	};
}

test("structured activity shows phase runtime and quiet time", () => {
	assert.equal(structuredActivity(snapshot(), 15_000), "thinking 10s, quiet 6s");
});

test("structured activity shows operation runtime and quiet time", () => {
	const run = snapshot({
		activeOperations: [{
			toolCallId: "tool-1",
			tool: "bash",
			summary: "bash: npm test",
			startedAt: 4_000,
			lastUpdatedAt: 12_000,
		}],
	});
	assert.equal(structuredActivity(run, 15_000), "bash: npm test 11s, quiet 3s");
});

test("structured activity freezes durations at endedAt", () => {
	const run = snapshot({
		status: "completed",
		endedAt: 15_000,
		activeOperations: [{
			toolCallId: "tool-1",
			tool: "bash",
			summary: "bash: npm test",
			startedAt: 4_000,
			lastUpdatedAt: 12_000,
		}],
	});
	assert.equal(structuredActivity(run, 30_000), "bash: npm test 11s, quiet 3s");
});
