import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import type { AgentManager } from "./manager.ts";
import type { AgentSnapshot, AgentStatus } from "./types.ts";
import { isTerminalStatus } from "./types.ts";
import {
	contextUsageFromSnapshot,
	formatAgentLabel,
	formatContextPercent,
	formatContextUsage,
	formatCost,
	formatDuration,
	formatTokenRate,
	formatUsage,
	shortModel,
} from "./render.ts";

export type AgentRunProvider = () => AgentSnapshot[];

function statusLabel(status: AgentStatus): string {
	switch (status) {
		case "running":
			return "RUN";
		case "queued":
			return "QUE";
		case "completed":
			return "DONE";
		case "failed":
			return "FAIL";
		case "cancelled":
			return "CANC";
		case "interrupted":
			return "INTR";
	}
}

function statusColor(status: AgentStatus): "success" | "error" | "warning" | "muted" {
	if (status === "completed") return "success";
	if (status === "failed") return "error";
	if (status === "running" || status === "interrupted") return "warning";
	return "muted";
}

function sortRuns(runs: AgentSnapshot[]): AgentSnapshot[] {
	const active = runs
		.filter((run) => !isTerminalStatus(run.status))
		.sort((left, right) => left.createdAt - right.createdAt);
	const terminal = runs
		.filter((run) => isTerminalStatus(run.status))
		.sort((left, right) => (right.endedAt ?? right.createdAt) - (left.endedAt ?? left.createdAt));
	return [...active, ...terminal];
}

