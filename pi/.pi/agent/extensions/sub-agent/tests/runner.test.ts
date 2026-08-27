import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	DEFAULT_GATEWAY_COST_EXTENSION_PATH,
	LfDelimitedJsonReader,
	MAX_ACTIVITY_EVENTS,
	MAX_FINAL_OUTPUT_BYTES,
	MAX_FINAL_OUTPUT_LINES,
	PiProcessRunner,
	STARTUP_SIGNAL_DEATH_WINDOW_MS,
	createInitialProgress,
	reduceJsonEvent,
} from "../runner.ts";
import type { AgentRunConfig } from "../types.ts";

const fixture = fileURLToPath(new URL("./fixtures/child.mjs", import.meta.url));
const gatewayCostExtensionPath = "/test/gateway-cost-fallback/index.ts";
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

class FakeReadable {
	private readonly events = new EventEmitter();

	on(event: "data", listener: (chunk: Buffer | string) => void): this {
		this.events.on(event, listener);
		return this;
	}

	off(event: "data", listener: (chunk: Buffer | string) => void): this {
		this.events.off(event, listener);
		return this;
	}

	emitData(chunk: Buffer | string): void {
		this.events.emit("data", chunk);
	}
}

class FakeStdin {
	readonly writes: string[] = [];
	endCalls = 0;
	private readonly events = new EventEmitter();

	on(event: "error", listener: (error: Error) => void): this {
		this.events.on(event, listener);
		return this;
	}

	off(event: "error", listener: (error: Error) => void): this {
		this.events.off(event, listener);
		return this;
	}

	write(chunk: string): boolean {
		this.writes.push(chunk);
		return true;
	}

	end(): this {
		this.endCalls += 1;
		return this;
	}

	emitError(code: string, message = "stdin failed"): void {
		this.events.emit("error", Object.assign(new Error(message), { code }));
	}

	errorListenerCount(): number {
		return this.events.listenerCount("error");
	}
}

class FakeChildProcess {
	readonly stdin: FakeStdin | null;
	readonly stdout = new FakeReadable();
	readonly stderr = new FakeReadable();
	readonly killCalls: NodeJS.Signals[] = [];
	readonly pid?: number;
	private readonly events = new EventEmitter();

	constructor(options: { pid?: number; stdin?: FakeStdin | null } = {}) {
		this.pid = options.pid;
		this.stdin = options.stdin === undefined ? new FakeStdin() : options.stdin;
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.killCalls.push(signal);
		return true;
	}

	on(event: "error", listener: (error: Error) => void): this;
	on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	on(event: "error" | "close", listener: (...args: any[]) => void): this {
		this.events.on(event, listener);
		return this;
	}

