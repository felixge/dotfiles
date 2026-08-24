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
import { isTerminalStatus } from "./types.ts";

interface ManagedRun extends AgentRun {
	handle?: RunningAgentProcess;
	completion?: Promise<void>;
	cancellationRequested: boolean;
}

export interface AgentManagerOptions {
	maxConcurrency?: number;
	maxTerminalRuns?: number;
	now?: () => number;
	idFactory?: () => string;
}

export interface SpawnRequest {
	name?: string;
	prompt: string;
	model: string;
	thinking: AgentRunConfig["thinking"];
	cwd: string;
	access: AgentRunConfig["access"];
}

export type ManagerListener = (snapshots: readonly AgentSnapshot[]) => void;

const WAIT_UPDATE_INTERVAL_MS = 100;
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

function cloneSnapshot(run: ManagedRun): AgentSnapshot {
	return Object.freeze({
		id: run.id,
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
		currentActivity: run.currentActivity,
		turns: run.turns,
		usage: Object.freeze({ ...run.usage }),
		finalOutput: run.finalOutput,
		liveOutput: run.liveOutput,
		error: run.error,
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
	private readonly writerLocks = new Set<string>();
	private readonly maxConcurrency: number;
	private readonly maxTerminalRuns: number;
	private readonly now: () => number;
	private readonly idFactory: () => string;
	private shuttingDown = false;

	constructor(
		private readonly runner: AgentRunner,
		options: AgentManagerOptions = {},
	) {
		this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 4);
		this.maxTerminalRuns = Math.max(0, options.maxTerminalRuns ?? 20);
		this.now = options.now ?? Date.now;
		this.idFactory = options.idFactory ?? createRunId;
	}

	spawn(request: SpawnRequest): AgentSnapshot {
		if (this.shuttingDown) throw new Error("Sub-agent manager is shutting down");
		const id = this.nextId();
		const run: ManagedRun = {
			id,
			...request,
			status: "queued",
			createdAt: this.now(),
			turns: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			liveOutput: "",
			stderr: "",
			activity: [],
			cancellationRequested: false,
		};
		this.runs.set(id, run);
		this.pump();
		this.emit();
		return cloneSnapshot(run);
	}

	get(id: string): AgentSnapshot | undefined {
		const run = this.runs.get(id);
		return run ? cloneSnapshot(run) : undefined;
	}

	getAll(): AgentSnapshot[] {
		return Array.from(this.runs.values(), cloneSnapshot);
	}

	subscribe(listener: ManagerListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	cancel(id: string): boolean {
		const run = this.runs.get(id);
		if (!run || isTerminalStatus(run.status)) return false;
		run.cancellationRequested = true;
		if (run.status === "queued") {
			run.status = "cancelled";
			run.endedAt = this.now();
			run.currentActivity = "cancelled";
			run.error = "Cancelled before start";
			this.pump();
			this.emit();
			if (this.trimTerminalRuns()) this.emit();
			return true;
		}

		run.currentActivity = "cancelling";
		run.handle?.cancel();
		this.emit();
		return true;
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

		const selected = () => ids.map((id) => cloneSnapshot(this.runs.get(id)!));
		const current = selected();
		onSnapshot?.(current);
		if (current.every((run) => isTerminalStatus(run.status))) return current;

		return new Promise<AgentSnapshot[]>((resolvePromise, rejectPromise) => {
			let finished = false;
			let lastUpdate = this.now();
			let updateTimer: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				unsubscribe();
				if (updateTimer) clearTimeout(updateTimer);
				signal?.removeEventListener("abort", onAbort);
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
			if (!this.runs.has(id)) return id;
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
				run.currentActivity = "capacity";
				continue;
			}
			if (run.access === "write" && this.writerLocks.has(run.cwd)) {
				run.currentActivity = "writer lock";
				continue;
			}
			this.startRun(run);
			running++;
		}
	}

	private startRun(run: ManagedRun): void {
		run.status = "running";
		run.startedAt = this.now();
		run.currentActivity = "starting";
		if (run.access === "write") this.writerLocks.add(run.cwd);

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
		run.currentActivity = progress.currentActivity;
		run.turns = progress.turns;
		run.usage = { ...progress.usage };
		run.finalOutput = progress.finalOutput;
		run.liveOutput = progress.liveOutput;
		run.activity = progress.activity.map((event) => ({ ...event }));
		if (progress.finalError) run.error = progress.finalError;
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
		} else if (result.spawnError) {
			run.status = "failed";
			run.error = `Could not start Pi: ${result.spawnError}`;
			run.currentActivity = "failed";
		} else if (result.exitCode !== 0) {
			run.status = "failed";
			const processReason = result.signal ? `signal ${result.signal}` : `exit code ${result.exitCode ?? "unknown"}`;
			run.error = result.progress.finalError || result.stderr.trim() || `Pi exited with ${processReason}`;
			run.currentActivity = "failed";
		} else if (result.progress.finalStopReason === "error" || result.progress.finalStopReason === "aborted") {
			run.status = "failed";
			run.error = result.progress.finalError || `Sub-agent stopped with ${result.progress.finalStopReason}`;
			run.currentActivity = "failed";
		} else if (!result.progress.finalAssistantSeen) {
			run.status = "failed";
			run.error = result.stderr.trim() || "Pi exited before producing a final assistant message";
			run.currentActivity = "failed";
		} else {
			run.status = "completed";
			run.error = undefined;
			run.currentActivity = "completed";
		}
		this.finishRun(run);
	}

	private failRun(run: ManagedRun, message: string): void {
		if (isTerminalStatus(run.status)) return;
		run.status = run.cancellationRequested ? "cancelled" : "failed";
		run.error = run.cancellationRequested ? "Cancelled" : message;
		run.currentActivity = run.status;
		run.endedAt = this.now();
		this.finishRun(run);
	}

	private finishRun(run: ManagedRun): void {
		if (run.access === "write") this.writerLocks.delete(run.cwd);
		run.handle = undefined;
		this.pump();
		this.emit();
		if (this.trimTerminalRuns()) this.emit();
	}

	private trimTerminalRuns(): boolean {
		const terminal = [...this.runs.values()]
			.filter((run) => isTerminalStatus(run.status))
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
