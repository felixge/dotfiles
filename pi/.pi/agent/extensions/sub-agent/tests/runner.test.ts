import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	LfDelimitedJsonReader,
	MAX_ACTIVITY_EVENTS,
	MAX_FINAL_OUTPUT_BYTES,
	MAX_FINAL_OUTPUT_LINES,
	PiProcessRunner,
	createInitialProgress,
	reduceJsonEvent,
} from "../runner.ts";
import type { AgentRunConfig } from "../types.ts";

const fixture = fileURLToPath(new URL("./fixtures/child.mjs", import.meta.url));
const config: AgentRunConfig = {
	id: "abc123",
	originEntryId: "assistant-1",
	parentRunId: "parent-1",
	prompt: "test",
	model: "example/model",
	thinking: "low",
	cwd: process.cwd(),
	access: "read",
};

test("LF reader handles split UTF-8, multiple lines, CRLF, and an unterminated final line", () => {
	const lines: string[] = [];
	const reader = new LfDelimitedJsonReader((line) => lines.push(line));
	const bytes = Buffer.from('{"value":"héllo"}\r\n{"value":2}\n{"value":"last"}', "utf8");
	const split = bytes.indexOf(Buffer.from("é")) + 1;
	reader.push(bytes.subarray(0, split));
	reader.push(bytes.subarray(split, split + 2));
	reader.push(bytes.subarray(split + 2));
	reader.end();
	assert.deepEqual(lines, ['{"value":"héllo"}', '{"value":2}', '{"value":"last"}']);
});

test("event reducer tracks output, activity, turns, retries, and usage without retaining thinking", () => {
	let state = createInitialProgress();
	state = reduceJsonEvent(state, { type: "turn_start" });
	state = reduceJsonEvent(state, {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "do not retain me" },
	});
	state = reduceJsonEvent(state, {
		type: "tool_execution_start",
		toolName: "bash",
		args: { command: "npm test" },
	});
	assert.equal(state.currentActivity, "bash: npm test");
	state = reduceJsonEvent(state, { type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 4_000 });
	state = reduceJsonEvent(state, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "final answer" }],
			stopReason: "stop",
			usage: {
				input: 12,
				output: 4,
				cacheRead: 3,
				cacheWrite: 2,
				cacheWrite1h: 1,
				reasoning: 2,
				totalTokens: 21,
				cost: { input: 0.05, output: 0.1, cacheRead: 0.04, cacheWrite: 0.06, total: 0.25 },
			},
		},
	});
	assert.equal(state.turns, 1);
	assert.equal(state.finalOutput, "final answer");
	assert.deepEqual(state.usage, {
		input: 12,
		output: 4,
		cacheRead: 3,
		cacheWrite: 2,
		cacheWrite1h: 1,
		reasoning: 2,
		totalTokens: 21,
		cost: { input: 0.05, output: 0.1, cacheRead: 0.04, cacheWrite: 0.06, total: 0.25 },
	});
	assert.equal(JSON.stringify(state).includes("do not retain me"), false);
	assert.equal(state.activity.at(-1)?.summary, "retry 2/3 in 4s");
});

test("event reducer records deterministic phases, parallel tools, retries, and compaction", () => {
	let state = createInitialProgress(100);
	state = reduceJsonEvent(state, { type: "turn_start" }, 110);
	assert.equal(state.phase.kind, "waiting_for_model");
	assert.equal(state.revision, 1);
	assert.equal(state.lastProgressAt, 110);

	state = reduceJsonEvent(state, {
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" },
	}, 120);
	assert.equal(state.phase.kind, "thinking");
	state = reduceJsonEvent(state, {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "hello" },
	}, 130);
	assert.equal(state.phase.kind, "responding");

	state = reduceJsonEvent(state, {
		type: "tool_execution_start",
		toolCallId: "one",
		toolName: "bash",
		args: { command: "npm test" },
	}, 140);
	const beforeParallel = state;
	state = reduceJsonEvent(state, {
		type: "tool_execution_start",
		toolCallId: "two",
		toolName: "read",
		args: { path: "secret.txt" },
	}, 150);
	state = reduceJsonEvent(state, {
		type: "tool_execution_update",
		toolCallId: "one",
		toolName: "bash",
		args: { command: "npm test -- --run" },
		result: "do not retain tool update output",
	}, 160);
	assert.equal(state.activeOperations.length, 2);
	assert.equal(state.activeOperations[0]?.startedAt, 140);
	assert.equal(state.activeOperations[0]?.lastUpdatedAt, 160);
	assert.equal(beforeParallel.activeOperations.length, 1);
	assert.equal(beforeParallel.activeOperations[0]?.summary, "bash: npm test");

	state = reduceJsonEvent(state, {
		type: "tool_execution_end",
		toolCallId: "two",
		toolName: "read",
		result: "do not retain raw tool output",
		isError: false,
	}, 170);
	assert.equal(state.activeOperations.length, 1);
	assert.deepEqual(state.recentOperations.at(-1), {
		kind: "tool",
		tool: "read",
		summary: "read secret.txt",
		startedAt: 150,
		endedAt: 170,
		outcome: "completed",
	});
	state = reduceJsonEvent(state, {
		type: "tool_execution_end",
		toolCallId: "one",
		isError: true,
		result: "still not retained",
	}, 190);
	assert.equal(state.activeOperations.length, 0);
	assert.equal(state.recentOperations.at(-1)?.outcome, "failed");
	assert.equal(state.recentOperations.at(-1)?.startedAt, 140);
	assert.equal(state.phase.kind, "waiting_for_model");

	state = reduceJsonEvent(state, { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2_000 }, 200);
	state = reduceJsonEvent(state, { type: "auto_retry_end", attempt: 1, success: true }, 250);
	assert.deepEqual(state.recentOperations.at(-1), {
		kind: "retry",
		summary: "retry 1/3 in 2s",
		startedAt: 200,
		endedAt: 250,
		outcome: "completed",
	});
	state = reduceJsonEvent(state, { type: "compaction_start", reason: "threshold" }, 300);
	state = reduceJsonEvent(state, { type: "compaction_end", result: {}, aborted: false }, 380);
	assert.equal(state.recentOperations.at(-1)?.kind, "compaction");
	assert.equal(state.recentOperations.at(-1)?.startedAt, 300);
	assert.equal(state.recentOperations.at(-1)?.endedAt, 380);
	assert.equal(state.revision, 12);
	assert.equal(state.lastProgressAt, 380);
	const serialized = JSON.stringify(state);
	assert.equal(serialized.includes("private reasoning"), false);
	assert.equal(serialized.includes("do not retain"), false);
});

