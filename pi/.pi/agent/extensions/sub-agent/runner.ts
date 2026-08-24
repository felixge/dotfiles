import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import type {
	ActivityEvent,
	AgentRunConfig,
	AgentRunner,
	RunnerProgress,
	RunnerResult,
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
export const MAX_ACTIVITY_BYTES = 512;
export const MAX_FINAL_OUTPUT_BYTES = DEFAULT_MAX_BYTES;
export const MAX_FINAL_OUTPUT_LINES = DEFAULT_MAX_LINES;
export const MAX_LIVE_OUTPUT_BYTES = 64 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;
export const MAX_JSON_LINE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_KILL_GRACE_MS = 5_000;

const READ_TOOLS = "read,grep,find,ls";
const WRITE_TOOLS = "read,bash,edit,write,grep,find,ls";

interface ReadableLike {
	on(event: "data", listener: (chunk: Buffer | string) => void): this;
	off(event: "data", listener: (chunk: Buffer | string) => void): this;
}

export interface ChildProcessLike {
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
	stdio: ["ignore", "pipe", "pipe"];
}

export type SpawnProcess = (command: string, args: readonly string[], options: AgentSpawnOptions) => ChildProcessLike;

export type InvocationResolver = (args: string[]) => { command: string; args: string[] };

export interface ProcessRunnerOptions {
	spawn?: SpawnProcess;
	resolveInvocation?: InvocationResolver;
	timeoutMs?: number;
	killGraceMs?: number;
	maxStderrBytes?: number;
}

export function createInitialProgress(): RunnerProgress {
	return {
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
		usage: cloneUsageSummary(progress.usage),
		streamingUsage: progress.streamingUsage ? cloneUsageSummary(progress.streamingUsage) : undefined,
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

function addActivity(progress: RunnerProgress, summary: string, isError = false): void {
	const bounded = truncateUtf8Head(summary.replace(/\s+/gu, " ").trim(), MAX_ACTIVITY_BYTES);
	if (!bounded) return;
	const event: ActivityEvent = { timestamp: Date.now(), summary: bounded };
	if (isError) event.isError = true;
	progress.activity.push(event);
	if (progress.activity.length > MAX_ACTIVITY_EVENTS) {
		progress.activity.splice(0, progress.activity.length - MAX_ACTIVITY_EVENTS);
	}
}

export function addDiagnostic(progress: RunnerProgress, diagnostic: string): RunnerProgress {
	const next = cloneProgress(progress);
	addActivity(next, diagnostic, true);
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
export function reduceJsonEvent(progress: RunnerProgress, rawEvent: unknown): RunnerProgress {
	const event = recordValue(rawEvent);
	const type = stringValue(event.type);
	if (!type) return progress;

	const next = cloneProgress(progress);
	switch (type) {
		case "agent_start":
			next.currentActivity = "starting";
			break;
		case "turn_start":
			next.turns += 1;
			next.currentActivity = "thinking";
			break;
		case "message_start": {
			const message = recordValue(event.message);
			if (message.role === "assistant") {
				next.liveOutput = "";
				next.streamingUsage = undefined;
				next.streamingOutputTokens = undefined;
			}
			break;
		}
		case "message_update": {
			if (event.usage !== undefined) reconcileStreamingUsage(next, event.usage);
			const update = recordValue(event.assistantMessageEvent);
			const updateType = stringValue(update.type);
			if (updateType === "thinking_start" || updateType === "thinking_delta" || updateType === "thinking_end") {
				next.currentActivity = "thinking";
			} else if (updateType === "text_delta") {
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
			break;
		}
		case "tool_execution_start":
		case "tool_execution_update":
			next.currentActivity = formatToolActivity(stringValue(event.toolName) ?? "tool", event.args);
			break;
		case "tool_execution_end": {
			const summary =
				stringValue(event.activitySummary) ?? formatToolActivity(stringValue(event.toolName) ?? "tool", event.args);
			const isError = event.isError === true;
			addActivity(next, `${summary} ${isError ? "failed" : "completed"}`, isError);
			next.currentActivity = isError ? `${summary} failed` : summary;
			break;
		}
		case "auto_retry_start": {
			const attempt = numberValue(event.attempt);
			const maxAttempts = numberValue(event.maxAttempts);
			const delay = Math.max(0, Math.round(numberValue(event.delayMs) / 1000));
			next.currentActivity = `retry ${attempt}/${maxAttempts} in ${delay}s`;
			addActivity(next, next.currentActivity);
			break;
		}
		case "compaction_start":
			next.currentActivity = "compacting context";
			addActivity(next, next.currentActivity);
			break;
		case "compaction_end": {
			const result = recordValue(event.result);
			addUsage(next.usage, result.usage);
			break;
		}
		case "agent_settled":
			next.agentSettled = true;
			break;
		case "extension_error": {
			const message = stringValue(event.error) ?? "extension error";
			addActivity(next, `extension error: ${message}`, true);
			break;
		}
	}
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
	private readonly timeoutMs: number;
	private readonly killGraceMs: number;
	private readonly maxStderrBytes: number;

	constructor(options: ProcessRunnerOptions = {}) {
		this.spawnProcess = options.spawn ?? defaultSpawn;
		this.resolveInvocation = options.resolveInvocation ?? getPiInvocation;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
		this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
		this.maxStderrBytes = options.maxStderrBytes ?? MAX_STDERR_BYTES;
	}

	start(config: AgentRunConfig, onProgress: (progress: RunnerProgress) => void): RunningAgentProcess {
		const args = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-approve",
			"--model",
			config.model,
			"--thinking",
			config.thinking,
			"--tools",
			config.access === "write" ? WRITE_TOOLS : READ_TOOLS,
			config.prompt,
		];
		const invocation = this.resolveInvocation(args);
		let progress = createInitialProgress();
		let child: ChildProcessLike;

		try {
			child = this.spawnProcess(invocation.command, invocation.args, {
				cwd: config.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
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

		let stderr = "";
		let settled = false;
		let timedOut = false;
		let spawnError: string | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		const stderrDecoder = new StringDecoder("utf8");

		const publish = (next: RunnerProgress) => {
			progress = next;
			onProgress(cloneProgress(progress));
		};
		const diagnostic = (message: string) => publish(addDiagnostic(progress, message));
		const activeToolSummaries = new Map<string, string>();
		const stdoutReader = new LfDelimitedJsonReader(
			(line) => {
				try {
					const parsed = JSON.parse(line) as unknown;
					const event = recordValue(parsed);
					const toolCallId = stringValue(event.toolCallId);
					if ((event.type === "tool_execution_start" || event.type === "tool_execution_update") && toolCallId) {
						activeToolSummaries.set(
							toolCallId,
							formatToolActivity(stringValue(event.toolName) ?? "tool", event.args),
						);
						if (activeToolSummaries.size > MAX_ACTIVITY_EVENTS) {
							activeToolSummaries.delete(activeToolSummaries.keys().next().value as string);
						}
					}
					let reducedEvent = parsed;
					if (event.type === "tool_execution_end" && toolCallId) {
						const activitySummary = activeToolSummaries.get(toolCallId);
						activeToolSummaries.delete(toolCallId);
						if (activitySummary) reducedEvent = { ...event, activitySummary };
					}
					let next = reduceJsonEvent(progress, reducedEvent);
					const fullOutput = finalAssistantOutput(reducedEvent);
					if (fullOutput !== undefined && next.finalOutputTruncation?.truncated) {
						try {
							const fullOutputPath = createFullOutputPath(config.id);
							writeFileSync(fullOutputPath, fullOutput, "utf8");
							next.fullOutputPath = fullOutputPath;
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							next = addDiagnostic(next, `could not save full output: ${message}`);
						}
					}
					publish(next);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					diagnostic(`malformed JSON event: ${message}`);
				}
			},
			diagnostic,
		);

		const onStdout = (chunk: Buffer | string) => stdoutReader.push(chunk);
		const onStderr = (chunk: Buffer | string) => {
			const decoded = typeof chunk === "string" ? chunk : stderrDecoder.write(chunk);
			stderr = appendUtf8Tail(stderr, decoded, this.maxStderrBytes);
		};
		const onError = (error: Error) => {
			spawnError = error.message;
		};

		const terminate = () => {
			if (settled) return;
			try {
				child.kill("SIGTERM");
			} catch {}
			if (!killTimer) {
				killTimer = setTimeout(() => {
					if (settled) return;
					try {
						child.kill("SIGKILL");
					} catch {}
				}, this.killGraceMs);
			}
		};

		const result = new Promise<RunnerResult>((resolve) => {
			const onClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
				if (settled) return;
				settled = true;
				stdoutReader.end();
				stderr = appendUtf8Tail(stderr, stderrDecoder.end(), this.maxStderrBytes);
				if (timeoutTimer) clearTimeout(timeoutTimer);
				if (killTimer) clearTimeout(killTimer);
				child.stdout.off("data", onStdout);
				child.stderr.off("data", onStderr);
				child.off("error", onError);
				child.off("close", onClose);
				resolve({ exitCode, signal, stderr, progress: cloneProgress(progress), timedOut, spawnError });
			};

			child.stdout.on("data", onStdout);
			child.stderr.on("data", onStderr);
			child.on("error", onError);
			child.on("close", onClose);
			timeoutTimer = setTimeout(() => {
				timedOut = true;
				diagnostic(`run timed out after ${Math.round(this.timeoutMs / 60_000)} minutes`);
				terminate();
			}, this.timeoutMs);
		});

		return { result, cancel: terminate };
	}
}