function padColumn(value: string, width: number): string {
	const clipped = truncateToWidth(value, width, "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function padColumnStart(value: string, width: number): string {
	const clipped = truncateToWidth(value, width, "");
	return " ".repeat(Math.max(0, width - visibleWidth(clipped))) + clipped;
}

export function structuredActivity(run: AgentSnapshot, now = Date.now()): string {
	const endpoint = run.endedAt ?? now;
	const operation = run.activeOperations.at(-1);
	if (operation) {
		return `${operation.summary} ${formatDuration(endpoint - operation.startedAt)}, quiet ${formatDuration(endpoint - operation.lastUpdatedAt)}`;
	}
	const phase = run.phase.summary ?? run.phase.kind.replaceAll("_", " ");
	return `${phase} ${formatDuration(endpoint - run.phase.startedAt)}, quiet ${formatDuration(endpoint - run.lastProgressAt)}`;
}

class AgentsDashboard {
	private selected = 0;
	private selectedId?: string;
	private detail = false;
	private unsubscribe: () => void;
	private timer: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly manager: AgentManager,
		private readonly getRuns: AgentRunProvider,
		private readonly done: () => void,
		private readonly requestCancel: (run: AgentSnapshot) => void,
	) {
		this.unsubscribe = manager.subscribe(() => {
			this.normalizeSelection();
			tui.requestRender();
		});
		this.timer = setInterval(() => tui.requestRender(), 1_000);
		this.normalizeSelection();
	}

	handleInput(data: string): void {
		const runs = this.runs();
		if (matchesKey(data, Key.escape)) {
			if (this.detail) {
				this.detail = false;
			} else {
				this.done();
			}
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (runs.length > 0) this.detail = !this.detail;
			return;
		}
		if (data === "x") {
			const run = runs[this.selected];
			if (run && !isTerminalStatus(run.status)) this.requestCancel(run);
			return;
		}
		if (this.detail) return;
		if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
		if (matchesKey(data, Key.down)) this.selected = Math.min(Math.max(0, runs.length - 1), this.selected + 1);
		this.selectedId = runs[this.selected]?.id;
	}

	render(width: number): string[] {
		const renderWidth = Math.max(0, width);
		const safeWidth = Math.max(20, renderWidth);
		const innerWidth = safeWidth - 2;
		const maxLines = Math.max(8, Math.floor(this.tui.terminal.rows * 0.8));
		const body = this.detail ? this.renderDetail(innerWidth, maxLines - 2) : this.renderList(innerWidth, maxLines - 2);
		return [
			this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`),
			...body.slice(0, maxLines - 2).map((line) => this.row(line, innerWidth)),
			this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`),
		].map((line) => truncateToWidth(line, renderWidth, ""));
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe();
		clearInterval(this.timer);
	}

	private runs(): AgentSnapshot[] {
		return sortRuns(this.getRuns());
	}

	private normalizeSelection(): void {
		const runs = this.runs();
		if (runs.length === 0) {
			this.selected = 0;
			this.selectedId = undefined;
			this.detail = false;
			return;
		}
		const existingIndex = this.selectedId ? runs.findIndex((run) => run.id === this.selectedId) : -1;
		this.selected = existingIndex >= 0 ? existingIndex : Math.min(this.selected, runs.length - 1);
		this.selectedId = runs[this.selected]?.id;
	}

	private renderList(width: number, maxLines: number): string[] {
		const runs = this.runs();
		let agentWidth = Math.min(24, Math.max(6, width - 14));
		const mandatoryWidth = 14 + agentWidth;
		let remainingWidth = Math.max(0, width - mandatoryWidth);
		const showAccess = remainingWidth >= 7;
		if (showAccess) remainingWidth -= 7;
		const showCost = remainingWidth >= 10;
		if (showCost) remainingWidth -= 10;
		const showTokenRate = remainingWidth >= 8;
		if (showTokenRate) remainingWidth -= 8;
		const showElapsed = remainingWidth >= 10;
		if (showElapsed) remainingWidth -= 10;
		const showModel = remainingWidth >= 21;
		if (showModel) remainingWidth -= 21;
		const showCurrent = remainingWidth >= 9;
		if (showCurrent) remainingWidth -= 9;
		const desiredAgentWidth = Math.max(agentWidth, ...runs.map((run) => visibleWidth(formatAgentLabel(run))));
		agentWidth += Math.min(remainingWidth, desiredAgentWidth - agentWidth);

		let header = ` STAT ${padColumnStart("CTX", 6)} ${padColumn("AGENT", agentWidth)}`;
		if (showAccess) header += ` ${padColumn("ACCESS", 6)}`;
		if (showCost) header += ` ${padColumnStart("COST", 9)}`;
		if (showTokenRate) header += ` ${padColumnStart("TOK/S", 7)}`;
		if (showElapsed) header += ` ${padColumn("ELAPSED", 9)}`;
		if (showModel) header += ` ${padColumn("MODEL/THINKING", 20)}`;
		if (showCurrent) header += " CURRENT";
		const lines = [
			` ${this.theme.fg("accent", this.theme.bold("Sub-agents"))}`,
			this.theme.fg("dim", truncateToWidth(header, width)),
		];
		if (runs.length === 0) lines.push(this.theme.fg("muted", " No sub-agents on this branch"));

		const availableRows = Math.max(1, maxLines - 3);
		let start = Math.max(0, this.selected - availableRows + 1);
		if (runs.length <= availableRows) start = 0;
		for (let index = start; index < Math.min(runs.length, start + availableRows); index++) {
			const run = runs[index]!;
			const selected = index === this.selected;
			const elapsed = formatDuration((run.endedAt ?? Date.now()) - (run.startedAt ?? run.createdAt));
			const model = `${shortModel(run.model)}/${run.thinking}`;
			const coloredStatus = this.theme.fg(statusColor(run.status), statusLabel(run.status).padEnd(4));
			const context = padColumnStart(formatContextPercent(contextUsageFromSnapshot(run)), 6);
			const agent = this.theme.fg("accent", padColumn(formatAgentLabel(run), agentWidth));
			let line = `${selected ? this.theme.fg("accent", ">") : " "} ${coloredStatus} ${context} ${agent}`;
			if (showAccess) line += ` ${padColumn(run.access, 6)}`;
			if (showCost) line += ` ${this.theme.fg("warning", padColumnStart(formatCost(run.usage.cost.total), 9))}`;
			if (showTokenRate) line += ` ${this.theme.fg("success", padColumnStart(formatTokenRate(run.tokensPerSecond15s), 7))}`;
			if (showElapsed) line += ` ${elapsed.padEnd(9)}`;
			if (showModel) line += ` ${model.padEnd(20)}`;
			if (showCurrent) line += ` ${structuredActivity(run)}`;
			lines.push(selected ? this.theme.bg("selectedBg", truncateToWidth(line, width)) : truncateToWidth(line, width));
		}
		lines.push(this.theme.fg("dim", " Up/Down select  Enter details  x cancel  Esc close"));
		return lines;
	}

	private renderDetail(width: number, maxLines: number): string[] {
		const run = this.runs()[this.selected];
		if (!run) return [this.theme.fg("muted", " No selected sub-agent")];
		const elapsed = formatDuration((run.endedAt ?? Date.now()) - (run.startedAt ?? run.createdAt));
		const lines: string[] = [
			` ${this.theme.fg("accent", this.theme.bold("Sub-agent"))}`,
			` ID: ${run.id}`,
			...(run.name ? [` Name: ${run.name}`] : []),
			` Status: ${this.theme.fg(statusColor(run.status), run.status)}`,
			` Model: ${run.model}`,
			` ${formatContextUsage(contextUsageFromSnapshot(run))}`,
			` Thinking: ${run.thinking}`,
			` Access: ${run.access}`,
			` Cwd: ${run.cwd}`,
			` Elapsed: ${elapsed}`,
			` Turns: ${run.turns}`,
			` Steers accepted: ${run.steerCount}`,
			...(run.lastSteeredAt === undefined ? [] : [` Last steered: ${new Date(run.lastSteeredAt).toISOString()}`]),
			` Cost: ${formatCost(run.usage.cost.total)}`,
			` Token rate (15s avg): ${formatTokenRate(run.tokensPerSecond15s)} tok/s`,
			` Usage: ${formatUsage(run.usage) || "none"}`,
			` Phase: ${run.phase.kind} (${formatDuration((run.endedAt ?? Date.now()) - run.phase.startedAt)})`,
			` Quiet: ${formatDuration((run.endedAt ?? Date.now()) - run.lastProgressAt)}`,
			` Current: ${structuredActivity(run)}`,
		];
		for (const operation of run.activeOperations) {
			lines.push(` Active: ${operation.summary} (${formatDuration(Date.now() - operation.startedAt)}, quiet ${formatDuration(Date.now() - operation.lastUpdatedAt)})`);
		}
		if (run.error) lines.push(` Error: ${run.error}`);

		const promptLines = wrapTextWithAnsi(run.prompt, Math.max(1, width - 2)).slice(0, 3);
		lines.push("", ` ${this.theme.fg("muted", "Prompt")}`, ...promptLines.map((line) => ` ${line}`));

		const fixedReserve = lines.length + 5;
		const remaining = Math.max(2, maxLines - fixedReserve);
		const activityBudget = Math.min(6, Math.max(1, Math.floor(remaining / 3)));
		const recentActivity = run.activity.slice(-activityBudget);
		lines.push("", ` ${this.theme.fg("muted", "Recent activity")}`);
		if (recentActivity.length === 0) lines.push(` ${this.theme.fg("dim", "none")}`);
		else for (const event of recentActivity) lines.push(` ${event.isError ? this.theme.fg("error", event.summary) : event.summary}`);

		const outputBudget = Math.max(1, maxLines - lines.length - 2);
		const output = run.liveOutput || run.finalOutput || run.stderr || "(no output)";
		const outputLines = wrapTextWithAnsi(output, Math.max(1, width - 2));
		lines.push("", ` ${this.theme.fg("muted", "Live output")}`);
		for (const line of outputLines.slice(-outputBudget)) lines.push(` ${line}`);
		lines.push(this.theme.fg("dim", " Enter list  x cancel  Esc list"));
		return lines.map((line) => truncateToWidth(line, width));
	}

	private row(content: string, width: number): string {
		const clipped = truncateToWidth(content, width, "");
		const padding = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
		return this.theme.fg("border", "│") + clipped + padding + this.theme.fg("border", "│");
	}
}

export async function showAgentsDashboard(
	ctx: ExtensionCommandContext,
	manager: AgentManager,
	getRuns: AgentRunProvider,
): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			let dashboard: AgentsDashboard;
			const requestCancel = (run: AgentSnapshot) => {
				void ctx.ui.confirm("Cancel sub-agent?", `${formatAgentLabel(run)}: ${run.prompt.slice(0, 160)}`).then((confirmed) => {
					if (confirmed) manager.cancel(run.id);
					tui.requestRender();
				});
			};
			dashboard = new AgentsDashboard(tui, theme, manager, getRuns, () => done(), requestCancel);
			return {
				render: (width) => dashboard.render(width),
				handleInput: (data) => {
					dashboard.handleInput(data);
					tui.requestRender();
				},
				invalidate: () => dashboard.invalidate(),
				dispose: () => dashboard.dispose(),
			};
		},
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "90%", minWidth: 40, maxHeight: "80%", margin: 1 },
		},
	);
}
