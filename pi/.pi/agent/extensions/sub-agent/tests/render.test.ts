import assert from "node:assert/strict";
import test from "node:test";
import { truncateHead, type Theme } from "@earendil-works/pi-coding-agent";
import { modelVisibleResults } from "../index.ts";
import {
	MODEL_VISIBLE_OUTPUT_BYTES,
	STATUS_RESPONSE_MAX_BYTES,
	observationFromSnapshot,
	renderStatusCall,
	renderStatusResult,
	statusResponseFromSnapshots,
	truncateModelVisibleOutput,
	waitResultFromSnapshot,
} from "../render.ts";
import type { AgentSnapshot, StatusToolDetails, WaitResult } from "../types.ts";

function structuredSnapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
	return {
		id: "abc123",
		originEntryId: "assistant-1",
		parentRunId: "parent-1",
		name: "worker",
		prompt: "task",
		model: "provider/model",
		thinking: "high",
		cwd: "/repo",
		access: "read",
		status: "running",
		createdAt: 100,
		startedAt: 120,
		revision: 5,
		lastProgressAt: 800,
		phase: { kind: "using_tools", startedAt: 500 },
		activeOperations: [{
			toolCallId: "tool-1",
			tool: "bash",
			summary: "bash: npm test",
			startedAt: 600,
			lastUpdatedAt: 750,
		}],
		recentOperations: [{
			kind: "retry",
			summary: "retry 1/3",
			startedAt: 300,
			endedAt: 400,
			outcome: "completed",
		}],
		currentActivity: "bash: npm test",
		turns: 2,
		usage: {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0.02, output: 0.08, cacheRead: 0, cacheWrite: 0, total: 0.1 },
		},
		liveOutput: "partial output",
		stderr: "",
		activity: [],
		...overrides,
	};
}

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

test("model-visible output is capped and points to the saved full output", () => {
	const full = "é".repeat(MODEL_VISIBLE_OUTPUT_BYTES);
	const truncation = truncateHead(full);
	const visible = truncateModelVisibleOutput(truncation.content, truncation, "/tmp/full-output.log");
	assert.ok(Buffer.byteLength(visible, "utf8") <= MODEL_VISIBLE_OUTPUT_BYTES);
	assert.match(visible, /Output truncated/u);
	assert.match(visible, /Full output: \/tmp\/full-output\.log/u);
});

