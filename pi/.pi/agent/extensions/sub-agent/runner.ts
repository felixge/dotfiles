import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import type {
	ActivityEvent,
	AgentRunConfig,
	AgentRunner,
	RunnerProgress,
	RunnerResult,
	RunnerTerminationCause,
	RunningAgentProcess,
	UsageSummary,
} from "./types.ts";
import {
	addUsageSummary,
	cloneUsageSummary,
	createUsageSummary,
	subtractUsageSummary,
} from "./types.ts";

export const MAX_ACTIVITY_EVENTS = 100;
export const MAX_ACTIVE_OPERATIONS = 100;
export const MAX_RECENT_OPERATIONS = 100;
export const MAX_ACTIVITY_BYTES = 512;
export const MAX_FINAL_OUTPUT_BYTES = DEFAULT_MAX_BYTES;
export const MAX_FINAL_OUTPUT_LINES = DEFAULT_MAX_LINES;
export const MAX_LIVE_OUTPUT_BYTES = 64 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;
export const MAX_JSON_LINE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_KILL_GRACE_MS = 5_000;
export const STARTUP_SIGNAL_DEATH_WINDOW_MS = 1_000;

const ACCESS_TOOLS: Record<AgentRunConfig["access"], string> = {
	read: "read,grep,find,ls",
	bash: "read,bash,grep,find,ls",
	write: "read,bash,edit,write,grep,find,ls",
};
export const BASH_ACCESS_ADVISORY =
	"Bash access is for inspection and other non-mutating commands only. Do not modify files through bash or work around the lack of edit and write tools.";
export const DEFAULT_GATEWAY_COST_EXTENSION_PATH = fileURLToPath(
	new URL("../gateway-cost-fallback/index.ts", import.meta.url),
);

interface ReadableLike {
	on(event: "data", listener: (chunk: Buffer | string) => void): this;
	off(event: "data", listener: (chunk: Buffer | string) => void): this;
}

interface WritableLike {
	write(chunk: string): boolean;
	end(): this;
	on(event: "error", listener: (error: Error) => void): this;
	off(event: "error", listener: (error: Error) => void): this;
}

export interface ChildProcessLike {
	stdin: WritableLike | null;
	stdout: ReadableLike;
	stderr: ReadableLike;
	pid?: number;
	kill(signal?: NodeJS.Signals): boolean;
	on(event: "error", listener: (error: Error) => void): this;
	on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	off(event: "error", listener: (error: Error) => void): this;
	off(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface AgentSpawnOptions {
	cwd: string;
	shell: false;
	stdio: ["pipe", "pipe", "pipe"];
}

export type SpawnProcess = (command: string, args: readonly string[], options: AgentSpawnOptions) => ChildProcessLike;

export type InvocationResolver = (args: string[]) => { command: string; args: string[] };

export interface ProcessRunnerOptions {
	spawn?: SpawnProcess;
	resolveInvocation?: InvocationResolver;
	writeFullOutput?: (path: string, output: string) => void;
	timeoutMs?: number;
	killGraceMs?: number;
	maxStderrBytes?: number;
	now?: () => number;
	gatewayCostExtensionPath?: string;
}

export function createInitialProgress(now = Date.now()): RunnerProgress {
	return {
		revision: 0,
		lastProgressAt: now,
		phase: { kind: "starting", startedAt: now },
		activeOperations: [],
		recentOperations: [],
		currentActivity: "starting",
		turns: 0,
		usage: createUsageSummary(),
		outputTokens: 0,
		liveOutput: "",
		finalAssistantSeen: false,
		agentSettled: false,
		activity: [],
	};
}

function cloneProgress(progress: RunnerProgress): RunnerProgress {
	return {
		...progress,
		phase: { ...progress.phase },
		activeOperations: progress.activeOperations.map((operation) => ({ ...operation })),
		recentOperations: progress.recentOperations.map((operation) => ({ ...operation })),
		usage: cloneUsageSummary(progress.usage),
		streamingUsage: progress.streamingUsage ? cloneUsageSummary(progress.streamingUsage) : undefined,
		finalOutputTruncation: progress.finalOutputTruncation ? { ...progress.finalOutputTruncation } : undefined,
		activity: progress.activity.map((event) => ({ ...event })),
	};
}

export function truncateUtf8Head(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maxBytes) return value;
	return bytes.subarray(0, Math.max(0, maxBytes)).toString("utf8").replace(/\uFFFD+$/u, "");
}

export function truncateUtf8Tail(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.length <= maxBytes) return value;
	return bytes.subarray(bytes.length - Math.max(0, maxBytes)).toString("utf8").replace(/^\uFFFD+/u, "");
}

