export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AgentAccess = "read" | "write";
export type AgentStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type TerminalAgentStatus = Extract<AgentStatus, "completed" | "failed" | "cancelled">;

export interface UsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface ActivityEvent {
	timestamp: number;
	summary: string;
	isError?: boolean;
}

export interface AgentRunConfig {
	id: string;
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
	currentActivity?: string;
	turns: number;
	usage: UsageSummary;
	finalOutput?: string;
	liveOutput: string;
	error?: string;
	stderr: string;
	activity: ActivityEvent[];
}

export interface AgentSnapshot extends Readonly<Omit<AgentRun, "usage" | "activity">> {
	readonly usage: Readonly<UsageSummary>;
	readonly activity: readonly Readonly<ActivityEvent>[];
}

export interface RunnerProgress {
	currentActivity?: string;
	turns: number;
	usage: UsageSummary;
	finalOutput?: string;
	liveOutput: string;
	finalStopReason?: string;
	finalError?: string;
	finalAssistantSeen: boolean;
	agentSettled: boolean;
	activity: ActivityEvent[];
}

export interface RunnerResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
	progress: RunnerProgress;
	timedOut: boolean;
	spawnError?: string;
}

export interface RunningAgentProcess {
	result: Promise<RunnerResult>;
	cancel(): void;
}

export interface AgentRunner {
	start(config: AgentRunConfig, onProgress: (progress: RunnerProgress) => void): RunningAgentProcess;
}

export interface WaitResult {
	id: string;
	status: TerminalAgentStatus;
	output: string;
	error?: string;
	model: string;
	thinking: ThinkingLevel;
	cwd: string;
	elapsedMs: number;
	turns: number;
	usage: UsageSummary;
}

export interface SpawnToolDetails {
	run: AgentSnapshot;
}

export interface WaitToolDetails {
	final: boolean;
	snapshots?: AgentSnapshot[];
	results?: WaitResult[];
}

export const EMPTY_USAGE: Readonly<UsageSummary> = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
});

export function isTerminalStatus(status: AgentStatus): status is TerminalAgentStatus {
	return status === "completed" || status === "failed" || status === "cancelled";
}