test("model-visible results omit duplicate truncation content", () => {
	const full = Array.from({ length: 2_500 }, (_, index) => `line ${index + 1}`).join("\n");
	const truncation = truncateHead(full);
	const result: WaitResult = {
		id: "abc123",
		status: "completed",
		output: truncation.content,
		outputTruncation: truncation,
		fullOutputPath: "/tmp/full-output.log",
		model: "provider/model",
		thinking: "high",
		cwd: "/repo",
		elapsedMs: 100,
		turns: 1,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const [visible] = modelVisibleResults([result]);
	assert.equal("outputTruncation" in visible, false);
	assert.equal(visible.fullOutputPath, "/tmp/full-output.log");
	assert.match(visible.output, /Full output: \/tmp\/full-output\.log/u);
});

test("observation projection exposes absolute timestamps and objective durations", () => {
	const observation = observationFromSnapshot(structuredSnapshot(), 1_000);
	assert.equal(observation.createdAt, "1970-01-01T00:00:00.100Z");
	assert.equal(observation.startedAt, "1970-01-01T00:00:00.120Z");
	assert.equal(observation.elapsedMs, 880);
	assert.equal(observation.lastProgressAt, "1970-01-01T00:00:00.800Z");
	assert.equal(observation.quietMs, 200);
	assert.equal(observation.phase.ageMs, 500);
	assert.equal(observation.activeOperations[0]?.runningMs, 400);
	assert.equal(observation.activeOperations[0]?.quietMs, 250);
	assert.equal(observation.recentOperations[0]?.durationMs, 100);
});

test("observation projection tail-truncates live UTF-8 safely", () => {
	const observation = observationFromSnapshot(
		structuredSnapshot({ liveOutput: `prefix-${"😀".repeat(20)}-suffix` }),
		1_000,
		{ outputBytes: 17 },
	);
	assert.ok(Buffer.byteLength(observation.liveOutput ?? "", "utf8") <= 17);
	assert.equal((observation.liveOutput ?? "").includes("�"), false);
	assert.match(observation.liveOutput ?? "", /suffix$/u);
	assert.equal(observation.outputTruncation?.truncated, true);
});

test("aggregate status response stays valid and below 50 KB", () => {
	const output = "é".repeat(40_000);
	const snapshots = Array.from({ length: 12 }, (_, index) => structuredSnapshot({
		id: `agent${index}`,
		status: "completed",
		endedAt: 1_000,
		lastProgressAt: 1_000,
		phase: { kind: "completed", startedAt: 1_000 },
		activeOperations: [],
		finalOutput: output,
		liveOutput: "",
		fullOutputPath: `/tmp/agent-${index}.log`,
	}));
	const response = statusResponseFromSnapshots(snapshots, true, 1_000);
	const json = JSON.stringify(response);
	assert.ok(Buffer.byteLength(json, "utf8") <= STATUS_RESPONSE_MAX_BYTES);
	assert.equal(json.split("\n").length, 1);
	assert.deepEqual(JSON.parse(json), response);
	assert.ok(response.agents.every((agent) => agent.outputTruncation?.truncated));
	assert.equal(response.agents[0]?.outputTruncation?.fullOutputPath, "/tmp/agent-0.log");
});

test("aggregate pressure never silently omits failed-agent errors", () => {
	const snapshots = Array.from({ length: 12 }, (_, index) => structuredSnapshot({
		id: `failed${index}`,
		status: "failed",
		endedAt: 1_000,
		lastProgressAt: 1_000,
		phase: { kind: "failed", startedAt: 1_000 },
		activeOperations: [],
		error: `failure ${index}: ${"x".repeat(20_000)}`,
	}));
	const response = statusResponseFromSnapshots(snapshots, true, 1_000);
	for (const agent of response.agents) {
		assert.equal("error" in agent, true);
		assert.equal(agent.errorTruncation?.truncated, true);
		assert.ok((agent.errorTruncation?.originalBytes ?? 0) > (agent.errorTruncation?.visibleBytes ?? 0));
	}
});

test("status TUI rendering distinguishes snapshot and wait modes", () => {
	assert.match(renderStatusCall({ ids: ["abc123"], wait: false }, plainTheme).render(120).join("\n"), /agent_status snapshot abc123/u);
	assert.match(renderStatusCall({ ids: ["abc123"], wait: true }, plainTheme).render(120).join("\n"), /agent_status wait abc123/u);
	assert.match(
		renderStatusCall({ ids: ["abc123"], wait: true, timeoutSeconds: 60 }, plainTheme).render(120).join("\n"),
		/agent_status wait up to 60s abc123/u,
	);
	const response = statusResponseFromSnapshots([structuredSnapshot()], false, 1_000);
	const details: StatusToolDetails = { ...response, attributedIds: [] };
	const partial = renderStatusResult({ content: [], details }, { expanded: false, isPartial: true }, plainTheme);
	assert.match(partial.render(160).join("\n"), /worker \(abc123\) \[read\] running: bash: npm test 0s, quiet 0s/u);
	const phaseResponse = statusResponseFromSnapshots([structuredSnapshot({ activeOperations: [] })], false, 10_000);
	const phaseDetails: StatusToolDetails = { ...phaseResponse, attributedIds: [] };
	const phasePartial = renderStatusResult({ content: [], details: phaseDetails }, { expanded: false, isPartial: true }, plainTheme);
	assert.match(phasePartial.render(160).join("\n"), /worker \(abc123\) \[read\] running: using tools 9s, quiet 9s/u);
	const countdownResponse = statusResponseFromSnapshots([structuredSnapshot()], true, 2_250, {
		waitedMs: 1_250,
		timeoutMs: 60_000,
		remainingMs: 58_750,
	});
	const countdown = renderStatusResult(
		{ content: [], details: { ...countdownResponse, attributedIds: [] } },
		{ expanded: false, isPartial: true },
		plainTheme,
	);
	assert.match(countdown.render(160).join("\n"), /Time remaining: 59s/u);
	const compact = renderStatusResult({ content: [], details }, { expanded: false, isPartial: false }, plainTheme);
	assert.match(compact.render(160).join("\n"), /worker \(abc123\):read/u);
	const timedOutResponse = statusResponseFromSnapshots([structuredSnapshot()], true, 61_000, {
		timedOut: true,
		waitedMs: 60_000,
	});
	const timedOut = renderStatusResult(
		{ content: [], details: { ...timedOutResponse, attributedIds: [] } },
		{ expanded: false, isPartial: false },
		plainTheme,
	);
	assert.match(timedOut.render(160).join("\n"), /timed out after 1m0s/u);
	const expanded = renderStatusResult({ content: [], details }, { expanded: true, isPartial: false }, plainTheme);
	assert.match(expanded.render(160).join("\n"), /model\/high read 0s/u);
	assert.match(expanded.render(160).join("\n"), /Phase: using_tools/u);
});

test("status rendering accepts historical details without wait metadata", () => {
	const modern = statusResponseFromSnapshots([structuredSnapshot()], false, 1_000);
	const { timedOut: _timedOut, waitedMs: _waitedMs, ...historical } = modern;
	const details: StatusToolDetails = historical;

	assert.doesNotThrow(() => {
		renderStatusResult({ content: [], details }, { expanded: false, isPartial: true }, plainTheme);
		renderStatusResult({ content: [], details }, { expanded: false, isPartial: false }, plainTheme);
	});
});

test("compact and expanded status summaries use consistent colors", () => {
	for (const snapshot of [
		structuredSnapshot(),
		structuredSnapshot({
			status: "failed",
			endedAt: 1_000,
			phase: { kind: "failed", startedAt: 1_000 },
			error: "failure",
		}),
	]) {
		const details: StatusToolDetails = {
			...statusResponseFromSnapshots([snapshot], false, 1_000),
			attributedIds: [],
		};
		const expected = snapshot.status === "failed" ? "error" : "warning";
		for (const expanded of [false, true]) {
			const colors: string[] = [];
			const theme = {
				fg: (color: string, text: string) => {
					colors.push(color);
					return text;
				},
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			} as unknown as Theme;
			renderStatusResult({ content: [], details }, { expanded, isPartial: false }, theme);
			assert.equal(colors[0], expected);
		}
	}
});

test("wait result preserves terminal snapshot metadata", () => {
	const snapshot: AgentSnapshot = {
		id: "abc123",
		originEntryId: "assistant-1",
		parentRunId: "parent-1",
		name: "reviewer",
		prompt: "task",
		model: "provider/model",
		thinking: "high",
		cwd: "/repo",
		access: "read",
		status: "failed",
		createdAt: 100,
		startedAt: 150,
		endedAt: 250,
		revision: 4,
		lastProgressAt: 250,
		phase: { kind: "failed", startedAt: 250 },
		activeOperations: [],
		recentOperations: [],
		currentActivity: "failed",
		turns: 2,
		usage: {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0.02, output: 0.08, cacheRead: 0, cacheWrite: 0, total: 0.1 },
		},
		finalOutput: "partial",
		liveOutput: "partial",
		error: "failure",
		stderr: "",
		activity: [],
	};
	assert.deepEqual(waitResultFromSnapshot(snapshot), {
		id: "abc123",
		name: "reviewer",
		status: "failed",
		output: "partial",
		error: "failure",
		model: "provider/model",
		thinking: "high",
		cwd: "/repo",
		elapsedMs: 100,
		turns: 2,
		usage: {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0.02, output: 0.08, cacheRead: 0, cacheWrite: 0, total: 0.1 },
		},
	});
});
