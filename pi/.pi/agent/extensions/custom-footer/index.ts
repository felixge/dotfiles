/**
 * Custom Footer Extension
 *
 * Replaces the default footer with a custom one that shows elapsed session time
 * on the stats line (line 2), next to token counts and cost.
 *
 * Accumulated time is persisted via pi.appendEntry() so it survives session
 * resumes. On shutdown, the elapsed time since the last resume is saved. On
 * startup, all persisted intervals are summed to produce the starting offset.
 *
 * Footer rendering logic adapted from pi's built-in FooterComponent:
 * https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/modes/interactive/components/footer.ts
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { OutputTokenRateTracker } from "./token-rate.ts";

const ENTRY_TYPE = "custom-footer";
const FAST_STATUS_EVENT = "openai-fast:status";

interface TimerEntry {
	elapsedMs: number;
}

interface FastStatus {
	enabled: boolean;
	eligible: boolean;
}

export default function (pi: ExtensionAPI) {
	// accumulatedMs: total time from previous resume cycles (restored from session entries)
	// resumeStart: timestamp when the current cycle began
	let accumulatedMs = 0;
	let resumeStart = Date.now();
	let timer: ReturnType<typeof setInterval> | undefined;
	let fastStatus: FastStatus | undefined;
	let requestRender: (() => void) | undefined;
	const tokenRate = new OutputTokenRateTracker();

	pi.events.on(FAST_STATUS_EVENT, (data) => {
		const status = data as Partial<FastStatus>;
		if (typeof status.enabled !== "boolean" || typeof status.eligible !== "boolean") return;
		fastStatus = { enabled: status.enabled, eligible: status.eligible };
		requestRender?.();
	});

	function totalElapsed(): number {
		return accumulatedMs + (Date.now() - resumeStart);
	}

	function saveElapsed(): void {
		pi.appendEntry(ENTRY_TYPE, { elapsedMs: totalElapsed() } satisfies TimerEntry);
	}

	function restoreFromSession(entries: Iterable<{ type: string; customType?: string; data?: unknown }>): number {
		let restored = 0;
		for (const entry of entries) {
			if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
				const data = entry.data as TimerEntry | undefined;
				if (data && typeof data.elapsedMs === "number") {
					restored = data.elapsedMs;
				}
			}
		}
		return restored;
	}

	function formatDuration(ms: number): string {
		const seconds = Math.floor(ms / 1000);
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const s = seconds % 60;
		if (h > 0) return `${h}h${m}m${s}s`;
		if (m > 0) return `${m}m${s}s`;
		return `${s}s`;
	}

	function formatTokens(n: number): string {
		if (n < 1000) return `${n}`;
		if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
		if (n < 1000000) return `${Math.round(n / 1000)}k`;
		return `${(n / 1000000).toFixed(1)}M`;
	}

	pi.on("session_start", async (_event, ctx) => {
		accumulatedMs = restoreFromSession(ctx.sessionManager.getEntries());
		resumeStart = Date.now();
		tokenRate.reset();

		ctx.ui.setFooter((tui, theme, footerData) => {
			const render = () => tui.requestRender();
			requestRender = render;
			const unsub = footerData.onBranchChange(render);
			timer = setInterval(render, 1000);

			return {
				dispose: () => {
					unsub();
					if (timer) clearInterval(timer);
					timer = undefined;
					if (requestRender === render) requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					// Line 1: pwd (branch) • session name
					let pwd = process.cwd();
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home && pwd.startsWith(home)) {
						pwd = `~${pwd.slice(home.length)}`;
					}
					const branch = footerData.getGitBranch();
					const sessionName = ctx.sessionManager.getSessionName();

					let pwdLine = theme.fg("dim", pwd);
					if (branch) pwdLine += theme.fg("dim", " (") + theme.fg("accent", branch) + theme.fg("dim", ")");
					if (sessionName) pwdLine += theme.fg("dim", " • ") + theme.fg("accent", sessionName);
					pwdLine = truncateToWidth(pwdLine, width, theme.fg("dim", "…"));

					// Line 2: model + thinking/fast status + usage stats
					let totalInput = 0;
					let totalOutput = 0;
					let totalCacheRead = 0;
					let totalCacheWrite = 0;
					let totalCost = 0;

					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const m = entry.message as AssistantMessage;
							totalInput += m.usage.input;
							totalOutput += m.usage.output;
							totalCacheRead += m.usage.cacheRead;
							totalCacheWrite += m.usage.cacheWrite;
							totalCost += m.usage.cost.total;
						}
					}

					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

					const thinkingLevel = pi.getThinkingLevel();
					const thinkingColor = `thinking${thinkingLevel[0].toUpperCase()}${thinkingLevel.slice(1)}` as Parameters<
						typeof theme.fg
					>[0];
					const modelName = ctx.model?.id || "no-model";
					let modelStatus = theme.fg(thinkingColor, thinkingLevel);
					if (fastStatus?.eligible) {
						const fastMode = fastStatus.enabled
							? theme.fg("success", "fast:on")
							: theme.fg("dim", "fast:off");
						modelStatus += theme.fg("dim", ", ") + fastMode;
					}

					const parts: string[] = [
						`${theme.fg("muted", modelName)} ${theme.fg("dim", "(")}${modelStatus}${theme.fg("dim", ")")}`,
					];
					if (totalInput) parts.push(theme.fg("accent", `↑${formatTokens(totalInput)}`));
					if (totalOutput) parts.push(theme.fg("success", `↓${formatTokens(totalOutput)}`));
					parts.push(theme.fg("success", `${tokenRate.rate().toFixed(1)} tok/s`));
					if (totalCacheRead) parts.push(theme.fg("dim", `R${formatTokens(totalCacheRead)}`));
					if (totalCacheWrite) parts.push(theme.fg("dim", `W${formatTokens(totalCacheWrite)}`));

					if (totalCost) {
						parts.push(theme.fg("warning", `$${totalCost.toFixed(3)}`));
					}

					const contextDisplay =
						contextPercent === "?"
							? `?/${formatTokens(contextWindow)}`
							: `${contextPercent}%/${formatTokens(contextWindow)}`;
					if (contextPercentValue > 90) {
						parts.push(theme.fg("error", contextDisplay));
					} else if (contextPercentValue > 70) {
						parts.push(theme.fg("warning", contextDisplay));
					} else {
						parts.push(theme.fg("dim", contextDisplay));
					}

					parts.push(theme.fg("accent", `⏱ ${formatDuration(totalElapsed())}`));

					const statsLine = truncateToWidth(parts.join(theme.fg("dim", " ")), width, "…");
					return [pwdLine, statsLine];
				},
			};
		});
	});

	pi.on("message_start", (event) => {
		if (event.message.role !== "assistant") return;
		tokenRate.startMessage(event.message.usage.output);
	});

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;
		tokenRate.observeMessage(event.message.usage.output);
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		tokenRate.observeMessage(event.message.usage.output);
	});

	pi.on("session_switch", async (_event, ctx) => {
		accumulatedMs = restoreFromSession(ctx.sessionManager.getEntries());
		resumeStart = Date.now();
		tokenRate.reset();
	});

	pi.on("session_shutdown", async () => {
		saveElapsed();
		if (timer) clearInterval(timer);
		timer = undefined;
	});
}
