import { contextUsageFromSnapshot } from "./render.ts";
import type {
	ActiveOperation,
	AgentObservation,
	AgentPhase,
	AgentSnapshot,
	AgentStatus,
	OperationEvent,
	WaitResult,
} from "./types.ts";
import { isTerminalStatus } from "./types.ts";

export const TERMINAL_RUN_ENTRY_TYPE = "sub-agent-terminal";
export const TERMINAL_RUN_ENTRY_VERSION = 3;

export interface TerminalRunEntryData {
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

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function inferredPhase(status: AgentStatus, timestamp: number, summary?: string): AgentPhase {
	const kind = status === "running" ? "starting" : status;
	return { kind, startedAt: timestamp, ...(summary ? { summary } : {}) };
}

function phaseFrom(value: unknown, status: AgentStatus, fallbackTimestamp: number, summary?: string): AgentPhase {
	if (!isRecord(value) || typeof value.kind !== "string") return inferredPhase(status, fallbackTimestamp, summary);
	const valid = [
		"queued", "starting", "waiting_for_model", "thinking", "responding", "using_tools",
		"retrying", "compacting", "cancelling", "completed", "failed", "cancelled", "interrupted",
	].includes(value.kind);
	if (!valid) return inferredPhase(status, fallbackTimestamp, summary);
	return {
		kind: value.kind as AgentPhase["kind"],
		startedAt: numberOr(value.startedAt, fallbackTimestamp),
		...(typeof value.summary === "string" ? { summary: value.summary } : {}),
	};
}

function activeOperationsFrom(value: unknown, fallbackTimestamp: number): ActiveOperation[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!isRecord(item) || typeof item.toolCallId !== "string" || typeof item.tool !== "string" || typeof item.summary !== "string") return [];
		const startedAt = numberOr(item.startedAt, fallbackTimestamp);
		return [{
			toolCallId: item.toolCallId,
			tool: item.tool,
			summary: item.summary,
			startedAt,
			lastUpdatedAt: numberOr(item.lastUpdatedAt, startedAt),
		}];
	});
}

function recentOperationsFrom(value: unknown): OperationEvent[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!isRecord(item) || !["tool", "retry", "compaction"].includes(String(item.kind)) ||
			typeof item.summary !== "string" || typeof item.endedAt !== "number" ||
			!["completed", "failed", "cancelled"].includes(String(item.outcome))) return [];
		return [{
			kind: item.kind as OperationEvent["kind"],
			...(typeof item.tool === "string" ? { tool: item.tool } : {}),
			summary: item.summary,
			...(typeof item.startedAt === "number" ? { startedAt: item.startedAt } : {}),
			endedAt: item.endedAt,
			outcome: item.outcome as OperationEvent["outcome"],
		}];
	});
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
		(value.access !== "read" && value.access !== "bash" && value.access !== "write") ||
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
	const fallbackTimestamp = numberOr(value.endedAt, numberOr(value.startedAt, value.createdAt));
	return {
		...(value as unknown as AgentSnapshot),
		steerCount: Math.max(0, Math.floor(numberOr(value.steerCount, 0))),
		lastSteeredAt: typeof value.lastSteeredAt === "number" && Number.isFinite(value.lastSteeredAt)
			? value.lastSteeredAt
			: undefined,
		revision: numberOr(value.revision, 0),
		lastProgressAt: numberOr(value.lastProgressAt, fallbackTimestamp),
		phase: phaseFrom(value.phase, value.status, fallbackTimestamp, typeof value.currentActivity === "string" ? value.currentActivity : undefined),
		activeOperations: activeOperationsFrom(value.activeOperations, fallbackTimestamp),
		recentOperations: recentOperationsFrom(value.recentOperations),
		contextWindow: positiveNumber(value.contextWindow),
		contextTokens: value.contextTokens === null ? null : positiveNumber(value.contextTokens),
	};
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
	) return undefined;
	return value as unknown as WaitResult;
}

function timestamp(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function observationFrom(value: unknown): AgentObservation | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || !isAgentStatus(value.status) ||
		typeof value.createdAt !== "string" || typeof value.lastProgressAt !== "string" ||
		typeof value.revision !== "number" || typeof value.turns !== "number" || !isUsage(value.usage) ||
		!isRecord(value.phase) || typeof value.phase.kind !== "string" || typeof value.phase.startedAt !== "string" ||
		!Array.isArray(value.activeOperations) || !Array.isArray(value.recentOperations)) return undefined;
	const rawContext = isRecord(value.contextUsage) ? value.contextUsage : undefined;
	const contextWindow = positiveNumber(rawContext?.contextWindow);
	const contextTokens = rawContext?.tokens === null ? null : positiveNumber(rawContext?.tokens);
	const contextUsage = contextWindow !== undefined && contextTokens !== undefined
		? contextUsageFromSnapshot({ contextWindow, contextTokens })
		: undefined;
	return { ...(value as unknown as AgentObservation), contextUsage };
}