test("event reducer reconciles cumulative streaming usage and retains partial usage", () => {
	let state = createInitialProgress();
	state = reduceJsonEvent(state, { type: "message_start", message: { role: "assistant" } });
	state = reduceJsonEvent(state, {
		type: "message_update",
		usage: {
			input: 5,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 6,
			cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
		},
		assistantMessageEvent: { type: "text_delta", delta: "partial" },
	});
	state = reduceJsonEvent(state, {
		type: "message_update",
		usage: {
			input: 7,
			output: 2,
			cacheRead: 1,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0.02, output: 0.02, cacheRead: 0.01, cacheWrite: 0, total: 0.05 },
		},
		assistantMessageEvent: { type: "text_delta", delta: " output" },
	});
	assert.equal(state.usage.totalTokens, 10);
	assert.equal(state.usage.cost.total, 0.05);
	assert.equal(state.outputTokens, 2);
	state = reduceJsonEvent(state, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "partial output" }],
			stopReason: "stop",
			usage: {
				input: 8,
				output: 3,
				cacheRead: 1,
				cacheWrite: 0,
				totalTokens: 12,
				cost: { input: 0.03, output: 0.03, cacheRead: 0.01, cacheWrite: 0, total: 0.07 },
			},
		},
	});
	assert.equal(state.usage.totalTokens, 12);
	assert.equal(state.usage.cost.total, 0.07);
	assert.equal(state.outputTokens, 3);
	assert.equal(state.streamingUsage, undefined);
	assert.equal(state.streamingOutputTokens, undefined);
});

test("event reducer includes nested tool and compaction usage", () => {
	let state = createInitialProgress();
	state = reduceJsonEvent(state, {
		type: "message_end",
		message: {
			role: "toolResult",
			usage: {
				input: 2,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
			},
		},
	});
	state = reduceJsonEvent(state, {
		type: "compaction_end",
		result: {
			usage: {
				input: 5,
				output: 2,
				cacheRead: 1,
				cacheWrite: 0,
				totalTokens: 8,
				cost: { input: 0.02, output: 0.04, cacheRead: 0.01, cacheWrite: 0, total: 0.07 },
			},
		},
	});
	assert.deepEqual(state.usage, {
		input: 7,
		output: 3,
		cacheRead: 1,
		cacheWrite: 0,
		totalTokens: 11,
		cost: { input: 0.03, output: 0.06, cacheRead: 0.01, cacheWrite: 0, total: 0.1 },
	});
	assert.equal(state.outputTokens, 0);
});

test("event reducer bounds final output and activity", () => {
	let state = createInitialProgress();
	for (let index = 0; index < MAX_ACTIVITY_EVENTS + 20; index++) {
		state = reduceJsonEvent(state, { type: "extension_error", error: `diagnostic ${index}` });
	}
	state = reduceJsonEvent(state, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "x".repeat(MAX_FINAL_OUTPUT_BYTES + 100) }],
			stopReason: "stop",
			usage: {},
		},
	});
	assert.equal(state.activity.length, MAX_ACTIVITY_EVENTS);
	assert.ok(Buffer.byteLength(state.finalOutput ?? "") <= MAX_FINAL_OUTPUT_BYTES);
	assert.equal(state.finalOutputTruncation?.truncated, true);
});

