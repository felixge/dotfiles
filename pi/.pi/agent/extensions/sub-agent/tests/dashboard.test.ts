import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { showAgentsDashboard, structuredActivity } from "../dashboard.ts";
import type { AgentManager } from "../manager.ts";
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

test("dashboard renders context in list and detail views within the supplied width", async () => {
	const run = snapshot({ contextWindow: 200_000, contextTokens: 24_600 });
	const renders: Record<string, string[]> = {};
	const tui = { terminal: { rows: 100 }, requestRender() {} };
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const manager = { subscribe: () => () => {}, cancel: () => true };
	const ctx = {
		ui: {
			custom: async (factory: any) => {
				const component = factory(tui, theme, undefined, () => {});
				try {
					renders.list = component.render(80);
					renders.narrowList = component.render(12);
					component.handleInput("\r");
					renders.detail = component.render(80);
					renders.narrowDetail = component.render(12);
				} finally {
					component.dispose();
				}
			},
			confirm: async () => false,
		},
	};

	await showAgentsDashboard(ctx as never, manager as unknown as AgentManager, () => [run]);

	assert.match(renders.list!.join("\n"), /12\.3%.*abc123/u);
	assert.match(renders.detail!.join("\n"), /Context: 12\.3%/u);
	for (const line of [...renders.narrowList!, ...renders.narrowDetail!]) {
		assert.ok(visibleWidth(line) <= 12);
	}
});

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