	off(event: "error", listener: (error: Error) => void): this;
	off(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	off(event: "error" | "close", listener: (...args: any[]) => void): this {
		this.events.off(event, listener);
		return this;
	}

	emitClose(code: number | null, signal: NodeJS.Signals | null): void {
		this.events.emit("close", code, signal);
	}
}

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

test("default gateway cost extension path is absolute and points to the bundled fallback", () => {
	assert.equal(isAbsolute(DEFAULT_GATEWAY_COST_EXTENSION_PATH), true);
	assert.equal(existsSync(DEFAULT_GATEWAY_COST_EXTENSION_PATH), true);
});

test("gateway cost extension path rejects child-cwd-relative overrides", () => {
	assert.throws(
		() => new PiProcessRunner({ gatewayCostExtensionPath: "../gateway-cost-fallback/index.ts" }),
		/extension path must be absolute/u,
	);
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

test("event reducer replaces unpriced streaming usage with priced Gateway usage and sums messages once", () => {
	const pricedUsage = Object.freeze({
		input: 100,
		output: 20,
		cacheRead: 30,
		cacheWrite: 10,
		cacheWrite1h: 4,
		reasoning: 8,
		totalTokens: 160,
		cost: Object.freeze({ input: 0.125, output: 0.25, cacheRead: 0.125, cacheWrite: 0.5, total: 1 }),
	});
	const message = {
		role: "assistant",
		provider: "ai-gw-anthropic-1m",
		model: "anthropic/claude-opus-5",
		content: [{ type: "text", text: "priced response" }],
		stopReason: "stop",
		usage: pricedUsage,
	};
	let state = reduceJsonEvent(createInitialProgress(), { type: "message_start", message: { role: "assistant" } });
	state = reduceJsonEvent(state, {
		type: "message_update",
		usage: {
			input: 90,
			output: 10,
			cacheRead: 30,
			cacheWrite: 10,
			totalTokens: 140,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		assistantMessageEvent: { type: "text_delta", delta: "priced response" },
	});
	state = reduceJsonEvent(state, { type: "message_end", message });
	assert.notEqual(state.usage, pricedUsage);
	assert.deepEqual(state.usage, {
		input: 100,
		output: 20,
		cacheRead: 30,
		cacheWrite: 10,
		cacheWrite1h: 4,
		reasoning: 8,
		totalTokens: 160,
		cost: { input: 0.125, output: 0.25, cacheRead: 0.125, cacheWrite: 0.5, total: 1 },
	});

	state = reduceJsonEvent(state, { type: "message_start", message: { role: "assistant" } });
	state = reduceJsonEvent(state, { type: "message_end", message });
	assert.deepEqual(state.usage, {
		input: 200,
		output: 40,
		cacheRead: 60,
		cacheWrite: 20,
		cacheWrite1h: 8,
		reasoning: 16,
		totalTokens: 320,
		cost: { input: 0.25, output: 0.5, cacheRead: 0.25, cacheWrite: 1, total: 2 },
	});
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

test("process runner omits the prompt from argv and writes it exactly once to closed stdin", async () => {
	const prompt = "exact stdin prompt\nwith unicode: π";
	let piArgs: string[] = [];
	const runner = new PiProcessRunner({
		resolveInvocation: (args) => {
			piArgs = args;
			return { command: process.execPath, args: [fixture, "stdin"] };
		},
		gatewayCostExtensionPath,
		timeoutMs: 2_000,
	});
	const updates: string[] = [];
	const child = runner.start({ ...config, prompt }, (progress) => updates.push(progress.currentActivity ?? ""));
	const result = await child.result;
	assert.equal(result.exitCode, 0);
	assert.deepEqual(JSON.parse(result.progress.finalOutput ?? ""), {
		bytes: Buffer.byteLength(prompt, "utf8"),
		sha256: createHash("sha256").update(prompt).digest("hex"),
	});
	assert.equal(result.progress.turns, 1);
	assert.equal(result.progress.usage.input, 10);
	assert.equal(result.progress.agentSettled, true);
	assert.ok(updates.includes("thinking"));
	assert.equal(piArgs.includes(prompt), false);
	assert.deepEqual(piArgs, [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--extension",
		gatewayCostExtensionPath,
		"--no-skills",
		"--no-prompt-templates",
		"--no-approve",
		"--model",
		"example/model",
		"--thinking",
		"low",
		"--tools",
		"read,grep,find,ls",
	]);
});

test("process runner supports long prompts without adding them to argv", async () => {
	const marker = "private-long-prompt-marker";
	const prompt = `${marker}:${"x".repeat(16 * 1024)}`;
	let piArgs: string[] = [];
	const runner = new PiProcessRunner({
		resolveInvocation: (args) => {
			piArgs = args;
			return { command: process.execPath, args: [fixture, "stdin"] };
		},
		timeoutMs: 2_000,
	});
	const result = await runner.start({ ...config, prompt }, () => {}).result;
	assert.equal(result.exitCode, 0);
	assert.deepEqual(JSON.parse(result.progress.finalOutput ?? ""), {
		bytes: Buffer.byteLength(prompt, "utf8"),
		sha256: createHash("sha256").update(prompt).digest("hex"),
	});
	assert.equal(piArgs.some((argument) => argument.includes(marker)), false);
	assert.ok(Math.max(...piArgs.map((argument) => Buffer.byteLength(argument, "utf8"))) < 1_024);
});

test("process runner consumes asynchronous closed-stdin errors after writing and ending once", async () => {
	for (const code of ["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]) {
		const stdin = new FakeStdin();
		const fakeChild = new FakeChildProcess({ stdin });
		let stdio: readonly string[] | undefined;
		const runner = new PiProcessRunner({
			spawn: (_command, _args, options) => {
				stdio = options.stdio;
				return fakeChild;
			},
			resolveInvocation: (args) => ({ command: "pi", args }),
			timeoutMs: 2_000,
		});
		const running = runner.start(config, () => {});
		assert.deepEqual(stdin.writes, [config.prompt]);
		assert.equal(stdin.endCalls, 1);
		setImmediate(() => {
			stdin.emitError(code);
			fakeChild.emitClose(1, null);
		});
		const result = await running.result;
		assert.deepEqual(stdio, ["pipe", "pipe", "pipe"]);
		assert.equal(result.exitCode, 1);
		assert.equal(result.stdinError, undefined);
		assert.deepEqual(fakeChild.killCalls, []);
		assert.equal(stdin.errorListenerCount(), 0);
	}
});

test("process runner diagnoses unexpected stdin errors without startup misclassification or secrets", async () => {
	const prompt = "private-prompt-value";
	const argvValue = "private-argv-value";
	const stdin = new FakeStdin();
	const fakeChild = new FakeChildProcess({ stdin });
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: () => ({ command: "pi", args: ["--private-option", argvValue] }),
		timeoutMs: 2_000,
	});
	const running = runner.start({ ...config, prompt }, () => {});
	setImmediate(() => {
		stdin.emitError("EACCES", `failed for ${prompt} and ${argvValue}`);
		fakeChild.emitClose(null, "SIGTERM");
	});
	const result = await running.result;
	assert.equal(result.stdinError, "Could not send prompt to Pi stdin (EACCES)");
	assert.equal(result.spawnError, undefined);
	assert.equal(result.startupSignalDeath, undefined);
	assert.deepEqual(fakeChild.killCalls, ["SIGTERM"]);
	assert.equal(stdin.errorListenerCount(), 0);
	const diagnostic = JSON.stringify({ stdinError: result.stdinError, startupSignalDeath: result.startupSignalDeath });
	assert.equal(diagnostic.includes(prompt), false);
	assert.equal(diagnostic.includes(argvValue), false);
});

test("process runner retains valid output when an unexpected stdin error arrives late", async () => {
	const stdin = new FakeStdin();
	const fakeChild = new FakeChildProcess({ stdin });
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: (args) => ({ command: "pi", args }),
		timeoutMs: 2_000,
	});
	const running = runner.start(config, () => {});
	fakeChild.stdout.emitData(`${JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "valid completion" }],
			stopReason: "stop",
			usage: {},
		},
	})}\n`);
	stdin.emitError("EIO");
	assert.deepEqual(fakeChild.killCalls, []);
	setImmediate(() => fakeChild.emitClose(0, null));
	const result = await running.result;
	assert.equal(result.exitCode, 0);
	assert.equal(result.signal, null);
	assert.deepEqual(fakeChild.killCalls, []);
	assert.equal(result.progress.finalAssistantSeen, true);
	assert.equal(result.progress.finalOutput, "valid completion");
	assert.equal(result.stdinError, "Could not send prompt to Pi stdin (EIO)");
});

test("process runner handles unavailable stdin without throwing", async () => {
	const fakeChild = new FakeChildProcess({ stdin: null });
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: (args) => ({ command: "pi", args }),
		timeoutMs: 2_000,
	});
	const running = runner.start(config, () => {});
	assert.deepEqual(fakeChild.killCalls, ["SIGTERM"]);
	fakeChild.emitClose(null, "SIGTERM");
	const result = await running.result;
	assert.equal(result.stdinError, "Could not send prompt to Pi stdin (unavailable)");
	assert.equal(result.startupSignalDeath, undefined);
});

test("process runner returns non-sensitive metadata for a signal before the first JSON event", async () => {
	const prompt = "private-prompt-value";
	const argvValue = `private-argv-value-${"z".repeat(80)}`;
	const invocationArgs = ["child-script", "--private-option", argvValue];
	const fakeChild = new FakeChildProcess({ pid: 42_424 });
	const times = [100, 137];
	let piArgs: string[] = [];
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: (args) => {
			piArgs = args;
			return { command: "private-command-value", args: invocationArgs };
		},
		now: () => times.shift() ?? 137,
		timeoutMs: 2_000,
	});
	const running = runner.start({ ...config, prompt }, () => {});
	fakeChild.emitClose(null, "SIGKILL");
	const result = await running.result;
	assert.equal(piArgs.includes(prompt), false);
	assert.deepEqual(result.startupSignalDeath, {
		signal: "SIGKILL",
		elapsedMs: 37,
		pid: 42_424,
		argumentCount: invocationArgs.length,
		maxArgumentBytes: Math.max(...invocationArgs.map((argument) => Buffer.byteLength(argument, "utf8"))),
	});
	const diagnostic = JSON.stringify(result.startupSignalDeath);
	assert.equal(diagnostic.includes(prompt), false);
	assert.equal(diagnostic.includes(argvValue), false);
	assert.equal(diagnostic.includes("private-command-value"), false);
});

