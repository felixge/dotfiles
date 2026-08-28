import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AgentManager } from "../manager.ts";
import {
	BASH_ACCESS_ADVISORY,
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
import type { AgentRunConfig, RunnerProgress } from "../types.ts";

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

	dataListenerCount(): number {
		return this.events.listenerCount("data");
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
	private readonly killHandler?: (signal: NodeJS.Signals) => boolean;

	constructor(options: {
		pid?: number;
		stdin?: FakeStdin | null;
		killHandler?: (signal: NodeJS.Signals) => boolean;
	} = {}) {
		this.pid = options.pid;
		this.stdin = options.stdin === undefined ? new FakeStdin() : options.stdin;
		this.killHandler = options.killHandler;
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.killCalls.push(signal);
		return this.killHandler?.(signal) ?? true;
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

	listenerCount(event: "error" | "close"): number {
		return this.events.listenerCount(event);
	}
}

function emitJson(child: FakeChildProcess, value: unknown): void {
	child.stdout.emitData(`${JSON.stringify(value)}\n`);
}

function acknowledgePrompt(child: FakeChildProcess): void {
	emitJson(child, { id: "prompt-1", type: "response", command: "prompt", success: true });
}

function emitSuccessfulSettlement(child: FakeChildProcess, output = "done"): void {
	emitJson(child, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: output }],
			stopReason: "stop",
			usage: {},
		},
	});
	emitJson(child, { type: "agent_settled" });
}

async function immediate(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function delay(ms: number): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
		await delay(1);
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

test("process runner sends one RPC prompt, keeps stdin open, and retains isolation flags", async () => {
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
	assert.equal(result.expectedSettlementTeardown, true);
	assert.equal(result.signal, "SIGTERM");
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
		"rpc",
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

test("process runner configures bash and write access with exact tools and a bash advisory", async () => {
	for (const expected of [
		{
			access: "bash" as const,
			trailingArgs: [
				"--tools",
				"read,bash,grep,find,ls",
				"--append-system-prompt",
				BASH_ACCESS_ADVISORY,
			],
		},
		{
			access: "write" as const,
			trailingArgs: ["--tools", "read,bash,edit,write,grep,find,ls"],
		},
	]) {
		let piArgs: string[] = [];
		const runner = new PiProcessRunner({
			resolveInvocation: (args) => {
				piArgs = args;
				return { command: process.execPath, args: [fixture, "stdin"] };
			},
			gatewayCostExtensionPath,
			timeoutMs: 2_000,
		});
		const result = await runner.start({ ...config, access: expected.access }, () => {}).result;
		assert.equal(result.expectedSettlementTeardown, true);
		assert.deepEqual(piArgs.slice(piArgs.indexOf("--tools")), expected.trailingArgs);
	}
	assert.match(BASH_ACCESS_ADVISORY, /Do not modify files through bash/u);
	assert.match(BASH_ACCESS_ADVISORY, /work around the lack of edit and write tools/u);
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
	assert.equal(result.expectedSettlementTeardown, true);
	assert.deepEqual(JSON.parse(result.progress.finalOutput ?? ""), {
		bytes: Buffer.byteLength(prompt, "utf8"),
		sha256: createHash("sha256").update(prompt).digest("hex"),
	});
	assert.equal(piArgs.some((argument) => argument.includes(marker)), false);
	assert.ok(Math.max(...piArgs.map((argument) => Buffer.byteLength(argument, "utf8"))) < 1_024);
});

test("RPC commands preserve multiline text, quotes, backslashes, and Unicode as one LF record", async () => {
	const prompt = "line one\nquoted: \"value\" \\ path 😀 π";
	const fakeChild = new FakeChildProcess();
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: (args) => ({ command: "pi", args }),
		timeoutMs: 2_000,
	});
	const running = runner.start({ ...config, prompt }, () => {});
	assert.equal(fakeChild.stdin?.writes.length, 1);
	assert.equal(
		fakeChild.stdin?.writes[0],
		`${JSON.stringify({ id: "prompt-1", type: "prompt", message: prompt })}\n`,
	);
	assert.deepEqual(JSON.parse(fakeChild.stdin!.writes[0]!.slice(0, -1)), {
		id: "prompt-1",
		type: "prompt",
		message: prompt,
	});
	assert.equal(fakeChild.stdin?.endCalls, 0);
	acknowledgePrompt(fakeChild);
	let processFinished = false;
	void running.result.then(() => {
		processFinished = true;
	});
	await immediate();
	assert.equal(processFinished, false);
	emitSuccessfulSettlement(fakeChild);
	assert.deepEqual(fakeChild.killCalls, ["SIGTERM"]);
	fakeChild.emitClose(null, "SIGTERM");
	assert.equal((await running.result).expectedSettlementTeardown, true);
});

test("steering resolves only for its matching acknowledgement and ignores queue contents", async () => {
	const fakeChild = new FakeChildProcess();
	const updates: RunnerProgress[] = [];
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: (args) => ({ command: "pi", args }),
		timeoutMs: 2_000,
	});
	const running = runner.start(config, (progress) => updates.push(progress));
	acknowledgePrompt(fakeChild);
	let accepted = false;
	const steering = running.steer("focus on parser").then(() => {
		accepted = true;
	});
	assert.equal(fakeChild.stdin?.writes[1], `${JSON.stringify({
		id: "steer-2",
		type: "steer",
		message: "focus on parser",
	})}\n`);
	emitJson(fakeChild, { type: "queue_update", steering: ["focus on parser"], followUp: [] });
	emitJson(fakeChild, { id: "other", type: "response", command: "steer", success: true });
	await immediate();
	assert.equal(accepted, false);
	assert.equal(JSON.stringify(updates).includes("focus on parser"), false);
	emitJson(fakeChild, { id: "steer-2", type: "response", command: "steer", success: true });
	await steering;
	assert.equal(accepted, true);
	emitSuccessfulSettlement(fakeChild);
	fakeChild.emitClose(null, "SIGTERM");
	await running.result;
});