test("process runner uses the isolated Pi CLI policy and consumes deterministic JSON output", async () => {
	let piArgs: string[] = [];
	const runner = new PiProcessRunner({
		resolveInvocation: (args) => {
			piArgs = args;
			return { command: process.execPath, args: [fixture, "success"] };
		},
		timeoutMs: 2_000,
	});
	const updates: string[] = [];
	const child = runner.start(config, (progress) => updates.push(progress.currentActivity ?? ""));
	const result = await child.result;
	assert.equal(result.exitCode, 0);
	assert.equal(result.progress.finalOutput, "fixture result");
	assert.equal(result.progress.turns, 1);
	assert.equal(result.progress.usage.input, 10);
	assert.equal(result.progress.agentSettled, true);
	assert.ok(updates.includes("thinking"));
	assert.deepEqual(piArgs.slice(0, 8), [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-approve",
	]);
	assert.equal(piArgs[piArgs.indexOf("--tools") + 1], "read,grep,find,ls");
});

test("process runner uses its injectable clock for operation timing", async () => {
	let now = 90;
	const runner = new PiProcessRunner({
		resolveInvocation: () => ({ command: process.execPath, args: [fixture, "success"] }),
		timeoutMs: 2_000,
		now: () => (now += 10),
	});
	const result = await runner.start(config, () => {}).result;
	assert.equal(result.progress.revision, 7);
	assert.equal(result.progress.lastProgressAt, 170);
	assert.equal(result.progress.recentOperations[0]?.startedAt, 140);
	assert.equal(result.progress.recentOperations[0]?.endedAt, 150);
});

test("full-output write diagnostics use the injectable clock", async () => {
	let now = 90;
	const runner = new PiProcessRunner({
		resolveInvocation: () => ({ command: process.execPath, args: [fixture, "large"] }),
		writeFullOutput: () => {
			throw new Error("disk full");
		},
		timeoutMs: 2_000,
		now: () => (now += 10),
	});
	const result = await runner.start(config, () => {}).result;
	const diagnostic = result.progress.activity.find((event) => event.summary.includes("could not save full output"));
	assert.equal(diagnostic?.timestamp, 170);
	assert.equal(result.progress.lastProgressAt, 180);
	assert.match(diagnostic?.summary ?? "", /disk full/u);
});

test("process runner saves full truncated output to a temp file", async () => {
	const runner = new PiProcessRunner({
		resolveInvocation: () => ({ command: process.execPath, args: [fixture, "large"] }),
		timeoutMs: 2_000,
	});
	const result = await runner.start(config, () => {}).result;
	assert.equal(result.progress.finalOutputTruncation?.truncatedBy, "lines");
	assert.equal(result.progress.finalOutputTruncation?.outputLines, MAX_FINAL_OUTPUT_LINES);
	assert.ok(result.progress.fullOutputPath);
	const fullOutput = await readFile(result.progress.fullOutputPath, "utf8");
	assert.equal(fullOutput.split("\n").length, 2_500);
	assert.match(fullOutput, /line 2500$/u);
	await unlink(result.progress.fullOutputPath);
});

test("process runner records malformed JSON diagnostics and bounds stderr", async () => {
	const malformedRunner = new PiProcessRunner({
		resolveInvocation: () => ({ command: process.execPath, args: [fixture, "malformed"] }),
		timeoutMs: 2_000,
	});
	const malformed = await malformedRunner.start(config, () => {}).result;
	assert.match(malformed.progress.activity[0]?.summary ?? "", /malformed JSON event/u);
	assert.equal(malformed.progress.finalOutput, "fixture result");

	const stderrRunner = new PiProcessRunner({
		resolveInvocation: () => ({ command: process.execPath, args: [fixture, "stderr"] }),
		timeoutMs: 2_000,
		maxStderrBytes: 100,
	});
	const stderr = await stderrRunner.start(config, () => {}).result;
	assert.ok(Buffer.byteLength(stderr.stderr, "utf8") <= 100);
});

test("process runner cancellation terminates a hanging child without marking a timeout", async () => {
	const runner = new PiProcessRunner({
		resolveInvocation: () => ({ command: process.execPath, args: [fixture, "hang"] }),
		timeoutMs: 2_000,
		killGraceMs: 50,
	});
	const child = runner.start(config, () => {});
	setTimeout(() => child.cancel(), 30);
	const result = await child.result;
	assert.equal(result.timedOut, false);
	assert.notEqual(result.exitCode, 0);
});

test("process runner times out and kills a hanging child", async () => {
	const runner = new PiProcessRunner({
		resolveInvocation: () => ({ command: process.execPath, args: [fixture, "hang"] }),
		timeoutMs: 50,
		killGraceMs: 50,
	});
	const result = await runner.start(config, () => {}).result;
	assert.equal(result.timedOut, true);
	assert.notEqual(result.exitCode, 0);
});
