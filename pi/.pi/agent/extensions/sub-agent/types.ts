import type { Usage } from "@earendil-works/pi-ai";
import type { TruncationResult } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AgentAccess = "read" | "write";
export type AgentStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type TerminalAgentStatus = Extract<AgentStatus, "completed" | "failed" | "cancelled" | "interrupted">;
export type UsageSummary = Usage;
export type AgentPhaseKind =
	| "queued"
	| "starting"
	| "waiting_for_model"
	| "thinking"
	| "responding"
	| "using_tools"
	| "retrying"
	| "compacting"
	| "cancelling"
	| TerminalAgentStatus;

export interface AgentPhase {
	kind: AgentPhaseKind;
	startedAt: number;
	summary?: string;
}

export interface ActiveOperation {
	toolCallId: string;
	tool: string;
	summary: string;
	startedAt: number;
	lastUpdatedAt: number;
}

export interface OperationEvent {
	kind: "tool" | "retry" | "compaction";
	tool?: string;
	summary: string;
	startedAt?: number;
	endedAt: number;
	outcome: "completed" | "failed" | "cancelled";
}

export function createUsageSummary(): UsageSummary {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function cloneUsageSummary(usage: Readonly<UsageSummary>): UsageSummary {
	return { ...usage, cost: { ...usage.cost } };
}

function applyUsageSummary(target: UsageSummary, usage: Readonly<UsageSummary>, factor: 1 | -1): void {
	target.input += usage.input * factor;
	target.output += usage.output * factor;
	target.cacheRead += usage.cacheRead * factor;
	target.cacheWrite += usage.cacheWrite * factor;
	target.totalTokens += usage.totalTokens * factor;
	target.cost.input += usage.cost.input * factor;
	target.cost.output += usage.cost.output * factor;
	target.cost.cacheRead += usage.cost.cacheRead * factor;
	target.cost.cacheWrite += usage.cost.cacheWrite * factor;
	target.cost.total += usage.cost.total * factor;
	if (usage.cacheWrite1h !== undefined) {
		target.cacheWrite1h = (target.cacheWrite1h ?? 0) + usage.cacheWrite1h * factor;
	}
	if (usage.reasoning !== undefined) target.reasoning = (target.reasoning ?? 0) + usage.reasoning * factor;
}

export function addUsageSummary(target: UsageSummary, usage: Readonly<UsageSummary>): void {
	applyUsageSummary(target, usage, 1);
}

export function subtractUsageSummary(target: UsageSummary, usage: Readonly<UsageSummary>): void {
	applyUsageSummary(target, usage, -1);
}

export function hasUsage(usage: Readonly<UsageSummary>): boolean {
	return (
		usage.input > 0 ||
		usage.output > 0 ||
		usage.cacheRead > 0 ||
		usage.cacheWrite > 0 ||
		usage.totalTokens > 0 ||
		usage.cost.total > 0
	);
}

/** Legacy dashboard event retained for session compatibility. */
export interface ActivityEvent {
	timestamp: number;
	summary: string;
	isError?: boolean;
}

export interface AgentRunConfig {
	id: string;
	originEntryId: string;
	parentRunId: string;
	name?: string;
	prompt: string;
	model: string;
	thinking: ThinkingLevel;
	cwd: string;
	access: AgentAccess;
}

export interface AgentRun extends AgentRunConfig {
	status: AgentStatus;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	revision: number;
	lastProgressAt: number;
	phase: AgentPhase;
	activeOperations: ActiveOperation[];
	recentOperations: OperationEvent[];
	currentActivity?: string;
	turns: number;
	usage: UsageSummary;
	outputTokens: number;
	finalOutput?: string;
	finalOutputTruncation?: TruncationResult;
	fullOutputPath?: string;
	liveOutput: string;
	error?: string;
	errorOriginalBytes?: number;
	stderr: string;
	activity: ActivityEvent[];
}

export interface AgentSnapshot extends Readonly<Omit<AgentRun, "usage" | "activity" | "outputTokens" | "phase" | "activeOperations" | "recentOperations">> {
	readonly usage: Readonly<UsageSummary>;
	readonly tokensPerSecond15s?: number;
	readonly phase: Readonly<AgentPhase>;
	readonly activeOperations: readonly Readonly<ActiveOperation>[];
	readonly recentOperations: readonly Readonly<OperationEvent>[];
	readonly activity: readonly Readonly<ActivityEvent>[];
}

export interface RunnerProgress {
	revision: number;
	lastProgressAt: number;
	phase: AgentPhase;
	activeOperations: ActiveOperation[];
	recentOperations: OperationEvent[];
	currentActivity?: string;
	turns: number;
	usage: UsageSummary;
	streamingUsage?: UsageSummary;
	outputTokens: number;
	streamingOutputTokens?: number;
	finalOutput?: string;
	finalOutputTruncation?: TruncationResult;
	fullOutputPath?: string;
	liveOutput: string;
	finalStopReason?: string;
	finalError?: string;
	finalAssistantSeen: boolean;
	agentSettled: boolean;
	activity: ActivityEvent[];
}

export interface StartupSignalDeathDiagnostic {
	signal: NodeJS.Signals;
	elapsedMs: number;
	pid?: number;
	argumentCount: number;
	maxArgumentBytes: number;
}

export interface RunnerResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
	progress: RunnerProgress;
	timedOut: boolean;
	spawnError?: string;
	stdinError?: string;
	startupSignalDeath?: StartupSignalDeathDiagnostic;
}

