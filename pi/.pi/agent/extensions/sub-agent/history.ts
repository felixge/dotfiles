import type { AgentSnapshot, AgentStatus, WaitResult } from "./types.ts";
import { isTerminalStatus } from "./types.ts";

export const TERMINAL_RUN_ENTRY_TYPE = "sub-agent-terminal";
const TERMINAL_RUN_ENTRY_VERSION = 1;

interface TerminalRunEntryData {
	version: typeof TERMINAL_RUN_ENTRY_VERSION;
	run: AgentSnapshot;
}

export interface AgentHistory {
	runs: AgentSnapshot[];
	persistedTerminalIds: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isAgentStatus(value: unknown): value is AgentStatus {
	return (
		value === "queued" ||
		value === "running" ||
		value === "completed" ||
		value === "failed" ||
		value === "cancelled" ||
		value === "interrupted"
	);
}

function isUsage(value: unknown): boolean {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	return [
		value.input,
		value.output,
		value.cacheRead,
		value.cacheWrite,
		value.totalTokens,
		value.cost.input,
		value.cost.output,
		value.cost.cacheRead,
		value.cost.cacheWrite,
		value.cost.total,
	].every((item) => typeof item === "number" && Number.isFinite(item));
}

function snapshotFrom(value: unknown): AgentSnapshot | undefined {
	if (!isRecord(value) || !isAgentStatus(value.status)) return undefined;
	if (
		typeof value.id !== "string" ||
		typeof value.originEntryId !== "string" ||
		typeof value.parentRunId !== "string" ||
		typeof value.prompt !== "string" ||
		typeof value.model !== "string" ||
		typeof value.thinking !== "string" ||
		!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.thinking) ||
		typeof value.cwd !== "string" ||
		(value.access !== "read" && value.access !== "write") ||
		typeof value.createdAt !== "number" ||
		!Number.isFinite(value.createdAt) ||
		typeof value.turns !== "number" ||
		!isUsage(value.usage) ||
		typeof value.liveOutput !== "string" ||
		typeof value.stderr !== "string" ||
		!Array.isArray(value.activity)
	) {
		return undefined;
	}
	return value as unknown as AgentSnapshot;
}

function waitResultFrom(value: unknown): WaitResult | undefined {
	if (!isRecord(value) || !isAgentStatus(value.status) || !isTerminalStatus(value.status)) return undefined;
	if (
		typeof value.id !== "string" ||
		typeof value.output !== "string" ||
		typeof value.model !== "string" ||
		typeof value.thinking !== "string" ||
		typeof value.cwd !== "string" ||
		typeof value.elapsedMs !== "number" ||
		typeof value.turns !== "number" ||
		!isUsage(value.usage)
	) {
		return undefined;
	}
	return value as unknown as WaitResult;
}

function interrupted(run: AgentSnapshot): AgentSnapshot {
	if (isTerminalStatus(run.status)) return run;
	return {
		...run,
		status: "interrupted",
		endedAt: run.endedAt ?? run.createdAt,
		currentActivity: "interrupted",
		error: "Sub-agent was interrupted before recording a terminal result",
		tokensPerSecond15s: undefined,
	};
}

export function persistedTerminalRun(run: AgentSnapshot): TerminalRunEntryData {
	const { tokensPerSecond15s: _tokenRate, ...snapshot } = run;
	return {
		version: TERMINAL_RUN_ENTRY_VERSION,
		run: { ...snapshot, liveOutput: "" },
	};
}

export function readAgentHistory(entries: readonly unknown[]): AgentHistory {
	const runs = new Map<string, AgentSnapshot>();
	const persistedTerminalIds = new Set<string>();
	const store = (run: AgentSnapshot) => {
		const existing = runs.get(run.id);
		if (!existing || isTerminalStatus(run.status) || !isTerminalStatus(existing.status)) runs.set(run.id, run);
	};

	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		if (entry.type === "message" && isRecord(entry.message) && entry.message.role === "toolResult") {
			if (entry.message.toolName === "agent_spawn" && isRecord(entry.message.details)) {
				const run = snapshotFrom(entry.message.details.run);
				if (run) store(run);
			}
			if (entry.message.toolName === "agent_wait" && isRecord(entry.message.details)) {
				for (const value of Array.isArray(entry.message.details.results) ? entry.message.details.results : []) {
					const result = waitResultFrom(value);
					const existing = result ? runs.get(result.id) : undefined;
					if (!result || !existing) continue;
					store({
						...existing,
						...(result.name ? { name: result.name } : {}),
						status: result.status,
						endedAt: existing.endedAt ?? existing.createdAt + result.elapsedMs,
						currentActivity: result.status,
						turns: result.turns,
						usage: result.usage,
						finalOutput: result.output,
						finalOutputTruncation: result.outputTruncation,
						fullOutputPath: result.fullOutputPath,
						liveOutput: "",
						error: result.error,
					});
				}
			}
		}
		if (entry.type === "custom" && entry.customType === TERMINAL_RUN_ENTRY_TYPE && isRecord(entry.data)) {
			if (entry.data.version !== TERMINAL_RUN_ENTRY_VERSION) continue;
			const run = snapshotFrom(entry.data.run);
			if (!run || !isTerminalStatus(run.status)) continue;
			store(run);
			persistedTerminalIds.add(run.id);
		}
	}

	return { runs: [...runs.values()].map(interrupted), persistedTerminalIds };
}

export function mergeAgentRuns(archived: readonly AgentSnapshot[], live: readonly AgentSnapshot[]): AgentSnapshot[] {
	const runs = new Map(archived.map((run) => [run.id, run]));
	for (const run of live) runs.set(run.id, run);
	return [...runs.values()];
}