test("concurrent steering writes ordered records and correlates out-of-order responses", async () => {
	const fakeChild = new FakeChildProcess();
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: (args) => ({ command: "pi", args }),
		timeoutMs: 2_000,
	});
	const running = runner.start(config, () => {});
	acknowledgePrompt(fakeChild);
	const accepted: string[] = [];
	const first = running.steer("first").then(() => accepted.push("first"));
	const second = running.steer("second").then(() => accepted.push("second"));
	assert.deepEqual(fakeChild.stdin?.writes.slice(1).map((line) => JSON.parse(line)), [
		{ id: "steer-2", type: "steer", message: "first" },
		{ id: "steer-3", type: "steer", message: "second" },
	]);
	emitJson(fakeChild, { id: "steer-3", type: "response", command: "steer", success: true });
	await immediate();
	assert.deepEqual(accepted, ["second"]);
	emitJson(fakeChild, { id: "steer-2", type: "response", command: "steer", success: true });
	await Promise.all([first, second]);
	assert.deepEqual(accepted, ["second", "first"]);
	emitSuccessfulSettlement(fakeChild);
	fakeChild.emitClose(null, "SIGTERM");
	await running.result;
});

test("RPC child fixture accepts steering and stays alive until agent settlement", async () => {
	const runner = new PiProcessRunner({
		resolveInvocation: () => ({ command: process.execPath, args: [fixture, "steer"] }),
		timeoutMs: 2_000,
	});
	const running = runner.start(config, () => {});
	await running.steer("first instruction");
	await running.steer("finish");
	const result = await running.result;
	assert.equal(result.expectedSettlementTeardown, true);
	assert.equal(result.signal, "SIGTERM");
	assert.equal(result.progress.finalOutput, "fixture result");
});

test("failed steering acknowledgements reject with the child diagnostic", async () => {
	const fakeChild = new FakeChildProcess();
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: (args) => ({ command: "pi", args }),
		timeoutMs: 2_000,
	});
	const running = runner.start(config, () => {});
	acknowledgePrompt(fakeChild);
	const steering = running.steer("bad instruction");
	emitJson(fakeChild, {
		id: "steer-2",
		type: "response",
		command: "steer",
		success: false,
		error: "steering queue is unavailable",
	});
	await assert.rejects(steering, /steering queue is unavailable/u);
	running.cancel();
	fakeChild.emitClose(null, "SIGTERM");
	await running.result;
});

test("clean RPC exit before agent_settled remains unexpected despite a valid final message", async () => {
	const fakeChild = new FakeChildProcess();
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: (args) => ({ command: "pi", args }),
		timeoutMs: 2_000,
	});
	const running = runner.start(config, () => {});
	acknowledgePrompt(fakeChild);
	emitJson(fakeChild, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "not logically settled" }],
			stopReason: "stop",
			usage: {},
		},
	});
	fakeChild.emitClose(0, null);
	const result = await running.result;
	assert.equal(result.exitCode, 0);
	assert.equal(result.progress.finalAssistantSeen, true);
	assert.equal(result.progress.agentSettled, false);
	assert.equal(result.terminationCause, undefined);
	assert.equal(result.expectedSettlementTeardown, undefined);
});

