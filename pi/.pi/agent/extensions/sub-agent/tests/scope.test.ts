import assert from "node:assert/strict";
import test from "node:test";
import { footerText } from "../index.ts";
import { branchEntryIds, runsOnBranch } from "../scope.ts";
import type { AgentSnapshot, AgentStatus } from "../types.ts";

function snapshot(id: string, originEntryId: string, status: AgentStatus): AgentSnapshot {
	return {
		id,
		originEntryId,
		parentRunId: "parent-1",
		prompt: "task",
		model: "provider/model",
		thinking: "low",
		cwd: "/repo",
		access: "read",
		status,
		createdAt: 1,
		steerCount: 0,
		revision: 0,
		lastProgressAt: 1,
		phase: { kind: status === "running" ? "starting" : status === "queued" ? "queued" : status, startedAt: 1 },
		activeOperations: [],
		recentOperations: [],
		turns: 0,
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
	};
}

test("branch scope includes active and terminal runs whose origins remain ancestors", () => {
	const runs = [
		snapshot("aaaaaa", "root", "completed"),
		snapshot("bbbbbb", "branch-a", "running"),
		snapshot("cccccc", "branch-b", "cancelled"),
	];
	const branchIds = branchEntryIds([{ id: "root" }, { id: "branch-a" }, { id: "leaf-a" }]);

	assert.deepEqual(runsOnBranch(runs, branchIds).map((run) => run.id), ["aaaaaa", "bbbbbb"]);
});

test("dashboard scope and footer counts can use the same filtered run set", () => {
	const runs = [
		snapshot("aaaaaa", "branch-a", "running"),
		snapshot("bbbbbb", "branch-a", "queued"),
		snapshot("cccccc", "branch-b", "running"),
		snapshot("dddddd", "branch-a", "failed"),
	];
	const visible = runsOnBranch(runs, branchEntryIds([{ id: "root" }, { id: "branch-a" }]));

	assert.deepEqual(visible.map((run) => run.id), ["aaaaaa", "bbbbbb", "dddddd"]);
	assert.equal(footerText(visible), "Agents: 1 running, 1 queued");
	assert.equal(footerText(runsOnBranch(runs, new Set())), undefined);
});
