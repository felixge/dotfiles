import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type {
	AgentRun,
	AgentRunConfig,
	AgentRunner,
	AgentSnapshot,
	RunnerProgress,
	RunnerResult,
	RunningAgentProcess,
} from "./types.ts";
import {
	addUsageSummary,
	cloneUsageSummary,
	createUsageSummary,
	hasUsage,
	isTerminalStatus,
	type UsageSummary,
} from "./types.ts";

interface TokenSample {
	timestamp: number;
	tokens: number;
}

interface ManagedRun extends AgentRun {
	handle?: RunningAgentProcess;
	completion?: Promise<void>;
	cancellationRequested: boolean;
	runnerRevision: number;
	tokenSamples: TokenSample[];
}

export interface AgentManagerOptions {
	maxConcurrency?: number;
	maxTerminalRuns?: number;
	now?: () => number;
	idFactory?: () => string;
}

export interface SpawnRequest {
	originEntryId: string;
	parentRunId: string;
	name?: string;
	prompt: string;
	model: string;
	thinking: AgentRunConfig["thinking"];
	cwd: string;
	access: AgentRunConfig["access"];
}

export type ManagerListener = (snapshots: readonly AgentSnapshot[]) => void;

const WAIT_UPDATE_INTERVAL_MS = 100;
const TOKEN_RATE_WINDOW_MS = 15_000;
const ID_PATTERN = /^[a-z0-9]{6}$/u;

function createRunId(): string {
	return randomBytes(6).toString("base64url").toLowerCase().replace(/[^a-z0-9]/gu, "").padEnd(6, "0").slice(0, 6);
}