test("process exit rejects pending steering requests", async () => {
	const fakeChild = new FakeChildProcess();
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: (args) => ({ command: "pi", args }),
		timeoutMs: 2_000,
	});
	const running = runner.start(config, () => {});
	acknowledgePrompt(fakeChild);
	const steering = running.steer("still pending");
	fakeChild.emitClose(1, null);
	await assert.rejects(steering, /exited before acknowledging/u);
	assert.equal((await running.result).expectedSettlementTeardown, undefined);
});

test("RPC stdin errors reject pending steering without exposing command contents", async () => {
	const secret = "private steering instruction";
	const fakeChild = new FakeChildProcess();
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: (args) => ({ command: "pi", args }),
		timeoutMs: 2_000,
	});
	const running = runner.start(config, () => {});
	acknowledgePrompt(fakeChild);
	const steering = running.steer(secret);
	fakeChild.stdin?.emitError("EIO", `failed while writing ${secret}`);
	await assert.rejects(steering, /Could not write to Pi RPC stdin \(EIO\)/u);
	fakeChild.emitClose(null, "SIGTERM");
	const result = await running.result;
	assert.equal(JSON.stringify(result).includes(secret), false);
});

test("agent settlement rejects later steering and triggers expected teardown", async () => {
	const fakeChild = new FakeChildProcess();
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: (args) => ({ command: "pi", args }),
		timeoutMs: 2_000,
	});
	const running = runner.start(config, () => {});
	acknowledgePrompt(fakeChild);
	emitSuccessfulSettlement(fakeChild, "valid final output");
	assert.deepEqual(fakeChild.killCalls, ["SIGTERM"]);
	await assert.rejects(running.steer("too late"), /no longer accepting RPC commands/u);
	fakeChild.emitClose(null, "SIGTERM");
	const result = await running.result;
	assert.equal(result.expectedSettlementTeardown, true);
	assert.equal(result.timedOut, false);
	assert.equal(result.progress.finalOutput, "valid final output");
});

test("settlement teardown escalates normally from SIGTERM to SIGKILL", async () => {
	let fakeChild!: FakeChildProcess;
	fakeChild = new FakeChildProcess({
		killHandler: (signal) => {
			if (signal === "SIGKILL") queueMicrotask(() => fakeChild.emitClose(null, "SIGKILL"));
			return true;
		},
	});
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: (args) => ({ command: "pi", args }),
		timeoutMs: 2_000,
		killGraceMs: 5,
	});
	const running = runner.start(config, () => {});
	acknowledgePrompt(fakeChild);
	emitSuccessfulSettlement(fakeChild);
	const result = await running.result;
	assert.deepEqual(fakeChild.killCalls, ["SIGTERM", "SIGKILL"]);
	assert.equal(result.terminationCause, "settled");
	assert.equal(result.expectedSettlementTeardown, true);
	assert.equal(result.teardownError, undefined);
});

test("failed SIGTERM dispatch escalates immediately and is surfaced", async () => {
	const fakeChild = new FakeChildProcess({
		killHandler: (signal) => signal !== "SIGTERM",
	});
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: (args) => ({ command: "pi", args }),
		timeoutMs: 2_000,
		killGraceMs: 20,
	});
	const running = runner.start(config, () => {});
	acknowledgePrompt(fakeChild);
	emitSuccessfulSettlement(fakeChild);
	assert.deepEqual(fakeChild.killCalls, ["SIGTERM", "SIGKILL"]);
	fakeChild.emitClose(null, "SIGKILL");
	const result = await running.result;
	assert.equal(result.expectedSettlementTeardown, true);
	assert.equal(result.teardownError, "Could not send SIGTERM to Pi RPC process");
});

test("failed SIGKILL and missing close settle result after bounded cleanup", async () => {
	const fakeChild = new FakeChildProcess({
		killHandler: (signal) => signal !== "SIGKILL",
	});
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: (args) => ({ command: "pi", args }),
		timeoutMs: 2_000,
		killGraceMs: 5,
	});
	const running = runner.start(config, () => {});
	acknowledgePrompt(fakeChild);
	emitSuccessfulSettlement(fakeChild);
	const result = await running.result;
	assert.deepEqual(fakeChild.killCalls, ["SIGTERM", "SIGKILL"]);
	assert.equal(result.expectedSettlementTeardown, true);
	assert.match(result.teardownError ?? "", /Could not send SIGKILL/u);
	assert.match(result.teardownError ?? "", /did not close within 5 ms/u);
	assert.equal(fakeChild.stdout.dataListenerCount(), 0);
	assert.equal(fakeChild.stderr.dataListenerCount(), 0);
	assert.equal(fakeChild.stdin?.errorListenerCount(), 0);
	assert.equal(fakeChild.listenerCount("close"), 0);
	assert.equal(fakeChild.listenerCount("error"), 0);
});

