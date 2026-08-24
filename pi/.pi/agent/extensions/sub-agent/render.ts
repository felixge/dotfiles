import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { truncateUtf8Head } from "./runner.ts";
import type {
	AgentSnapshot,
	SpawnToolDetails,
	UsageSummary,
	WaitResult,
	WaitToolDetails,
} from "./types.ts";

export const MODEL_VISIBLE_OUTPUT_BYTES = 50 * 1024;
export const MODEL_VISIBLE_DIAGNOSTIC_BYTES = 8 * 1024;

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

export function formatUsage(usage: Readonly<UsageSummary>): string {
	const parts: string[] = [];
	if (usage.input) parts.push(`in:${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`out:${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`cache-r:${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`cache-w:${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.join(" ");
}

export function aggregateUsage(items: readonly { usage: Readonly<UsageSummary> }[]): UsageSummary {
	const usage: UsageSummary = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const item of items) {
		usage.input += item.usage.input;
		usage.output += item.usage.output;
		usage.cacheRead += item.usage.cacheRead;
		usage.cacheWrite += item.usage.cacheWrite;
		usage.cost += item.usage.cost;
	}
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

export function truncateModelVisibleOutput(output: string): string {
	if (Buffer.byteLength(output, "utf8") <= MODEL_VISIBLE_OUTPUT_BYTES) return output;
	const suffix = "\n\n[Output truncated at 50 KB. The bounded full result remains in tool details.]";
	const truncated = truncateUtf8Head(output, MODEL_VISIBLE_OUTPUT_BYTES - Buffer.byteLength(suffix, "utf8"));
	return `${truncated}${suffix}`;
}

export function truncateModelVisibleDiagnostic(diagnostic: string): string {
	if (Buffer.byteLength(diagnostic, "utf8") <= MODEL_VISIBLE_DIAGNOSTIC_BYTES) return diagnostic;
	const suffix = "\n[Diagnostic truncated at 8 KB. The bounded full diagnostic remains in tool details.]";
	return truncateUtf8Head(
		diagnostic,
		MODEL_VISIBLE_DIAGNOSTIC_BYTES - Buffer.byteLength(suffix, "utf8"),
	) + suffix;
}

export function formatWaitProgress(snapshots: readonly AgentSnapshot[]): string {
	return snapshots
		.map((run) => {
			const elapsed = formatDuration((run.endedAt ?? Date.now()) - (run.startedAt ?? run.createdAt));
			return `${formatAgentLabel(run)} ${run.status} ${elapsed}${run.currentActivity ? `: ${run.currentActivity}` : ""}`;
		})
		.join("\n");
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

interface WaitCallArgs {
	ids?: string[];
}

export function renderWaitCall(args: WaitCallArgs, theme: Theme): Text {
	return new Text(
		theme.fg("toolTitle", theme.bold("agent_wait ")) + theme.fg("accent", (args.ids ?? []).join(", ")),
		0,
		0,
	);
}

export function renderWaitResult(
	result: ToolResultLike<WaitToolDetails>,
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): Text | Container {
	const details = result.details;
	if (options.isPartial || details?.final === false) {
		return new Text(
			(details?.snapshots ?? [])
				.map((run) => {
					const color = run.status === "failed" ? "error" : run.status === "completed" ? "success" : "warning";
					return `${theme.fg(color, formatAgentLabel(run))} ${theme.fg("muted", run.status)}${run.currentActivity ? ` ${theme.fg("dim", run.currentActivity)}` : ""}`;
				})
				.join("\n") || theme.fg("muted", "waiting"),
			0,
			0,
		);
	}

	const results = details?.results;
	if (!results) return new Text(result.content[0]?.text ?? "No sub-agent results", 0, 0);
	const completed = results.filter((item) => item.status === "completed").length;
	const failed = results.filter((item) => item.status === "failed").length;
	const cancelled = results.filter((item) => item.status === "cancelled").length;
	const summary = `${completed} completed, ${failed} failed, ${cancelled} cancelled`;
	const usage = formatUsage(aggregateUsage(results));

	if (!options.expanded) {
		return new Text(
			theme.fg(failed > 0 ? "warning" : "success", summary) + (usage ? `\n${theme.fg("dim", usage)}` : ""),
			0,
			0,
		);
	}

	const container = new Container();
	container.addChild(new Text(theme.fg(failed > 0 ? "warning" : "success", summary), 0, 0));
	for (const item of results) {
		container.addChild(new Spacer(1));
		const color = item.status === "completed" ? "success" : item.status === "failed" ? "error" : "muted";
		container.addChild(
			new Text(
				`${theme.fg(color, theme.bold(`${formatAgentLabel(item)} ${item.status}`))} ${theme.fg("dim", `${shortModel(item.model)}/${item.thinking} ${formatDuration(item.elapsedMs)}`)}`,
				0,
				0,
			),
		);
		if (item.error) container.addChild(new Text(theme.fg("error", item.error), 0, 0));
		if (item.output) container.addChild(new Markdown(item.output, 0, 0, getMarkdownTheme()));
	}
	if (usage) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", `Total: ${usage}`), 0, 0));
	}
	return container;
}

export function waitResultFromSnapshot(run: AgentSnapshot): WaitResult {
	if (!isTerminal(run.status)) throw new Error(`Sub-agent ${run.id} is not terminal`);
	return {
		id: run.id,
		...(run.name ? { name: run.name } : {}),
		status: run.status,
		output: run.finalOutput ?? "",
		...(run.error ? { error: run.error } : {}),
		model: run.model,
		thinking: run.thinking,
		cwd: run.cwd,
		elapsedMs: Math.max(0, (run.endedAt ?? Date.now()) - (run.startedAt ?? run.createdAt)),
		turns: run.turns,
		usage: { ...run.usage },
	};
}

function isTerminal(status: AgentSnapshot["status"]): status is WaitResult["status"] {
	return status === "completed" || status === "failed" || status === "cancelled";
}
