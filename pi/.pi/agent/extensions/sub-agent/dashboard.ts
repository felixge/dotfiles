import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import type { AgentManager } from "./manager.ts";
import type { AgentSnapshot, AgentStatus } from "./types.ts";
import { isTerminalStatus } from "./types.ts";
import { formatAgentLabel, formatDuration, formatUsage, shortModel } from "./render.ts";

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
	}
}

function statusColor(status: AgentStatus): "success" | "error" | "warning" | "muted" {
	if (status === "completed") return "success";
	if (status === "failed") return "error";
	if (status === "running") return "warning";
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

class AgentsDashboard {
	private selected = 0;
	private selectedId?: string;
	private detail = false;
	private unsubscribe: () => void;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly manager: AgentManager,
		private readonly done: () => void,
		private readonly requestCancel: (run: AgentSnapshot) => void,
	) {
		this.unsubscribe = manager.subscribe(() => {
			this.normalizeSelection();
			tui.requestRender();
		});
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
		const safeWidth = Math.max(20, width);
		const innerWidth = safeWidth - 2;
		const maxLines = Math.max(8, Math.floor(this.tui.terminal.rows * 0.8));
		const body = this.detail ? this.renderDetail(innerWidth, maxLines - 2) : this.renderList(innerWidth, maxLines - 2);
		return [
			this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`),
			...body.slice(0, maxLines - 2).map((line) => this.row(line, innerWidth)),
			this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`),
		];
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe();
	}

	private runs(): AgentSnapshot[] {
		return sortRuns(this.manager.getAll());
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
		const lines = [
			` ${this.theme.fg("accent", this.theme.bold("Sub-agents"))}`,
			this.theme.fg("dim", ` STATUS ${"AGENT".padEnd(24)} ELAPSED   MODEL/THINKING       CURRENT`),
		];
		if (runs.length === 0) lines.push(this.theme.fg("muted", " No sub-agents in this session"));

		const availableRows = Math.max(1, maxLines - 3);
		let start = Math.max(0, this.selected - availableRows + 1);
		if (runs.length <= availableRows) start = 0;
		for (let index = start; index < Math.min(runs.length, start + availableRows); index++) {
			const run = runs[index]!;
			const selected = index === this.selected;
			const elapsed = formatDuration((run.endedAt ?? Date.now()) - (run.startedAt ?? run.createdAt));
			const model = `${shortModel(run.model)}/${run.thinking}`;
			const coloredStatus = this.theme.fg(statusColor(run.status), statusLabel(run.status).padEnd(6));
			const agent = this.theme.fg("accent", padColumn(formatAgentLabel(run), 24));
			const line = `${selected ? this.theme.fg("accent", ">") : " "} ${coloredStatus} ${agent} ${elapsed.padEnd(9)} ${model.padEnd(20)} ${run.currentActivity ?? run.status}`;
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
			` Thinking: ${run.thinking}`,
			` Access: ${run.access}`,
			` Cwd: ${run.cwd}`,
			` Elapsed: ${elapsed}`,
			` Turns: ${run.turns}`,
			` Usage: ${formatUsage(run.usage) || "none"}`,
			` Current: ${run.currentActivity ?? run.status}`,
		];
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

export async function showAgentsDashboard(ctx: ExtensionCommandContext, manager: AgentManager): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			let dashboard: AgentsDashboard;
			const requestCancel = (run: AgentSnapshot) => {
				void ctx.ui.confirm("Cancel sub-agent?", `${formatAgentLabel(run)}: ${run.prompt.slice(0, 160)}`).then((confirmed) => {
					if (confirmed) manager.cancel(run.id);
					tui.requestRender();
				});
			};
			dashboard = new AgentsDashboard(tui, theme, manager, () => done(), requestCancel);
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