test("bounded settlement cleanup also guarantees manager shutdown resolves", async () => {
	const fakeChild = new FakeChildProcess();
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: (args) => ({ command: "pi", args }),
		timeoutMs: 2_000,
		killGraceMs: 5,
	});
	const manager = new AgentManager(runner, { idFactory: () => "abc123" });
	const snapshot = manager.spawn({
		originEntryId: config.originEntryId,
		parentRunId: config.parentRunId,
		prompt: config.prompt,
		model: config.model,
		thinking: config.thinking,
		cwd: config.cwd,
		access: config.access,
	});
	acknowledgePrompt(fakeChild);
	emitSuccessfulSettlement(fakeChild);
	await manager.shutdown();
	assert.deepEqual(fakeChild.killCalls, ["SIGTERM", "SIGKILL"]);
	assert.equal(manager.get(snapshot.id)?.status, "failed");
	assert.match(manager.get(snapshot.id)?.error ?? "", /did not close within 5 ms/u);
});

test("process runner treats asynchronous RPC stdin errors as transport failures", async () => {
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
		assert.deepEqual(stdin.writes, [`${JSON.stringify({ id: "prompt-1", type: "prompt", message: config.prompt })}\n`]);
		assert.equal(stdin.endCalls, 0);
		setImmediate(() => {
			stdin.emitError(code);
			fakeChild.emitClose(1, null);
		});
		const result = await running.result;
		assert.deepEqual(stdio, ["pipe", "pipe", "pipe"]);
		assert.equal(result.exitCode, 1);
		assert.equal(result.stdinError, `Could not write to Pi RPC stdin (${code})`);
		assert.deepEqual(fakeChild.killCalls, ["SIGTERM"]);
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
	assert.equal(result.stdinError, "Could not write to Pi RPC stdin (EACCES)");
	assert.equal(result.spawnError, undefined);
	assert.equal(result.startupSignalDeath, undefined);
	assert.deepEqual(fakeChild.killCalls, ["SIGTERM"]);
	assert.equal(stdin.errorListenerCount(), 0);
	const diagnostic = JSON.stringify({ stdinError: result.stdinError, startupSignalDeath: result.startupSignalDeath });
	assert.equal(diagnostic.includes(prompt), false);
	assert.equal(diagnostic.includes(argvValue), false);
});

test("process runner terminates on a late RPC stdin error while retaining valid output", async () => {
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
	assert.deepEqual(fakeChild.killCalls, ["SIGTERM"]);
	setImmediate(() => fakeChild.emitClose(null, "SIGTERM"));
	const result = await running.result;
	assert.equal(result.exitCode, null);
	assert.equal(result.signal, "SIGTERM");
	assert.deepEqual(fakeChild.killCalls, ["SIGTERM"]);
	assert.equal(result.progress.finalAssistantSeen, true);
	assert.equal(result.progress.finalOutput, "valid completion");
	assert.equal(result.stdinError, "Could not write to Pi RPC stdin (EIO)");
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
	assert.equal(result.stdinError, "Could not write to Pi RPC stdin (unavailable)");
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

test("process runner honors an unterminated final agent_settled record without signalling a closed process", async () => {
	const fakeChild = new FakeChildProcess();
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: (args) => ({ command: "pi", args }),
		timeoutMs: 2_000,
	});
	const running = runner.start(config, () => {});
	acknowledgePrompt(fakeChild);
	emitJson(fakeChild, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "complete before close" }],
			stopReason: "stop",
			usage: {},
		},
	});
	fakeChild.stdout.emitData(JSON.stringify({ type: "agent_settled" }));
	fakeChild.emitClose(0, null);

	const result = await running.result;
	assert.equal(result.terminationCause, "settled");
	assert.equal(result.expectedSettlementTeardown, true);
	assert.equal(result.progress.agentSettled, true);
	assert.equal(result.progress.finalOutput, "complete before close");
	assert.deepEqual(fakeChild.killCalls, []);
});