function restoreObservation(existing: AgentSnapshot, observation: AgentObservation): AgentSnapshot {
	const createdAt = timestamp(observation.createdAt) ?? existing.createdAt;
	const startedAt = timestamp(observation.startedAt) ?? existing.startedAt;
	const endedAt = timestamp(observation.endedAt) ?? existing.endedAt;
	const lastProgressAt = timestamp(observation.lastProgressAt) ?? endedAt ?? startedAt ?? createdAt;
	const phaseStartedAt = timestamp(observation.phase.startedAt) ?? lastProgressAt;
	return {
		...existing,
		...(observation.name ? { name: observation.name } : {}),
		status: observation.status,
		createdAt,
		...(startedAt !== undefined ? { startedAt } : {}),
		...(endedAt !== undefined ? { endedAt } : {}),
		steerCount: Math.max(0, Math.floor(numberOr(observation.steerCount, existing.steerCount))),
		lastSteeredAt: timestamp(observation.lastSteeredAt) ?? existing.lastSteeredAt,
		revision: observation.revision,
		lastProgressAt,
		phase: {
			kind: observation.phase.kind,
			startedAt: phaseStartedAt,
			...(observation.phase.summary ? { summary: observation.phase.summary } : {}),
		},
		activeOperations: observation.activeOperations.map((operation) => ({
			toolCallId: operation.toolCallId,
			tool: operation.tool,
			summary: operation.summary,
			startedAt: timestamp(operation.startedAt) ?? lastProgressAt,
			lastUpdatedAt: timestamp(operation.lastUpdatedAt) ?? lastProgressAt,
		})),
		recentOperations: observation.recentOperations.map((operation) => ({
			kind: operation.kind,
			...(operation.tool ? { tool: operation.tool } : {}),
			summary: operation.summary,
			...(timestamp(operation.startedAt) !== undefined ? { startedAt: timestamp(operation.startedAt)! } : {}),
			endedAt: timestamp(operation.endedAt) ?? lastProgressAt,
			outcome: operation.outcome,
		})),
		currentActivity: observation.activeOperations.at(-1)?.summary ?? observation.phase.summary ?? observation.phase.kind,
		turns: observation.turns,
		usage: observation.usage,
		...(observation.contextUsage ? {
			contextWindow: observation.contextUsage.contextWindow,
			contextTokens: observation.contextUsage.tokens,
		} : {}),
		tokensPerSecond15s: observation.tokensPerSecond15s,
		finalOutput: observation.finalOutput ?? existing.finalOutput,
		finalOutputTruncation: observation.finalOutput !== undefined && observation.outputTruncation
			? {
				content: observation.finalOutput,
				truncated: true,
				truncatedBy: observation.outputTruncation.truncatedBy,
				totalLines: observation.outputTruncation.originalLines,
				totalBytes: observation.outputTruncation.originalBytes,
				outputLines: observation.outputTruncation.visibleLines,
				outputBytes: observation.outputTruncation.visibleBytes,
				lastLinePartial: false,
				firstLineExceedsLimit: false,
				maxLines: observation.outputTruncation.visibleLines,
				maxBytes: observation.outputTruncation.visibleBytes,
			}
			: existing.finalOutputTruncation,
		fullOutputPath: observation.outputTruncation?.fullOutputPath ?? existing.fullOutputPath,
		liveOutput: observation.liveOutput ?? "",
		error: observation.error,
		errorOriginalBytes: observation.errorTruncation?.originalBytes ?? existing.errorOriginalBytes,
	};
}

function interrupted(run: AgentSnapshot): AgentSnapshot {
	if (isTerminalStatus(run.status)) return run;
	const endedAt = run.endedAt ?? run.lastProgressAt ?? run.createdAt;
	return {
		...run,
		status: "interrupted",
		endedAt,
		revision: run.revision + 1,
		lastProgressAt: endedAt,
		phase: { kind: "interrupted", startedAt: endedAt },
		activeOperations: [],
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
		if (!existing) {
			runs.set(run.id, run);
			return;
		}
		const runIsTerminal = isTerminalStatus(run.status);
		const existingIsTerminal = isTerminalStatus(existing.status);
		if (runIsTerminal !== existingIsTerminal) {
			if (runIsTerminal) runs.set(run.id, run);
			return;
		}
		if (run.revision >= existing.revision) runs.set(run.id, run);
	};

	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		if (entry.type === "message" && isRecord(entry.message) && entry.message.role === "toolResult") {
			if (entry.message.toolName === "agent_spawn" && isRecord(entry.message.details)) {
				const run = snapshotFrom(entry.message.details.run);
				if (run) store(run);
			}
			if (entry.message.toolName === "agent_steer" && isRecord(entry.message.details)) {
				const run = snapshotFrom(entry.message.details.run);
				if (run) store(run);
			}
			if (entry.message.toolName === "agent_wait" && isRecord(entry.message.details)) {
				for (const value of Array.isArray(entry.message.details.results) ? entry.message.details.results : []) {
					const result = waitResultFrom(value);
					const existing = result ? runs.get(result.id) : undefined;
					if (!result || !existing) continue;
					const endedAt = existing.endedAt ?? existing.createdAt + result.elapsedMs;
					store({
						...existing,
						...(result.name ? { name: result.name } : {}),
						status: result.status,
						endedAt,
						revision: existing.revision + 1,
						lastProgressAt: endedAt,
						phase: { kind: result.status, startedAt: endedAt },
						activeOperations: [],
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
			if (entry.message.toolName === "agent_status" && isRecord(entry.message.details)) {
				for (const value of Array.isArray(entry.message.details.agents) ? entry.message.details.agents : []) {
					const observation = observationFrom(value);
					const existing = observation ? runs.get(observation.id) : undefined;
					if (observation && existing) store(restoreObservation(existing, observation));
				}
			}
		}
		if (entry.type === "custom" && entry.customType === TERMINAL_RUN_ENTRY_TYPE && isRecord(entry.data)) {
			if (entry.data.version !== 1 && entry.data.version !== 2 && entry.data.version !== TERMINAL_RUN_ENTRY_VERSION) continue;
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