export interface RunningAgentProcess {
	result: Promise<RunnerResult>;
	cancel(): void;
}

export interface AgentRunner {
	start(config: AgentRunConfig, onProgress: (progress: RunnerProgress) => void): RunningAgentProcess;
}

/** Historical agent_wait result shape, retained only for session migration. */
export interface WaitResult {
	id: string;
	name?: string;
	status: TerminalAgentStatus;
	output: string;
	outputTruncation?: TruncationResult;
	fullOutputPath?: string;
	error?: string;
	model: string;
	thinking: ThinkingLevel;
	cwd: string;
	elapsedMs: number;
	turns: number;
	usage: UsageSummary;
}

export interface OperationObservation {
	kind: OperationEvent["kind"];
	tool?: string;
	summary: string;
	startedAt?: string;
	endedAt: string;
	durationMs?: number;
	outcome: OperationEvent["outcome"];
}

export interface ActiveOperationObservation {
	toolCallId: string;
	tool: string;
	summary: string;
	startedAt: string;
	lastUpdatedAt: string;
	runningMs: number;
	quietMs: number;
}

export interface AgentObservation {
	id: string;
	name?: string;
	status: AgentStatus;
	model: string;
	thinking: ThinkingLevel;
	access: AgentAccess;
	cwd: string;
	createdAt: string;
	startedAt?: string;
	endedAt?: string;
	elapsedMs: number;
	lastProgressAt: string;
	quietMs: number;
	revision: number;
	phase: { kind: AgentPhaseKind; summary?: string; startedAt: string; ageMs: number };
	activeOperations: ActiveOperationObservation[];
	activeOperationsOmitted?: number;
	recentOperations: OperationObservation[];
	recentOperationsOmitted?: number;
	turns: number;
	tokensPerSecond15s?: number;
	usage: UsageSummary;
	error?: string;
	errorTruncation?: {
		truncated: true;
		originalBytes: number;
		visibleBytes: number;
	};
	liveOutput?: string;
	finalOutput?: string;
	outputTruncation?: {
		truncated: true;
		truncatedBy: "lines" | "bytes";
		originalLines: number;
		originalBytes: number;
		visibleLines: number;
		visibleBytes: number;
		fullOutputPath?: string;
	};
}

export interface AgentStatusResponse {
	observedAt: string;
	waited: boolean;
	allTerminal: boolean;
	agents: AgentObservation[];
}

export interface SpawnToolDetails {
	run: AgentSnapshot;
}

export interface CancelToolDetails {
	cancelledIds: string[];
	runs: AgentSnapshot[];
}

export interface StatusToolDetails extends AgentStatusResponse {
	attributedIds?: string[];
}

export const EMPTY_USAGE: Readonly<UsageSummary> = Object.freeze({
	...createUsageSummary(),
	cost: Object.freeze(createUsageSummary().cost),
});

export function isTerminalStatus(status: AgentStatus): status is TerminalAgentStatus {
	return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}