test("manager completes a run settled by the final unterminated stdout record", async () => {
	const fakeChild = new FakeChildProcess();
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: (args) => ({ command: "pi", args }),
		timeoutMs: 2_000,
	});
	const manager = new AgentManager(runner, { idFactory: () => "abc123" });
	const spawned = manager.spawn({
		originEntryId: config.originEntryId,
		parentRunId: config.parentRunId,
		prompt: config.prompt,
		model: config.model,
		thinking: config.thinking,
		cwd: config.cwd,
		access: config.access,
	});
	acknowledgePrompt(fakeChild);
	emitJson(fakeChild, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "manager completion" }],
			stopReason: "stop",
			usage: {},
		},
	});
	fakeChild.stdout.emitData(JSON.stringify({ type: "agent_settled" }));
	fakeChild.emitClose(0, null);

	const outcome = await manager.wait([spawned.id]);
	assert.equal(outcome.snapshots[0]?.status, "completed");
	assert.equal(outcome.snapshots[0]?.error, undefined);
	assert.equal(outcome.snapshots[0]?.finalOutput, "manager completion");
	assert.deepEqual(fakeChild.killCalls, []);
});

test("partial final JSON remains malformed and does not imply settlement", async () => {
	const fakeChild = new FakeChildProcess();
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: (args) => ({ command: "pi", args }),
		timeoutMs: 2_000,
	});
	const running = runner.start(config, () => {});
	acknowledgePrompt(fakeChild);
	emitJson(fakeChild, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "message without settlement" }],
			stopReason: "stop",
			usage: {},
		},
	});
	fakeChild.stdout.emitData('{"type":"agent_settled"');
	fakeChild.emitClose(0, null);

	const result = await running.result;
	assert.equal(result.progress.finalAssistantSeen, true);
	assert.equal(result.progress.agentSettled, false);
	assert.equal(result.terminationCause, undefined);
	assert.equal(result.expectedSettlementTeardown, undefined);
	assert.ok(result.progress.activity.some((event) => event.summary.includes("malformed JSON event")));
	assert.deepEqual(fakeChild.killCalls, []);
});

test("cancellation remains first when final stdout flush discovers settlement", async () => {
	const fakeChild = new FakeChildProcess();
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: (args) => ({ command: "pi", args }),
		timeoutMs: 2_000,
	});
	const running = runner.start(config, () => {});
	acknowledgePrompt(fakeChild);
	running.cancel();
	fakeChild.stdout.emitData(JSON.stringify({ type: "agent_settled" }));
	fakeChild.emitClose(null, "SIGTERM");

	const result = await running.result;
	assert.equal(result.progress.agentSettled, true);
	assert.equal(result.terminationCause, "cancelled");
	assert.equal(result.expectedSettlementTeardown, undefined);
	assert.deepEqual(fakeChild.killCalls, ["SIGTERM"]);
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

test("timeout remains the first termination cause when cancellation races afterward", async () => {
	const fakeChild = new FakeChildProcess();
	const updates: RunnerProgress[] = [];
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: (args) => ({ command: "pi", args }),
		timeoutMs: 5,
		killGraceMs: 100,
	});
	const running = runner.start(config, (progress) => updates.push(progress));
	acknowledgePrompt(fakeChild);
	await waitFor(() => fakeChild.killCalls.length > 0);
	running.cancel();
	fakeChild.emitClose(null, "SIGTERM");
	const result = await running.result;
	assert.equal(result.terminationCause, "timeout");
	assert.equal(result.timedOut, true);
	assert.equal(updates.filter((progress) => progress.activity.some((event) => event.summary.includes("timed out"))).length, 1);
	assert.deepEqual(fakeChild.killCalls, ["SIGTERM"]);
});

test("cancellation clears the run timeout so its original deadline cannot reclassify the run", async () => {
	const fakeChild = new FakeChildProcess();
	const updates: RunnerProgress[] = [];
	const runner = new PiProcessRunner({
		spawn: () => fakeChild,
		resolveInvocation: (args) => ({ command: "pi", args }),
		timeoutMs: 10,
		killGraceMs: 100,
	});
	const running = runner.start(config, (progress) => updates.push(progress));
	acknowledgePrompt(fakeChild);
	running.cancel();
	await delay(25);
	assert.deepEqual(fakeChild.killCalls, ["SIGTERM"]);
	fakeChild.emitClose(null, "SIGTERM");
	const result = await running.result;
	assert.equal(result.terminationCause, "cancelled");
	assert.equal(result.timedOut, false);
	assert.equal(updates.some((progress) => progress.activity.some((event) => event.summary.includes("timed out"))), false);
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
