import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	getMarkdownTheme,
	truncateHead,
	type Theme,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { truncateUtf8Head, truncateUtf8Tail } from "./runner.ts";
import type {
	AgentObservation,
	AgentSnapshot,
	AgentStatusResponse,
	CancelToolDetails,
	SpawnToolDetails,
	StatusToolDetails,
	UsageSummary,
	WaitResult,
} from "./types.ts";
import { addUsageSummary, cloneUsageSummary, createUsageSummary, isTerminalStatus } from "./types.ts";

export const MODEL_VISIBLE_OUTPUT_BYTES = DEFAULT_MAX_BYTES;
export const MODEL_VISIBLE_DIAGNOSTIC_BYTES = 8 * 1024;
// Reserve room for tool-detail attribution metadata around the shared projection.
export const STATUS_RESPONSE_MAX_BYTES = Math.min(DEFAULT_MAX_BYTES, 50 * 1024) - 2_048;
export const STATUS_RESPONSE_MAX_LINES = Math.min(DEFAULT_MAX_LINES, 2_000) - 1;
const MAX_OBSERVATION_OPERATIONS = 20;

export function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remainder = seconds % 60;
	if (hours > 0) return `${hours}h${minutes}m`;
	if (minutes > 0) return `${minutes}m${remainder}s`;
	return `${remainder}s`;
}

