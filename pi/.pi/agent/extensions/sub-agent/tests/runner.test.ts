import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	LfDelimitedJsonReader,
	MAX_ACTIVITY_EVENTS,
	MAX_FINAL_OUTPUT_BYTES,
	PiProcessRunner,
	createInitialProgress,
	reduceJsonEvent,
} from "../runner.ts";
import type { AgentRunConfig } from "../types.ts";

const fixture = fileURLToPath(new URL("./fixtures/child.mjs", import.meta.url));
const config: AgentRunConfig = {
	id: "abc123",
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
			usage: { input: 12, output: 4, cacheRead: 3, cacheWrite: 2, cost: { total: 0.25 } },
		},
	});
	assert.equal(state.turns, 1);
	assert.equal(state.finalOutput, "final answer");
	assert.deepEqual(state.usage, { input: 12, output: 4, cacheRead: 3, cacheWrite: 2, cost: 0.25 });
	assert.equal(JSON.stringify(state).includes("do not retain me"), false);
	assert.equal(state.activity.at(-1)?.summary, "retry 2/3 in 4s");
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