function abortError(): Error {
	const error = new Error("Waiting for sub-agents was aborted");
	error.name = "AbortError";
	return error;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function startupSignalDeathMessage(diagnostic: NonNullable<RunnerResult["startupSignalDeath"]>): string {
	const details = [
		`signal ${diagnostic.signal}`,
		`${Math.max(0, Math.round(diagnostic.elapsedMs))} ms`,
		...(diagnostic.pid === undefined ? [] : [`pid ${diagnostic.pid}`]),
		`${diagnostic.argumentCount} argv elements`,
		`max argv element ${diagnostic.maxArgumentBytes} bytes`,
	];
	return `Pi was killed during startup (${details.join(", ")}). A host security or process policy may be responsible.`;
}

function appendTokenSample(samples: TokenSample[], tokens: number, timestamp: number): void {
	const latest = samples.at(-1);
	if (latest?.tokens === tokens) return;
	if (latest?.timestamp === timestamp) {
		latest.tokens = tokens;
	} else {
		samples.push({ timestamp, tokens });
	}
	const cutoff = timestamp - TOKEN_RATE_WINDOW_MS;
	while (samples.length > 2 && samples[1]!.timestamp <= cutoff) samples.shift();
}

function calculateTokenRate(samples: readonly TokenSample[], endpoint: number): number {
	if (samples.length < 2) return 0;
	const cutoff = endpoint - TOKEN_RATE_WINDOW_MS;
	let baseline = samples[0]!;
	for (const sample of samples) {
		if (sample.timestamp > cutoff) break;
		baseline = sample;
	}
	const latest = samples.at(-1)!;
	const elapsedMs = Math.min(TOKEN_RATE_WINDOW_MS, endpoint - baseline.timestamp);
	if (elapsedMs <= 0) return 0;
	return Math.max(0, latest.tokens - baseline.tokens) / (elapsedMs / 1000);
}

function cloneSnapshot(run: ManagedRun, now: number): AgentSnapshot {
	const endpoint = run.endedAt ?? now;
	return Object.freeze({
		id: run.id,
		originEntryId: run.originEntryId,
		parentRunId: run.parentRunId,
		name: run.name,
		prompt: run.prompt,
		model: run.model,
		thinking: run.thinking,
		cwd: run.cwd,
		access: run.access,
		status: run.status,
		createdAt: run.createdAt,
		startedAt: run.startedAt,
		endedAt: run.endedAt,
		revision: run.revision,
		lastProgressAt: run.lastProgressAt,
		phase: Object.freeze({ ...run.phase }),
		activeOperations: Object.freeze(run.activeOperations.map((operation) => Object.freeze({ ...operation }))),
		recentOperations: Object.freeze(run.recentOperations.map((operation) => Object.freeze({ ...operation }))),
		currentActivity: run.currentActivity,
		turns: run.turns,
		usage: Object.freeze({ ...run.usage, cost: Object.freeze({ ...run.usage.cost }) }),
		...(run.startedAt !== undefined ? { tokensPerSecond15s: calculateTokenRate(run.tokenSamples, endpoint) } : {}),
		finalOutput: run.finalOutput,
		finalOutputTruncation: run.finalOutputTruncation
			? Object.freeze({ ...run.finalOutputTruncation })
			: undefined,
		fullOutputPath: run.fullOutputPath,
		liveOutput: run.liveOutput,
		error: run.error,
		errorOriginalBytes: run.errorOriginalBytes,
		stderr: run.stderr,
		activity: Object.freeze(run.activity.map((event) => Object.freeze({ ...event }))),
	});
}

export async function resolveCanonicalCwd(parentCwd: string, requestedCwd?: string): Promise<string> {
	const absolute = resolve(parentCwd, requestedCwd ?? ".");
	let canonical: string;
	try {
		canonical = await realpath(absolute);
	} catch (error) {
		throw new Error(`Working directory does not exist: ${absolute}`, { cause: error });
	}
	const info = await stat(canonical);
	if (!info.isDirectory()) throw new Error(`Working directory is not a directory: ${canonical}`);
	return canonical;
}

export class AgentManager {
	private readonly runs = new Map<string, ManagedRun>();
	private readonly listeners = new Set<ManagerListener>();
	private readonly issuedIds = new Set<string>();
	private readonly attributedIds = new Set<string>();
	private readonly waiterCounts = new Map<string, number>();
	private readonly maxConcurrency: number;
	private readonly maxTerminalRuns: number;
	private readonly now: () => number;
	private readonly idFactory: () => string;
	private shuttingDown = false;

	constructor(
		private readonly runner: AgentRunner,
		options: AgentManagerOptions = {},
	) {
		this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 10);
		this.maxTerminalRuns = Math.max(0, options.maxTerminalRuns ?? 20);
		this.now = options.now ?? Date.now;
		this.idFactory = options.idFactory ?? createRunId;
	}

	spawn(request: SpawnRequest): AgentSnapshot {
		if (this.shuttingDown) throw new Error("Sub-agent manager is shutting down");
		const id = this.nextId();
		this.issuedIds.add(id);
		const createdAt = this.now();
		const run: ManagedRun = {
			id,
			...request,
			status: "queued",
			createdAt,
			revision: 0,
			lastProgressAt: createdAt,
			phase: { kind: "queued", startedAt: createdAt },
			activeOperations: [],
			recentOperations: [],
			currentActivity: "queued",
			turns: 0,
			usage: createUsageSummary(),
			outputTokens: 0,
			liveOutput: "",
			stderr: "",
			activity: [],
			cancellationRequested: false,
			runnerRevision: 0,
			tokenSamples: [],
		};
		this.runs.set(id, run);
		this.pump();
		this.emit();
		return cloneSnapshot(run, this.now());
	}

	get(id: string): AgentSnapshot | undefined {
		const run = this.runs.get(id);
		return run ? cloneSnapshot(run, this.now()) : undefined;
	}

	getAll(): AgentSnapshot[] {
		const now = this.now();
		return Array.from(this.runs.values(), (run) => cloneSnapshot(run, now));
	}

	subscribe(listener: ManagerListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	cancel(id: string): boolean {
		const run = this.runs.get(id);
		if (!run || isTerminalStatus(run.status) || run.cancellationRequested) return false;
		run.cancellationRequested = true;
		if (run.status === "queued") {
			const now = this.now();
			run.status = "cancelled";
			run.endedAt = now;
			run.lastProgressAt = now;
			run.revision += 1;
			run.phase = { kind: "cancelled", startedAt: now };
			run.currentActivity = "cancelled";
			run.error = "Cancelled before start";
			this.pump();
			this.emit();
			if (this.trimTerminalRuns()) this.emit();
			return true;
		}

		const now = this.now();
		run.lastProgressAt = now;
		run.revision += 1;
		run.phase = { kind: "cancelling", startedAt: now };
		run.currentActivity = "cancelling";
		run.handle?.cancel();
		this.emit();
		return true;
	}

	cancelMany(ids: readonly string[]): string[] {
		const cancelled: string[] = [];
		for (const id of new Set(ids)) {
			if (this.cancel(id)) cancelled.push(id);
		}
		return cancelled;
	}

	cancelWhere(predicate: (run: AgentSnapshot) => boolean): string[] {
		return this.cancelMany(this.getAll().filter(predicate).map((run) => run.id));
	}

	async wait(
		ids: readonly string[],
		signal?: AbortSignal,
		onSnapshot?: (snapshots: AgentSnapshot[]) => void,
	): Promise<AgentSnapshot[]> {
		if (ids.length === 0) throw new Error("At least one sub-agent ID is required");
		for (const id of ids) {
			if (!this.runs.has(id)) throw new Error(`Unknown sub-agent ID: ${id}`);
		}
		if (signal?.aborted) throw abortError();

		const selected = () => {
			const now = this.now();
			return ids.map((id) => cloneSnapshot(this.runs.get(id)!, now));
		};
		const current = selected();
		onSnapshot?.(current);
		if (current.every((run) => isTerminalStatus(run.status))) return current;

		const pinnedIds = [...new Set(ids)];
		for (const id of pinnedIds) this.waiterCounts.set(id, (this.waiterCounts.get(id) ?? 0) + 1);
		return new Promise<AgentSnapshot[]>((resolvePromise, rejectPromise) => {
			let finished = false;
			let lastUpdate = this.now();
			let updateTimer: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				unsubscribe();
				if (updateTimer) clearTimeout(updateTimer);
				signal?.removeEventListener("abort", onAbort);
				for (const id of pinnedIds) {
					const count = (this.waiterCounts.get(id) ?? 1) - 1;
					if (count > 0) this.waiterCounts.set(id, count);
					else this.waiterCounts.delete(id);
				}
				if (this.trimTerminalRuns()) this.emit();
			};
			const publish = () => {
				if (finished || !onSnapshot) return;
				lastUpdate = this.now();
				try {
					onSnapshot(selected());
				} catch {}
			};
			const schedulePublish = () => {
				if (!onSnapshot || updateTimer || finished) return;
				const elapsed = this.now() - lastUpdate;
				if (elapsed >= WAIT_UPDATE_INTERVAL_MS) {
					publish();
					return;
				}
				updateTimer = setTimeout(() => {
					updateTimer = undefined;
					publish();
				}, WAIT_UPDATE_INTERVAL_MS - elapsed);
			};
			const onAbort = () => {
				if (finished) return;
				finished = true;
				cleanup();
				rejectPromise(abortError());
			};
			const onChange = () => {
				if (finished) return;
				const snapshots = selected();
				if (snapshots.every((run) => isTerminalStatus(run.status))) {
					finished = true;
					cleanup();
					if (this.now() - lastUpdate >= WAIT_UPDATE_INTERVAL_MS) {
						try {
							onSnapshot?.(snapshots);
						} catch {}
					}
					resolvePromise(snapshots);
					return;
				}
				schedulePublish();
			};
			const unsubscribe = this.subscribe(onChange);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	claimUsage(snapshots: readonly AgentSnapshot[]): { usage?: UsageSummary; attributedIds: string[] } {
		const usage = createUsageSummary();
		const attributedIds: string[] = [];
		for (const snapshot of snapshots) {
			if (!this.issuedIds.has(snapshot.id)) throw new Error(`Unknown sub-agent ID: ${snapshot.id}`);
			if (!isTerminalStatus(snapshot.status)) throw new Error(`Sub-agent ${snapshot.id} is not terminal`);
			if (this.attributedIds.has(snapshot.id)) continue;
			this.attributedIds.add(snapshot.id);
			attributedIds.push(snapshot.id);
			addUsageSummary(usage, snapshot.usage);
		}
		return { ...(hasUsage(usage) ? { usage } : {}), attributedIds };
	}

	async shutdown(): Promise<void> {
		if (this.shuttingDown && !this.hasActiveRuns()) {
			return;
		}
		this.shuttingDown = true;
		for (const run of [...this.runs.values()]) {
			if (!isTerminalStatus(run.status)) this.cancel(run.id);
		}
		const completions = [...this.runs.values()]
			.map((run) => run.completion)
			.filter((completion): completion is Promise<void> => completion !== undefined);
		await Promise.allSettled(completions);
	}

	private hasActiveRuns(): boolean {
		return [...this.runs.values()].some((run) => !isTerminalStatus(run.status));
	}

	private nextId(): string {
		for (let attempt = 0; attempt < 100; attempt++) {
			const id = this.idFactory().toLowerCase();
			if (!ID_PATTERN.test(id)) throw new Error(`Invalid generated sub-agent ID: ${id}`);
			if (!this.issuedIds.has(id)) return id;
		}
		throw new Error("Could not allocate a unique sub-agent ID");
	}

	private runningCount(): number {
		let count = 0;
		for (const run of this.runs.values()) if (run.status === "running") count++;
		return count;
	}

	private pump(): void {
		if (this.shuttingDown) return;
		let running = this.runningCount();
		for (const run of this.runs.values()) {
			if (run.status !== "queued") continue;
			if (running >= this.maxConcurrency) {
				this.updateQueuedPhase(run, "capacity");
				continue;
			}
			this.startRun(run);
			running++;
		}
	}

	private updateQueuedPhase(run: ManagedRun, summary: string): void {
		if (run.phase.kind === "queued" && run.phase.summary === summary) return;
		const now = this.now();
		run.phase = { kind: "queued", startedAt: now, summary };
		run.currentActivity = summary;
		run.lastProgressAt = now;
		run.revision += 1;
	}

	private startRun(run: ManagedRun): void {
		const now = this.now();
		run.status = "running";
		run.startedAt = now;
		run.lastProgressAt = now;
		run.revision += 1;
		run.phase = { kind: "starting", startedAt: now };
		run.tokenSamples = [{ timestamp: run.startedAt, tokens: 0 }];
		run.currentActivity = "starting";

		try {
			const handle = this.runner.start(run, (progress) => this.updateProgress(run, progress));
			run.handle = handle;
			const completion = handle.result
				.then((result) => this.settleRun(run, result))
				.catch((error) => {
					this.failRun(run, `Sub-agent runner failed: ${errorMessage(error)}`);
				});
			run.completion = completion;
			void completion.catch(() => {});
		} catch (error) {
			this.failRun(run, `Could not start sub-agent: ${errorMessage(error)}`);
		}
	}

	private updateProgress(run: ManagedRun, progress: RunnerProgress): void {
		if (run.status !== "running") return;
		if (progress.revision > run.runnerRevision) {
			run.revision += progress.revision - run.runnerRevision;
			run.runnerRevision = progress.revision;
		}
		run.lastProgressAt = Math.max(run.lastProgressAt, progress.lastProgressAt);
		run.phase = { ...progress.phase };
		run.activeOperations = progress.activeOperations.map((operation) => ({ ...operation }));
		run.recentOperations = progress.recentOperations.map((operation) => ({ ...operation }));
		run.currentActivity = progress.currentActivity;
		run.turns = progress.turns;
		run.usage = cloneUsageSummary(progress.usage);
		if (progress.outputTokens !== run.outputTokens) {
			run.outputTokens = progress.outputTokens;
			appendTokenSample(run.tokenSamples, run.outputTokens, this.now());
		}
		run.finalOutput = progress.finalOutput;
		run.finalOutputTruncation = progress.finalOutputTruncation
			? { ...progress.finalOutputTruncation }
			: undefined;
		run.fullOutputPath = progress.fullOutputPath;
		run.liveOutput = progress.liveOutput;
		run.activity = progress.activity.map((event) => ({ ...event }));
		if (progress.finalError) {
			run.error = progress.finalError;
			run.errorOriginalBytes = Buffer.byteLength(progress.finalError, "utf8");
		}
		this.emit();
	}

	private settleRun(run: ManagedRun, result: RunnerResult): void {
		if (isTerminalStatus(run.status)) return;
		this.updateProgress(run, result.progress);
		run.stderr = result.stderr;
		run.endedAt = this.now();

		if (run.cancellationRequested) {
			run.status = "cancelled";
			run.error = "Cancelled";
			run.currentActivity = "cancelled";
		} else if (result.timedOut) {
			run.status = "failed";
			run.error = "Sub-agent timed out after 30 minutes";
			run.currentActivity = "failed";
		} else if (result.startupSignalDeath) {
			run.status = "failed";
			run.error = startupSignalDeathMessage(result.startupSignalDeath);
			run.currentActivity = "failed";
		} else if (result.spawnError) {
			run.status = "failed";
			run.error = `Could not start Pi: ${result.spawnError}`;
			run.currentActivity = "failed";
		} else if (result.exitCode !== 0) {
			run.status = "failed";
			const processReason = result.signal ? `signal ${result.signal}` : `exit code ${result.exitCode ?? "unknown"}`;
			run.error = result.progress.finalError || result.stdinError || result.stderr.trim() || `Pi exited with ${processReason}`;
			run.currentActivity = "failed";
		} else if (result.progress.finalStopReason === "error" || result.progress.finalStopReason === "aborted") {
			run.status = "failed";
			run.error = result.progress.finalError || `Sub-agent stopped with ${result.progress.finalStopReason}`;
			run.currentActivity = "failed";
		} else if (!result.progress.finalAssistantSeen) {
			run.status = "failed";
			run.error = result.stdinError || result.stderr.trim() || "Pi exited before producing a final assistant message";
			run.currentActivity = "failed";
		} else {
			run.status = "completed";
			run.error = undefined;
			run.currentActivity = "completed";
		}
		this.markTerminal(run);
		this.finishRun(run);
	}

	private failRun(run: ManagedRun, message: string): void {
		if (isTerminalStatus(run.status)) return;
		run.status = run.cancellationRequested ? "cancelled" : "failed";
		run.error = run.cancellationRequested ? "Cancelled" : message;
		run.currentActivity = run.status;
		run.endedAt = this.now();
		this.markTerminal(run);
		this.finishRun(run);
	}

	private markTerminal(run: ManagedRun): void {
		if (!isTerminalStatus(run.status)) return;
		const endedAt = run.endedAt ?? this.now();
		for (const operation of run.activeOperations) {
			run.recentOperations.push({
				kind: "tool",
				tool: operation.tool,
				summary: operation.summary,
				startedAt: operation.startedAt,
				endedAt,
				outcome: run.status === "cancelled" ? "cancelled" : "failed",
			});
		}
		run.activeOperations = [];
		if (run.recentOperations.length > 100) run.recentOperations.splice(0, run.recentOperations.length - 100);
		run.phase = { kind: run.status, startedAt: endedAt };
		run.lastProgressAt = endedAt;
		run.revision += 1;
	}

	private finishRun(run: ManagedRun): void {
		run.handle = undefined;
		this.pump();
		this.emit();
		if (this.trimTerminalRuns()) this.emit();
	}

	private trimTerminalRuns(): boolean {
		const terminal = [...this.runs.values()]
			.filter((run) => isTerminalStatus(run.status) && !this.waiterCounts.has(run.id))
			.sort((left, right) => (left.endedAt ?? left.createdAt) - (right.endedAt ?? right.createdAt));
		let removed = false;
		while (terminal.length > this.maxTerminalRuns) {
			const oldest = terminal.shift();
			if (oldest) {
				this.runs.delete(oldest.id);
				removed = true;
			}
		}
		return removed;
	}

	private emit(): void {
		if (this.listeners.size === 0) return;
		const snapshots = this.getAll();
		for (const listener of [...this.listeners]) {
			try {
				listener(snapshots);
			} catch {}
		}
	}
}