export function appendUtf8Tail(current: string, addition: string, maxBytes: number): string {
	return truncateUtf8Tail(current + addition, maxBytes);
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function recordValue(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function addUsage(target: UsageSummary, raw: unknown): void {
	const usage = recordValue(raw);
	const cost = recordValue(usage.cost);
	const input = numberValue(usage.input);
	const output = numberValue(usage.output);
	const cacheRead = numberValue(usage.cacheRead);
	const cacheWrite = numberValue(usage.cacheWrite);
	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.totalTokens += numberValue(usage.totalTokens) || input + output + cacheRead + cacheWrite;
	target.cost.input += numberValue(cost.input);
	target.cost.output += numberValue(cost.output);
	target.cost.cacheRead += numberValue(cost.cacheRead);
	target.cost.cacheWrite += numberValue(cost.cacheWrite);
	target.cost.total += numberValue(cost.total ?? usage.cost);
	if (typeof usage.cacheWrite1h === "number" && Number.isFinite(usage.cacheWrite1h)) {
		target.cacheWrite1h = (target.cacheWrite1h ?? 0) + usage.cacheWrite1h;
	}
	if (typeof usage.reasoning === "number" && Number.isFinite(usage.reasoning)) {
		target.reasoning = (target.reasoning ?? 0) + usage.reasoning;
	}
}

function reconcileStreamingUsage(progress: RunnerProgress, raw: unknown): void {
	const latest = createUsageSummary();
	addUsage(latest, raw);
	if (progress.streamingUsage) subtractUsageSummary(progress.usage, progress.streamingUsage);
	addUsageSummary(progress.usage, latest);
	progress.streamingUsage = latest;

	const outputTokens = numberValue(recordValue(raw).output);
	progress.outputTokens -= progress.streamingOutputTokens ?? 0;
	progress.outputTokens += outputTokens;
	progress.streamingOutputTokens = outputTokens;
}

function addActivity(progress: RunnerProgress, summary: string, isError = false, now = Date.now()): void {
	const bounded = truncateUtf8Head(summary.replace(/\s+/gu, " ").trim(), MAX_ACTIVITY_BYTES);
	if (!bounded) return;
	const event: ActivityEvent = { timestamp: now, summary: bounded };
	if (isError) event.isError = true;
	progress.activity.push(event);
	if (progress.activity.length > MAX_ACTIVITY_EVENTS) {
		progress.activity.splice(0, progress.activity.length - MAX_ACTIVITY_EVENTS);
	}
}

function addOperation(progress: RunnerProgress, operation: RunnerProgress["recentOperations"][number]): void {
	progress.recentOperations.push(operation);
	if (progress.recentOperations.length > MAX_RECENT_OPERATIONS) {
		progress.recentOperations.splice(0, progress.recentOperations.length - MAX_RECENT_OPERATIONS);
	}
}

function setPhase(
	progress: RunnerProgress,
	kind: RunnerProgress["phase"]["kind"],
	now: number,
	summary?: string,
): void {
	if (progress.phase.kind === kind && progress.phase.summary === summary) return;
	progress.phase = { kind, startedAt: now, ...(summary ? { summary } : {}) };
}

function refreshCurrentActivity(progress: RunnerProgress): void {
	const active = progress.activeOperations.at(-1);
	if (active) {
		progress.currentActivity = active.summary;
		return;
	}
	if (progress.phase.summary) {
		progress.currentActivity = progress.phase.summary;
		return;
	}
	progress.currentActivity = progress.phase.kind.replaceAll("_", " ");
}

export function addDiagnostic(progress: RunnerProgress, diagnostic: string, now = Date.now()): RunnerProgress {
	const next = cloneProgress(progress);
	next.revision += 1;
	next.lastProgressAt = now;
	addActivity(next, diagnostic, true, now);
	return next;
}

function pathArg(args: Record<string, unknown>): string {
	return stringValue(args.path) ?? stringValue(args.file_path) ?? "...";
}

export function formatToolActivity(toolName: string, rawArgs: unknown): string {
	const args = recordValue(rawArgs);
	switch (toolName) {
		case "bash": {
			const command = stringValue(args.command) ?? "...";
			return `bash: ${truncateUtf8Head(command.replace(/\s+/gu, " "), 240)}`;
		}
		case "read": {
			const offset = numberValue(args.offset) || 1;
			const limit = numberValue(args.limit);
			return limit > 0 ? `read ${pathArg(args)}:${offset}-${offset + limit - 1}` : `read ${pathArg(args)}`;
		}
		case "edit":
		case "write":
			return `${toolName} ${pathArg(args)}`;
		case "grep":
			return `grep ${stringValue(args.pattern) ?? "..."} in ${pathArg(args)}`;
		case "find":
			return `find ${stringValue(args.pattern) ?? "*"} in ${pathArg(args)}`;
		case "ls":
			return `ls ${pathArg(args)}`;
		default:
			return toolName;
	}
}

function boundedOperationSummary(toolName: string, rawArgs: unknown): string {
	return truncateUtf8Head(formatToolActivity(toolName, rawArgs).replace(/\s+/gu, " ").trim(), MAX_ACTIVITY_BYTES);
}

function assistantText(message: Record<string, unknown>): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((part) => recordValue(part))
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
}

function finalAssistantOutput(rawEvent: unknown): string | undefined {
	const event = recordValue(rawEvent);
	if (event.type !== "message_end") return undefined;
	const message = recordValue(event.message);
	return message.role === "assistant" ? assistantText(message) : undefined;
}

function createFullOutputPath(id: string): string {
	return join(tmpdir(), `pi-sub-agent-${id}-${randomBytes(8).toString("hex")}.log`);
}

/** Reduce one Pi JSON event without retaining raw thinking or tool output. */
export function reduceJsonEvent(progress: RunnerProgress, rawEvent: unknown, now = Date.now()): RunnerProgress {
	const event = recordValue(rawEvent);
	const type = stringValue(event.type);
	const meaningful = new Set([
		"agent_start", "turn_start", "message_start", "message_update", "message_end",
		"tool_execution_start", "tool_execution_update", "tool_execution_end",
		"auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end",
		"agent_settled", "extension_error",
	]);
	if (!type || !meaningful.has(type)) return progress;

	const next = cloneProgress(progress);
	next.revision += 1;
	next.lastProgressAt = now;
	switch (type) {
		case "agent_start":
			setPhase(next, "starting", now);
			break;
		case "turn_start":
			next.turns += 1;
			setPhase(next, "waiting_for_model", now);
			break;
		case "message_start": {
			const message = recordValue(event.message);
			if (message.role === "assistant") {
				next.liveOutput = "";
				next.streamingUsage = undefined;
				next.streamingOutputTokens = undefined;
				setPhase(next, "waiting_for_model", now);
			}
			break;
		}
		case "message_update": {
			if (event.usage !== undefined) reconcileStreamingUsage(next, event.usage);
			const update = recordValue(event.assistantMessageEvent);
			const updateType = stringValue(update.type);
			if (updateType === "thinking_start" || updateType === "thinking_delta" || updateType === "thinking_end") {
				setPhase(next, "thinking", now);
			} else if (updateType === "text_start" || updateType === "text_delta" || updateType === "text_end") {
				setPhase(next, "responding", now);
				const delta = stringValue(update.delta);
				if (delta) next.liveOutput = appendUtf8Tail(next.liveOutput, delta, MAX_LIVE_OUTPUT_BYTES);
			}
			break;
		}
		case "message_end": {
			const message = recordValue(event.message);
			if (message.role === "toolResult") {
				addUsage(next.usage, message.usage);
				break;
			}
			if (message.role !== "assistant") break;
			if (message.usage !== undefined) reconcileStreamingUsage(next, message.usage);
			next.streamingUsage = undefined;
			next.streamingOutputTokens = undefined;
			const output = assistantText(message);
			const truncation = truncateHead(output, {
				maxLines: MAX_FINAL_OUTPUT_LINES,
				maxBytes: MAX_FINAL_OUTPUT_BYTES,
			});
			next.finalOutput = truncation.content;
			next.finalOutputTruncation = truncation.truncated ? truncation : undefined;
			next.fullOutputPath = undefined;
			next.liveOutput = truncateUtf8Tail(output, MAX_LIVE_OUTPUT_BYTES);
			next.finalStopReason = stringValue(message.stopReason);
			next.finalError = stringValue(message.errorMessage);
			next.finalAssistantSeen = true;
			setPhase(next, "responding", now);
			break;
		}
		case "tool_execution_start": {
			const rawToolCallId = stringValue(event.toolCallId);
			const toolCallId = rawToolCallId ? truncateUtf8Head(rawToolCallId, 256) : undefined;
			const tool = truncateUtf8Head(stringValue(event.toolName) ?? "tool", 128);
			const summary = boundedOperationSummary(tool, event.args);
			if (toolCallId) {
				const existing = next.activeOperations.findIndex((operation) => operation.toolCallId === toolCallId);
				const operation = { toolCallId, tool, summary, startedAt: now, lastUpdatedAt: now };
				if (existing >= 0) next.activeOperations[existing] = operation;
				else next.activeOperations.push(operation);
				if (next.activeOperations.length > MAX_ACTIVE_OPERATIONS) {
					next.activeOperations.splice(0, next.activeOperations.length - MAX_ACTIVE_OPERATIONS);
				}
			}
			setPhase(next, "using_tools", now, toolCallId ? undefined : summary);
			break;
		}
		case "tool_execution_update": {
			const rawToolCallId = stringValue(event.toolCallId);
			const toolCallId = rawToolCallId ? truncateUtf8Head(rawToolCallId, 256) : undefined;
			const operation = next.activeOperations.find((candidate) => candidate.toolCallId === toolCallId);
			if (operation) {
				operation.tool = truncateUtf8Head(stringValue(event.toolName) ?? operation.tool, 128);
				operation.summary = event.args === undefined ? operation.summary : boundedOperationSummary(operation.tool, event.args);
				operation.lastUpdatedAt = now;
			}
			setPhase(next, "using_tools", now);
			break;
		}
		case "tool_execution_end": {
			const rawToolCallId = stringValue(event.toolCallId);
			const toolCallId = rawToolCallId ? truncateUtf8Head(rawToolCallId, 256) : undefined;
			const index = next.activeOperations.findIndex((operation) => operation.toolCallId === toolCallId);
			const active = index >= 0 ? next.activeOperations[index] : undefined;
			if (index >= 0) next.activeOperations.splice(index, 1);
			const tool = truncateUtf8Head(active?.tool ?? stringValue(event.toolName) ?? "tool", 128);
			const summary = truncateUtf8Head(
				stringValue(event.activitySummary) ?? active?.summary ?? boundedOperationSummary(tool, event.args),
				MAX_ACTIVITY_BYTES,
			);
			const isError = event.isError === true;
			addOperation(next, {
				kind: "tool", tool, summary, ...(active ? { startedAt: active.startedAt } : {}), endedAt: now,
				outcome: isError ? "failed" : "completed",
			});
			addActivity(next, `${summary} ${isError ? "failed" : "completed"}`, isError, now);
			setPhase(next, next.activeOperations.length > 0 ? "using_tools" : "waiting_for_model", now);
			break;
		}
		case "auto_retry_start": {
			const attempt = numberValue(event.attempt);
			const maxAttempts = numberValue(event.maxAttempts);
			const delay = Math.max(0, Math.round(numberValue(event.delayMs) / 1000));
			const summary = `retry ${attempt}/${maxAttempts} in ${delay}s`;
			setPhase(next, "retrying", now, summary);
			addActivity(next, summary, false, now);
			break;
		}
		case "auto_retry_end": {
			const previous = next.phase.kind === "retrying" ? next.phase : undefined;
			const success = event.success === true;
			addOperation(next, {
				kind: "retry", summary: previous?.summary ?? `retry ${numberValue(event.attempt)}`,
				...(previous ? { startedAt: previous.startedAt } : {}), endedAt: now,
				outcome: success ? "completed" : "failed",
			});
			setPhase(next, "waiting_for_model", now);
			break;
		}
		case "compaction_start":
			setPhase(next, "compacting", now, "compacting context");
			addActivity(next, "compacting context", false, now);
			break;
		case "compaction_end": {
			const previous = next.phase.kind === "compacting" ? next.phase : undefined;
			const result = recordValue(event.result);
			addUsage(next.usage, result.usage);
			addOperation(next, {
				kind: "compaction", summary: previous?.summary ?? "compacting context",
				...(previous ? { startedAt: previous.startedAt } : {}), endedAt: now,
				outcome: event.aborted === true ? "cancelled" : event.errorMessage ? "failed" : "completed",
			});
			setPhase(next, "waiting_for_model", now);
			break;
		}
		case "agent_settled":
			next.agentSettled = true;
			break;
		case "extension_error": {
			const message = stringValue(event.error) ?? "extension error";
			addActivity(next, `extension error: ${message}`, true, now);
			break;
		}
	}
	refreshCurrentActivity(next);
	return next;
}

/** LF-delimited UTF-8 reader. It handles split code points, CRLF, and a final unterminated line. */
export class LfDelimitedJsonReader {
	private readonly decoder = new StringDecoder("utf8");
	private pending = "";
	private droppingOversizedLine = false;

	constructor(
		private readonly onLine: (line: string) => void,
		private readonly onDiagnostic: (message: string) => void = () => {},
		private readonly maxLineBytes = MAX_JSON_LINE_BYTES,
	) {}

	push(chunk: Buffer | string): void {
		this.consume(typeof chunk === "string" ? chunk : this.decoder.write(chunk));
	}

	end(): void {
		this.consume(this.decoder.end());
		if (this.droppingOversizedLine) {
			this.onDiagnostic(`JSON event exceeded ${this.maxLineBytes} bytes`);
			this.droppingOversizedLine = false;
		}
		if (this.pending.length > 0) {
			this.emitLine(this.pending);
			this.pending = "";
		}
	}

	private consume(text: string): void {
		if (!text) return;
		let start = 0;
		for (let index = 0; index < text.length; index++) {
			if (text.charCodeAt(index) !== 10) continue;
			const piece = text.slice(start, index);
			start = index + 1;
			if (this.droppingOversizedLine) {
				this.droppingOversizedLine = false;
				this.pending = "";
				this.onDiagnostic(`JSON event exceeded ${this.maxLineBytes} bytes`);
				continue;
			}
			this.pending += piece;
			if (Buffer.byteLength(this.pending, "utf8") > this.maxLineBytes) {
				this.onDiagnostic(`JSON event exceeded ${this.maxLineBytes} bytes`);
			} else {
				this.emitLine(this.pending);
			}
			this.pending = "";
		}
		if (!this.droppingOversizedLine) {
			this.pending += text.slice(start);
			if (Buffer.byteLength(this.pending, "utf8") > this.maxLineBytes) {
				this.pending = "";
				this.droppingOversizedLine = true;
			}
		}
	}

	private emitLine(line: string): void {
		const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
		if (normalized.trim()) this.onLine(normalized);
	}
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const executableName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/u.test(executableName);
	return isGenericRuntime ? { command: "pi", args } : { command: process.execPath, args };
}

function defaultSpawn(command: string, args: readonly string[], options: AgentSpawnOptions): ChildProcessLike {
	return nodeSpawn(command, [...args], options) as unknown as ChildProcessLike;
}

export class PiProcessRunner implements AgentRunner {
	private readonly spawnProcess: SpawnProcess;
	private readonly resolveInvocation: InvocationResolver;
	private readonly writeFullOutput: (path: string, output: string) => void;
	private readonly timeoutMs: number;
	private readonly killGraceMs: number;
	private readonly maxStderrBytes: number;
	private readonly now: () => number;
	private readonly gatewayCostExtensionPath: string;

	constructor(options: ProcessRunnerOptions = {}) {
		this.spawnProcess = options.spawn ?? defaultSpawn;
		this.resolveInvocation = options.resolveInvocation ?? getPiInvocation;
		this.writeFullOutput = options.writeFullOutput ?? ((path, output) => writeFileSync(path, output, "utf8"));
		this.timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
		this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
		this.maxStderrBytes = options.maxStderrBytes ?? MAX_STDERR_BYTES;
		this.now = options.now ?? Date.now;
		this.gatewayCostExtensionPath = options.gatewayCostExtensionPath ?? DEFAULT_GATEWAY_COST_EXTENSION_PATH;
		if (!isAbsolute(this.gatewayCostExtensionPath)) {
			throw new Error("gateway cost extension path must be absolute");
		}
	}

	start(config: AgentRunConfig, onProgress: (progress: RunnerProgress) => void): RunningAgentProcess {
		const args = [
			"--mode",
			"rpc",
			"--no-session",
			// Keep discovery disabled while explicitly loading only the pure cost hook.
			"--no-extensions",
			"--extension",
			this.gatewayCostExtensionPath,
			"--no-skills",
			"--no-prompt-templates",
			"--no-approve",
			"--model",
			config.model,
			"--thinking",
			config.thinking,
			"--tools",
			ACCESS_TOOLS[config.access],
			...(config.access === "bash" ? ["--append-system-prompt", BASH_ACCESS_ADVISORY] : []),
		];
		const invocation = this.resolveInvocation(args);
		const startupStartedAt = this.now();
		const argumentCount = invocation.args.length;
		const maxArgumentBytes = invocation.args.reduce(
			(maximum, argument) => Math.max(maximum, Buffer.byteLength(argument, "utf8")),
			0,
		);
		let progress = createInitialProgress(startupStartedAt);
		let child: ChildProcessLike;

		try {
			child = this.spawnProcess(invocation.command, invocation.args, {
				cwd: config.cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				steer: async () => Promise.reject(new Error("Sub-agent process is unavailable")),
				cancel() {},
				result: Promise.resolve({
					exitCode: null,
					signal: null,
					stderr: "",
					progress,
					timedOut: false,
					spawnError: message,
				}),
			};
		}

		type RpcCommand = "prompt" | "steer";
		interface PendingRequest {
			command: RpcCommand;
			resolve: () => void;
			reject: (error: Error) => void;
		}

		let stderr = "";
		let processSettled = false;
		let processClosed = false;
		let logicallySettled = false;
		let timedOut = false;
		let observedStdout = false;
		let terminationCause: RunnerTerminationCause | undefined;
		let spawnError: string | undefined;
		let stdinError: string | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		let requestSequence = 0;
		let flushingWrites = false;
		let forceFinish = (_message: string) => {};
		const writeQueue: string[] = [];
		const pendingRequests = new Map<string, PendingRequest>();
		const teardownErrors: string[] = [];
		const stderrDecoder = new StringDecoder("utf8");
		const stdin = child.stdin;

		const publish = (next: RunnerProgress) => {
			progress = next;
			onProgress(cloneProgress(progress));
		};
		const diagnostic = (message: string) => publish(addDiagnostic(progress, message, this.now()));
		const rejectPending = (error: Error) => {
			for (const pending of pendingRequests.values()) pending.reject(error);
			pendingRequests.clear();
		};
		const recordTeardownError = (message: string) => {
			if (!teardownErrors.includes(message)) teardownErrors.push(message);
		};
		const sendSignal = (signal: NodeJS.Signals): boolean => {
			try {
				if (child.kill(signal)) return true;
			} catch {}
			recordTeardownError(`Could not send ${signal} to Pi RPC process`);
			return false;
		};
		const escalate = () => {
			if (processSettled || cleanupTimer) return;
			if (killTimer) clearTimeout(killTimer);
			killTimer = undefined;
			sendSignal("SIGKILL");
			cleanupTimer = setTimeout(() => {
				if (processSettled) return;
				forceFinish(`Pi RPC process did not close within ${this.killGraceMs} ms after SIGKILL`);
			}, this.killGraceMs);
		};
		const terminate = (cause: RunnerTerminationCause): boolean => {
			if (processSettled || terminationCause !== undefined) return false;
			// After close, only stdout that was already buffered may refine an
			// otherwise unexpected exit into logical settlement.
			if (processClosed && cause !== "settled") return false;
			terminationCause = cause;
			if (timeoutTimer) clearTimeout(timeoutTimer);
			timeoutTimer = undefined;
			if (cause === "timeout") {
				timedOut = true;
				diagnostic(`run timed out after ${Math.round(this.timeoutMs / 60_000)} minutes`);
			}
			if (cause !== "settled") rejectPending(new Error("Sub-agent RPC process is terminating"));
			// Close is ordered after all stdout bytes. A settlement discovered while
			// flushing the final unterminated record is logical completion, but the
			// already-closed process must not be signalled again.
			if (processClosed) return true;
			if (sendSignal("SIGTERM")) {
				killTimer = setTimeout(escalate, this.killGraceMs);
			} else {
				escalate();
			}
			return true;
		};
		const onStdinError = (error: Error) => {
			const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
			stdinError ??= `Could not write to Pi RPC stdin${code ? ` (${code})` : ""}`;
			rejectPending(new Error(stdinError));
			if (!logicallySettled) terminate("transport");
		};
		const flushWrites = () => {
			if (flushingWrites || processSettled || processClosed || !stdin) return;
			flushingWrites = true;
			try {
				while (writeQueue.length > 0 && !processSettled && !processClosed) stdin.write(writeQueue.shift()!);
			} catch (error) {
				onStdinError(error instanceof Error ? error : new Error("stdin write failed"));
			} finally {
				flushingWrites = false;
			}
		};
		const request = (command: RpcCommand, message: string): Promise<void> => {
			if (processSettled || processClosed || logicallySettled || terminationCause !== undefined) {
				return Promise.reject(new Error("Sub-agent is no longer accepting RPC commands"));
			}
			if (!stdin) return Promise.reject(new Error("Sub-agent RPC stdin is unavailable"));
			const id = `${command}-${++requestSequence}`;
			const response = new Promise<void>((resolve, reject) => {
				pendingRequests.set(id, { command, resolve, reject });
			});
			writeQueue.push(`${JSON.stringify({ id, type: command, message })}\n`);
			flushWrites();
			return response;
		};
		const settleLogically = () => {
			if (logicallySettled) return;
			logicallySettled = true;
			rejectPending(new Error("Sub-agent settled before acknowledging the RPC request"));
			terminate("settled");
		};
		const routeResponse = (value: unknown): boolean => {
			const response = recordValue(value);
			if (response.type !== "response") return false;
			const id = stringValue(response.id);
			if (!id) return true;
			const pending = pendingRequests.get(id);
			if (!pending) return true;
			pendingRequests.delete(id);
			const command = stringValue(response.command);
			if (command !== pending.command) {
				pending.reject(new Error(`Pi RPC response command mismatch for ${id}`));
			} else if (response.success === true) {
				pending.resolve();
			} else {
				pending.reject(new Error(stringValue(response.error) ?? `Pi rejected the ${pending.command} command`));
			}
			return true;
		};
		const stdoutReader = new LfDelimitedJsonReader(
			(line) => {
				try {
					const parsed = JSON.parse(line) as unknown;
					if (routeResponse(parsed)) return;
					let next = reduceJsonEvent(progress, parsed, this.now());
					const fullOutput = finalAssistantOutput(parsed);
					if (fullOutput !== undefined && next.finalOutputTruncation?.truncated) {
						try {
							const fullOutputPath = createFullOutputPath(config.id);
							this.writeFullOutput(fullOutputPath, fullOutput);
							next.fullOutputPath = fullOutputPath;
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							next = addDiagnostic(next, `could not save full output: ${message}`, this.now());
						}
					}
					if (next !== progress) publish(next);
					if (next.agentSettled) settleLogically();
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					diagnostic(`malformed JSON event: ${message}`);
				}
			},
			diagnostic,
		);

		const onStdout = (chunk: Buffer | string) => {
			if (typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") > 0 : chunk.length > 0) {
				observedStdout = true;
			}
			stdoutReader.push(chunk);
		};
		const onStderr = (chunk: Buffer | string) => {
			const decoded = typeof chunk === "string" ? chunk : stderrDecoder.write(chunk);
			stderr = appendUtf8Tail(stderr, decoded, this.maxStderrBytes);
		};
		const onError = (error: Error) => {
			spawnError = error.message;
		};

		const result = new Promise<RunnerResult>((resolve) => {
			const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
				if (processSettled) return;
				// Flush buffered stdout before finalizing the exit. This makes records
				// written before close authoritative, including a final record without LF.
				stdoutReader.end();
				processSettled = true;
				stderr = appendUtf8Tail(stderr, stderrDecoder.end(), this.maxStderrBytes);
				rejectPending(new Error("Sub-agent RPC process exited before acknowledging the request"));
				writeQueue.length = 0;
				if (timeoutTimer) clearTimeout(timeoutTimer);
				if (killTimer) clearTimeout(killTimer);
				if (cleanupTimer) clearTimeout(cleanupTimer);
				timeoutTimer = undefined;
				killTimer = undefined;
				cleanupTimer = undefined;
				child.stdout.off("data", onStdout);
				child.stderr.off("data", onStderr);
				stdin?.off("error", onStdinError);
				child.off("error", onError);
				child.off("close", onClose);
				const elapsedMs = signal ? Math.max(0, this.now() - startupStartedAt) : undefined;
				const startupSignalDeath = signal
					&& elapsedMs !== undefined
					&& elapsedMs <= STARTUP_SIGNAL_DEATH_WINDOW_MS
					&& terminationCause === undefined
					&& !observedStdout
					&& stderr.length === 0
					&& progress.revision === 0
					&& spawnError === undefined
					&& stdinError === undefined
					? {
						signal,
						elapsedMs,
						...(child.pid === undefined ? {} : { pid: child.pid }),
						argumentCount,
						maxArgumentBytes,
					}
					: undefined;
				resolve({
					exitCode,
					signal,
					stderr,
					progress: cloneProgress(progress),
					timedOut,
					terminationCause,
					...(terminationCause === "settled" ? { expectedSettlementTeardown: true } : {}),
					...(teardownErrors.length > 0 ? { teardownError: teardownErrors.join("; ") } : {}),
					spawnError,
					stdinError,
					...(startupSignalDeath ? { startupSignalDeath } : {}),
				});
			};
			const onClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
				processClosed = true;
				finish(exitCode, signal);
			};
			forceFinish = (message) => {
				recordTeardownError(message);
				finish(null, null);
			};

			child.stdout.on("data", onStdout);
			child.stderr.on("data", onStderr);
			child.on("error", onError);
			child.on("close", onClose);
			timeoutTimer = setTimeout(() => terminate("timeout"), this.timeoutMs);
		});

		if (stdin) {
			stdin.on("error", onStdinError);
			void request("prompt", config.prompt).catch((error) => {
				if (logicallySettled || processSettled || terminationCause !== undefined) return;
				stdinError = `Pi rejected the initial RPC prompt: ${error instanceof Error ? error.message : String(error)}`;
				terminate("transport");
			});
		} else {
			stdinError = "Could not write to Pi RPC stdin (unavailable)";
			terminate("transport");
		}

		return {
			result,
			steer: (message) => request("steer", message),
			cancel: () => { terminate("cancelled"); },
		};
	}
}