export function formatTokens(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

export function formatCost(cost: number): string {
	return `$${cost.toFixed(4)}`;
}

export function formatTokenRate(rate: number | undefined): string {
	if (rate === undefined) return "-";
	if (rate < 1_000) return rate.toFixed(1);
	return `${(rate / 1_000).toFixed(1)}k`;
}

export function formatUsage(usage: Readonly<UsageSummary>): string {
	const parts: string[] = [];
	if (usage.input) parts.push(`in:${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`out:${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`cache-r:${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`cache-w:${formatTokens(usage.cacheWrite)}`);
	if (usage.cost.total) parts.push(formatCost(usage.cost.total));
	return parts.join(" ");
}

export function aggregateUsage(items: readonly { usage: Readonly<UsageSummary> }[]): UsageSummary {
	const usage = createUsageSummary();
	for (const item of items) addUsageSummary(usage, item.usage);
	return usage;
}

export function shortModel(model: string): string {
	return model.split("/").at(-1) ?? model;
}

export function formatAgentLabel(agent: { id: string; name?: string }): string {
	return agent.name ? `${agent.name} (${agent.id})` : agent.id;
}

export function preview(value: string, length = 80): string {
	const singleLine = value.replace(/\s+/gu, " ").trim();
	return singleLine.length > length ? `${singleLine.slice(0, length - 3)}...` : singleLine;
}

export function truncateModelVisibleOutput(
	output: string,
	truncation?: TruncationResult,
	fullOutputPath?: string,
): string {
	const effective = truncation ?? truncateHead(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: MODEL_VISIBLE_OUTPUT_BYTES,
	});
	if (!effective.truncated) return output;

	const location = fullOutputPath ? ` Full output: ${fullOutputPath}` : " Full output unavailable.";
	const formatNotice = (outputLines: number, outputBytes: number) =>
		`[Output truncated: showing ${outputLines} of ${effective.totalLines} lines ` +
		`(${formatSize(outputBytes)} of ${formatSize(effective.totalBytes)}).${location}]`;
	const provisionalNotice = formatNotice(effective.outputLines, effective.outputBytes);
	const availableBytes = Math.max(
		0,
		MODEL_VISIBLE_OUTPUT_BYTES - Buffer.byteLength(`\n\n${provisionalNotice}`, "utf8"),
	);
	const visible = truncateHead(output, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: availableBytes,
	});
	const notice = formatNotice(visible.outputLines, visible.outputBytes);
	return `${visible.content ? `${visible.content}\n\n` : ""}${notice}`;
}

export function truncateModelVisibleDiagnostic(diagnostic: string): string {
	if (Buffer.byteLength(diagnostic, "utf8") <= MODEL_VISIBLE_DIAGNOSTIC_BYTES) return diagnostic;
	const suffix = "\n[Diagnostic truncated at 8 KB. The bounded full diagnostic remains in tool details.]";
	return truncateUtf8Head(
		diagnostic,
		MODEL_VISIBLE_DIAGNOSTIC_BYTES - Buffer.byteLength(suffix, "utf8"),
	) + suffix;
}

function iso(timestamp: number): string {
	return new Date(Number.isFinite(timestamp) ? timestamp : 0).toISOString();
}

function boundedString(value: string, bytes: number): string {
	return truncateUtf8Head(value, bytes);
}

function lineCount(value: string): number {
	return value.length === 0 ? 0 : value.split("\n").length;
}

interface ProjectionLimits {
	activeOperations: number;
	recentOperations: number;
	outputBytes: number;
	errorBytes: number;
}

export function observationFromSnapshot(
	run: AgentSnapshot,
	now = Date.now(),
	limits: Partial<ProjectionLimits> = {},
): AgentObservation {
	const activeLimit = Math.max(0, limits.activeOperations ?? run.activeOperations.length);
	const recentLimit = Math.max(0, limits.recentOperations ?? MAX_OBSERVATION_OPERATIONS);
	const activeOperations = run.activeOperations.slice(-activeLimit || run.activeOperations.length);
	const recentOperations = run.recentOperations.slice(-recentLimit || run.recentOperations.length);
	const visibleActiveOperations = activeLimit === 0 ? [] : activeOperations;
	const visibleRecentOperations = recentLimit === 0 ? [] : recentOperations;
	const outputBudget = Math.max(0, limits.outputBytes ?? MODEL_VISIBLE_OUTPUT_BYTES);
	const errorBudget = Math.max(0, limits.errorBytes ?? MODEL_VISIBLE_DIAGNOSTIC_BYTES);
	const terminal = isTerminalStatus(run.status);
	const endpoint = terminal ? (run.endedAt ?? now) : now;
	const elapsedStart = run.startedAt ?? run.createdAt;
	const originalOutput = terminal ? (run.finalOutput ?? "") : run.liveOutput;
	const existingOriginalBytes = terminal && run.finalOutputTruncation?.truncated
		? run.finalOutputTruncation.totalBytes
		: Buffer.byteLength(originalOutput, "utf8");
	const existingOriginalLines = terminal && run.finalOutputTruncation?.truncated
		? run.finalOutputTruncation.totalLines
		: lineCount(originalOutput);
	const visibleOutput = terminal
		? truncateUtf8Head(originalOutput, outputBudget)
		: truncateUtf8Tail(originalOutput, outputBudget);
	const visibleBytes = Buffer.byteLength(visibleOutput, "utf8");
	const visibleLines = lineCount(visibleOutput);
	const wasTruncated = existingOriginalBytes > visibleBytes;
	const error = run.error === undefined ? undefined : boundedString(run.error, errorBudget);
	const originalErrorBytes = run.error === undefined
		? 0
		: (run.errorOriginalBytes ?? Buffer.byteLength(run.error, "utf8"));
	const visibleErrorBytes = error === undefined ? 0 : Buffer.byteLength(error, "utf8");

	const observation: AgentObservation = {
		id: run.id,
		...(run.name ? { name: boundedString(run.name, 256) } : {}),
		status: run.status,
		model: boundedString(run.model, 512),
		thinking: run.thinking,
		access: run.access,
		cwd: boundedString(run.cwd, 2_048),
		createdAt: iso(run.createdAt),
		...(run.startedAt !== undefined ? { startedAt: iso(run.startedAt) } : {}),
		...(run.endedAt !== undefined ? { endedAt: iso(run.endedAt) } : {}),
		elapsedMs: Math.max(0, endpoint - elapsedStart),
		lastProgressAt: iso(run.lastProgressAt),
		quietMs: Math.max(0, endpoint - run.lastProgressAt),
		revision: run.revision,
		phase: {
			kind: run.phase.kind,
			...(run.phase.summary ? { summary: boundedString(run.phase.summary, 512) } : {}),
			startedAt: iso(run.phase.startedAt),
			ageMs: Math.max(0, endpoint - run.phase.startedAt),
		},
		activeOperations: visibleActiveOperations.map((operation) => ({
			toolCallId: boundedString(operation.toolCallId, 256),
			tool: boundedString(operation.tool, 128),
			summary: boundedString(operation.summary, 512),
			startedAt: iso(operation.startedAt),
			lastUpdatedAt: iso(operation.lastUpdatedAt),
			runningMs: Math.max(0, endpoint - operation.startedAt),
			quietMs: Math.max(0, endpoint - operation.lastUpdatedAt),
		})),
		...(run.activeOperations.length > visibleActiveOperations.length ? {
			activeOperationsOmitted: run.activeOperations.length - visibleActiveOperations.length,
		} : {}),
		recentOperations: visibleRecentOperations.map((operation) => ({
			kind: operation.kind,
			...(operation.tool ? { tool: boundedString(operation.tool, 128) } : {}),
			summary: boundedString(operation.summary, 512),
			...(operation.startedAt !== undefined ? { startedAt: iso(operation.startedAt) } : {}),
			endedAt: iso(operation.endedAt),
			...(operation.startedAt !== undefined ? { durationMs: Math.max(0, operation.endedAt - operation.startedAt) } : {}),
			outcome: operation.outcome,
		})),
		...(run.recentOperations.length > visibleRecentOperations.length ? {
			recentOperationsOmitted: run.recentOperations.length - visibleRecentOperations.length,
		} : {}),
		turns: run.turns,
		...(run.tokensPerSecond15s !== undefined ? { tokensPerSecond15s: run.tokensPerSecond15s } : {}),
		usage: cloneUsageSummary(run.usage),
		...(error !== undefined ? { error } : {}),
		...(error !== undefined && originalErrorBytes > visibleErrorBytes ? {
			errorTruncation: {
				truncated: true,
				originalBytes: originalErrorBytes,
				visibleBytes: visibleErrorBytes,
			},
		} : {}),
		...(terminal ? { finalOutput: visibleOutput } : { liveOutput: visibleOutput }),
		...(wasTruncated ? {
			outputTruncation: {
				truncated: true,
				truncatedBy: run.finalOutputTruncation?.truncatedBy ?? "bytes",
				originalLines: existingOriginalLines,
				originalBytes: existingOriginalBytes,
				visibleLines,
				visibleBytes,
				...(run.fullOutputPath ? { fullOutputPath: boundedString(run.fullOutputPath, 2_048) } : {}),
			},
		} : {}),
	};
	return observation;
}

function serializedBytes(response: AgentStatusResponse): number {
	return Buffer.byteLength(JSON.stringify(response), "utf8");
}

/** Build one aggregate-bounded, JSON-safe projection for both tool content and details. */
export function statusResponseFromSnapshots(
	snapshots: readonly AgentSnapshot[],
	waited: boolean,
	now = Date.now(),
): AgentStatusResponse {
	const count = Math.max(1, snapshots.length);
	let activeOperationLimit = 100;
	let recentOperationLimit = Math.min(MAX_OBSERVATION_OPERATIONS, Math.max(2, Math.floor(40 / count)));
	let outputBudget = Math.max(0, Math.floor((STATUS_RESPONSE_MAX_BYTES - 8_192) / count));
	let errorBudget = Math.min(MODEL_VISIBLE_DIAGNOSTIC_BYTES, Math.max(512, Math.floor(8_192 / count)));
	const build = (): AgentStatusResponse => ({
		observedAt: iso(now),
		waited,
		allTerminal: snapshots.every((run) => isTerminalStatus(run.status)),
		agents: snapshots.map((run) => observationFromSnapshot(run, now, {
			activeOperations: activeOperationLimit,
			recentOperations: recentOperationLimit,
			outputBytes: outputBudget,
			errorBytes: errorBudget,
		})),
	});

	let response = build();
	while (serializedBytes(response) > STATUS_RESPONSE_MAX_BYTES && recentOperationLimit > 0) {
		recentOperationLimit = Math.floor(recentOperationLimit / 2);
		response = build();
	}
	while (serializedBytes(response) > STATUS_RESPONSE_MAX_BYTES && outputBudget > 0) {
		outputBudget = Math.floor(outputBudget / 2);
		response = build();
	}
	while (serializedBytes(response) > STATUS_RESPONSE_MAX_BYTES && errorBudget > 0) {
		errorBudget = Math.floor(errorBudget / 2);
		response = build();
	}
	while (serializedBytes(response) > STATUS_RESPONSE_MAX_BYTES && activeOperationLimit > 0) {
		activeOperationLimit = Math.floor(activeOperationLimit / 2);
		response = build();
	}
	if (serializedBytes(response) > STATUS_RESPONSE_MAX_BYTES) {
		throw new Error("Agent status metadata exceeds the 50 KB response limit");
	}
	return response;
}

export function formatStatusProgress(response: AgentStatusResponse): string {
	const lines = response.agents.slice(0, STATUS_RESPONSE_MAX_LINES - 1).map((run) => {
		const operation = run.activeOperations.at(-1);
		const activity = operation
			? `${operation.summary} ${formatDuration(operation.runningMs)}, quiet ${formatDuration(operation.quietMs)}`
			: `${run.phase.summary ?? run.phase.kind.replaceAll("_", " ")} ${formatDuration(run.phase.ageMs)}, quiet ${formatDuration(run.quietMs)}`;
		return `${formatAgentLabel(run)} [${run.access}] ${run.status}: ${activity}`;
	});
	if (lines.length < response.agents.length) lines.push(`[${response.agents.length - lines.length} agents omitted]`);
	const text = lines.join("\n");
	if (Buffer.byteLength(text, "utf8") <= STATUS_RESPONSE_MAX_BYTES) return text;
	const notice = "\n[Progress display truncated; structured details remain available]";
	return truncateUtf8Head(text, STATUS_RESPONSE_MAX_BYTES - Buffer.byteLength(notice, "utf8")) + notice;
}

interface SpawnCallArgs {
	name?: string;
	prompt?: string;
	model?: string;
	thinking?: string;
	cwd?: string;
	access?: string;
}

interface ToolResultLike<T> {
	content: Array<{ type: string; text?: string }>;
	details?: T;
}

export function renderSpawnCall(args: SpawnCallArgs, theme: Theme): Text {
	const configuration = [
		args.model ?? "inherit model",
		args.thinking ?? "inherit thinking",
		args.cwd ?? "inherit cwd",
		args.access ?? "read",
	].join(" | ");
	const text =
		theme.fg("toolTitle", theme.bold("agent_spawn ")) +
		(args.name ? `${theme.fg("accent", preview(args.name, 40))} ` : "") +
		theme.fg("dim", preview(args.prompt ?? "...")) +
		"\n" +
		theme.fg("muted", configuration);
	return new Text(text, 0, 0);
}

export function renderSpawnResult(result: ToolResultLike<SpawnToolDetails>, _options: unknown, theme: Theme): Text {
	const run = result.details?.run;
	if (!run) return new Text(result.content[0]?.text ?? "Could not start sub-agent", 0, 0);
	const state = run.status === "running" ? "started" : run.status;
	return new Text(
		`${theme.fg(run.status === "running" ? "success" : "warning", formatAgentLabel(run))} ${theme.fg("muted", state)} ` +
			theme.fg("dim", `${shortModel(run.model)}/${run.thinking} ${run.access}`),
		0,
		0,
	);
}

interface AgentIdsArgs {
	ids?: string[];
	wait?: boolean;
}

export function renderCancelCall(args: AgentIdsArgs, theme: Theme): Text {
	return new Text(
		theme.fg("toolTitle", theme.bold("agent_cancel ")) + theme.fg("accent", (args.ids ?? []).join(", ")),
		0,
		0,
	);
}

export function renderCancelResult(
	result: ToolResultLike<CancelToolDetails>,
	options: { expanded: boolean },
	theme: Theme,
): Text {
	const details = result.details;
	if (!details) return new Text(result.content[0]?.text ?? "No sub-agent cancellation result", 0, 0);
	const cancelledIds = new Set(details.cancelledIds);
	const unchanged = details.runs.length - cancelledIds.size;
	let text = theme.fg(
		cancelledIds.size > 0 ? "warning" : "muted",
		`${cancelledIds.size} cancellation${cancelledIds.size === 1 ? "" : "s"} requested`,
	);
	if (unchanged > 0) text += theme.fg("dim", `, ${unchanged} unchanged`);
	if (options.expanded) {
		for (const run of details.runs) {
			const requested = cancelledIds.has(run.id);
			text += `\n${theme.fg(requested ? "warning" : "muted", formatAgentLabel(run))} ${theme.fg("dim", requested ? "cancellation requested" : run.status)}`;
		}
	}
	return new Text(text, 0, 0);
}

export function renderStatusCall(args: AgentIdsArgs, theme: Theme): Text {
	const mode = args.wait ? "wait" : "snapshot";
	return new Text(
		theme.fg("toolTitle", theme.bold(`agent_status ${mode} `)) + theme.fg("accent", (args.ids ?? []).join(", ")),
		0,
		0,
	);
}

export function renderStatusResult(
	result: ToolResultLike<StatusToolDetails>,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): Text | Container {
	const details = result.details;
	if (!details) return new Text(result.content[0]?.text ?? "No sub-agent status", 0, 0);
	if (options.isPartial) {
		return new Text(
			`${formatStatusProgress(details)}\n${theme.fg("dim", "Esc stops waiting; sub-agents continue")}`,
			0,
			0,
		);
	}

	const completed = details.agents.filter((item) => item.status === "completed").length;
	const failed = details.agents.filter((item) => item.status === "failed").length;
	const active = details.agents.length - completed - failed - details.agents.filter((item) => item.status === "cancelled" || item.status === "interrupted").length;
	const summary = `${completed} completed, ${failed} failed, ${active} active`;
	const access = details.agents.map((item) => `${formatAgentLabel(item)}:${item.access}`).join(" ");
	const usage = formatUsage(aggregateUsage(details.agents));
	if (!options.expanded) {
		return new Text(
			theme.fg(failed > 0 ? "warning" : details.allTerminal ? "success" : "warning", summary) +
				(access ? `\n${theme.fg("dim", access)}` : "") +
				(usage ? `\n${theme.fg("dim", usage)}` : ""),
			0,
			0,
		);
	}

	const container = new Container();
	container.addChild(new Text(theme.fg(failed > 0 ? "warning" : "success", summary), 0, 0));
	for (const item of details.agents) {
		container.addChild(new Spacer(1));
		const color = item.status === "completed" ? "success" : item.status === "failed" ? "error" : "muted";
		container.addChild(new Text(
			`${theme.fg(color, theme.bold(`${formatAgentLabel(item)} ${item.status}`))} ${theme.fg("dim", `${shortModel(item.model)}/${item.thinking} ${item.access} ${formatDuration(item.elapsedMs)}`)}`,
			0,
			0,
		));
		container.addChild(new Text(theme.fg("dim", `Phase: ${item.phase.kind} ${formatDuration(item.phase.ageMs)}, quiet ${formatDuration(item.quietMs)}`), 0, 0));
		for (const operation of item.activeOperations) {
			container.addChild(new Text(`Active: ${operation.summary} ${formatDuration(operation.runningMs)}, quiet ${formatDuration(operation.quietMs)}`, 0, 0));
		}
		for (const operation of item.recentOperations) {
			container.addChild(new Text(theme.fg("dim", `${operation.endedAt} ${operation.summary} ${operation.outcome}${operation.durationMs === undefined ? "" : ` ${formatDuration(operation.durationMs)}`}`), 0, 0));
		}
		if (item.error) container.addChild(new Text(theme.fg("error", item.error), 0, 0));
		const output = item.finalOutput ?? item.liveOutput;
		if (output) container.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
		if (item.outputTruncation?.fullOutputPath) {
			container.addChild(new Text(theme.fg("warning", `Full output: ${item.outputTruncation.fullOutputPath}`), 0, 0));
		}
	}
	if (usage) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", `Total: ${usage}`), 0, 0));
	}
	return container;
}

/** Historical conversion retained for agent_wait session migration tests. */
export function waitResultFromSnapshot(run: AgentSnapshot): WaitResult {
	if (!isTerminalStatus(run.status)) throw new Error(`Sub-agent ${run.id} is not terminal`);
	return {
		id: run.id,
		...(run.name ? { name: run.name } : {}),
		status: run.status,
		output: run.finalOutput ?? "",
		...(run.finalOutputTruncation ? { outputTruncation: run.finalOutputTruncation } : {}),
		...(run.fullOutputPath ? { fullOutputPath: run.fullOutputPath } : {}),
		...(run.error ? { error: run.error } : {}),
		model: run.model,
		thinking: run.thinking,
		cwd: run.cwd,
		elapsedMs: Math.max(0, (run.endedAt ?? Date.now()) - (run.startedAt ?? run.createdAt)),
		turns: run.turns,
		usage: cloneUsageSummary(run.usage),
	};
}