test("process runner excludes non-JSON stdout and stderr from startup signal classification", async () => {
	const withStdout = new FakeChildProcess({ pid: 101 });
	const stdoutRunner = new PiProcessRunner({
		spawn: () => withStdout,
		resolveInvocation: (args) => ({ command: "pi", args }),
		timeoutMs: 2_000,
	});
	const stdoutRun = stdoutRunner.start(config, () => {});
	withStdout.stdout.emitData("startup warning, not JSON\n");
	withStdout.emitClose(null, "SIGKILL");
	const stdoutResult = await stdoutRun.result;
	assert.equal(stdoutResult.startupSignalDeath, undefined);
	assert.match(stdoutResult.progress.activity[0]?.summary ?? "", /malformed JSON event/u);

	const withStderr = new FakeChildProcess({ pid: 102 });
	const stderrRunner = new PiProcessRunner({
		spawn: () => withStderr,
		resolveInvocation: (args) => ({ command: "pi", args }),
		timeoutMs: 2_000,
	});
	const stderrRun = stderrRunner.start(config, () => {});
	withStderr.stderr.emitData("startup stderr");
	withStderr.emitClose(null, "SIGKILL");
	assert.equal((await stderrRun.result).startupSignalDeath, undefined);
});

test("process runner excludes late signal deaths from startup classification", async () => {
	const fakeChild = new FakeChildProcess({ pid: 103 });
	const times = [100, 100 + STARTUP_SIGNAL_DEATH_WINDOW_MS + 1];
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: (args) => ({ command: "pi", args }),
		now: () => times.shift() ?? times.at(-1) ?? 0,
		timeoutMs: 2_000,
	});
	const running = runner.start(config, () => {});
	fakeChild.emitClose(null, "SIGKILL");
	assert.equal((await running.result).startupSignalDeath, undefined);
});

test("process runner flushes complete unterminated JSON before startup classification", async () => {
	const fakeChild = new FakeChildProcess({ pid: 104 });
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: (args) => ({ command: "pi", args }),
		timeoutMs: 2_000,
	});
	const running = runner.start(config, () => {});
	fakeChild.stdout.emitData(JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "complete final output" }],
			stopReason: "stop",
			usage: {},
		},
	}));
	fakeChild.emitClose(null, "SIGKILL");
	const result = await running.result;
	assert.equal(result.progress.finalAssistantSeen, true);
	assert.equal(result.progress.finalOutput, "complete final output");
	assert.equal(result.startupSignalDeath, undefined);
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
