import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createExtensionRuntime,
	getMarkdownTheme,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	sessionEntryToContextMessages,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ResourceLoader,
	type SessionEntry,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey, Text, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "btw-history";
const MAX_BODY_LINES = 18;

const SYSTEM_PROMPT = `You answer brief side questions about the current coding session.

Answer directly from the supplied conversation context whenever possible. You may use the read-only tools when the answer requires looking at additional code, but do not research by default. You cannot modify files or run commands. Be concise and answer only the side question.`;

export interface BtwHistoryEntry {
	question: string;
	answer: string;
	createdAt: number;
	model: string;
	usage?: Usage;
}

type DisplayEntry = BtwHistoryEntry & {
	state: "running" | "complete" | "error";
	status?: string;
};

function isHistoryEntry(value: unknown): value is BtwHistoryEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Partial<BtwHistoryEntry>;
	return (
		typeof entry.question === "string" &&
		typeof entry.answer === "string" &&
		typeof entry.createdAt === "number" &&
		typeof entry.model === "string"
	);
}

export function loadHistory(entries: readonly SessionEntry[]): BtwHistoryEntry[] {
	return entries.flatMap((entry) =>
		entry.type === "custom" && entry.customType === ENTRY_TYPE && isHistoryEntry(entry.data) ? [entry.data] : [],
	);
}

/** Remove only a terminal in-flight tool batch whose results are not all available yet. */
export function trimDanglingToolCalls(messages: readonly AgentMessage[]): AgentMessage[] {
	let batchIndex = messages.length - 1;
	while (batchIndex >= 0 && messages[batchIndex]?.role === "toolResult") batchIndex--;
	const batch = messages[batchIndex];
	if (batch?.role !== "assistant") return [...messages];

	const toolCallIds = batch.content.filter((part) => part.type === "toolCall").map((part) => part.id);
	if (toolCallIds.length === 0) return [...messages];
	const resolved = new Set(
		messages
			.slice(batchIndex + 1)
			.filter((message) => message.role === "toolResult")
			.map((message) => message.toolCallId),
	);
	return toolCallIds.every((id) => resolved.has(id)) ? [...messages] : [...messages.slice(0, batchIndex)];
}

function modelRuntime(ctx: ExtensionCommandContext): ModelRuntime {
	// ModelRegistry is the extension compatibility facade over the active runtime.
	// Reusing it preserves dynamic providers and the current authentication state.
	const runtime = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
	if (!runtime) throw new Error("This pi version does not expose the active model runtime");
	return runtime;
}

function createResourceLoader(): ResourceLoader {
	const runtime = createExtensionRuntime();
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => SYSTEM_PROMPT,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function aggregateUsage(messages: readonly AgentMessage[]): Usage | undefined {
	let total: Usage | undefined;
	for (const message of messages) {
		if ((message.role !== "assistant" && message.role !== "toolResult") || !message.usage) continue;
		const usage = message.usage;
		total ??= {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.totalTokens += usage.totalTokens;
		total.cost.input += usage.cost.input;
		total.cost.output += usage.cost.output;
		total.cost.cacheRead += usage.cost.cacheRead;
		total.cost.cacheWrite += usage.cost.cacheWrite;
		total.cost.total += usage.cost.total;
	}
	return total;
}

export function finalAssistantAnswer(messages: readonly AgentMessage[]): string {
	let message: AssistantMessage | undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const candidate = messages[index];
		if (candidate?.role === "assistant") {
			message = candidate;
			break;
		}
	}
	if (!message) throw new Error("No answer returned");
	if (message.stopReason !== "stop") {
		throw new Error(message.errorMessage ?? `Side answer stopped with ${message.stopReason}`);
	}
	const text = assistantText(message);
	if (!text) throw new Error("No answer returned");
	return text;
}

class BtwOverlay {
	private selected: number;
	private scrollOffset = 0;
	private followTail = true;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly entries: DisplayEntry[],
		private readonly close: () => void,
		private readonly cancel: () => void,
	) {
		this.selected = Math.max(0, entries.length - 1);
	}

	setAnswer(answer: string): void {
		const current = this.entries.at(-1);
		if (!current || current.state !== "running") return;
		current.answer = answer;
		if (this.selected === this.entries.length - 1) this.followTail = true;
		this.tui.requestRender();
	}

	setStatus(status: string): void {
		const current = this.entries.at(-1);
		if (!current || current.state !== "running") return;
		current.status = status;
		this.tui.requestRender();
	}

	complete(answer: string): void {
		const current = this.entries.at(-1);
		if (!current) return;
		current.answer = answer;
		current.state = "complete";
		current.status = undefined;
		if (this.selected === this.entries.length - 1) this.followTail = true;
		this.tui.requestRender();
	}

	fail(message: string): void {
		const current = this.entries.at(-1);
		if (!current) return;
		current.answer = message;
		current.state = "error";
		current.status = undefined;
		if (this.selected === this.entries.length - 1) this.followTail = true;
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.cancel();
			this.close();
			return;
		}
		if (matchesKey(data, "left")) {
			this.selected = Math.max(0, this.selected - 1);
			this.resetScroll();
		} else if (matchesKey(data, "right")) {
			this.selected = Math.min(this.entries.length - 1, this.selected + 1);
			this.resetScroll();
		} else if (matchesKey(data, "up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.followTail = false;
		} else if (matchesKey(data, "down")) {
			this.scrollOffset += 1;
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const entry = this.entries[this.selected]!;
		const innerWidth = Math.max(1, width - 2);
		const contentWidth = Math.max(1, innerWidth - 2);
		const body = this.renderBody(entry, contentWidth);
		const maxOffset = Math.max(0, body.length - MAX_BODY_LINES);
		if (this.followTail) this.scrollOffset = maxOffset;
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		if (this.scrollOffset === maxOffset) this.followTail = true;

		const visibleBody = body.slice(this.scrollOffset, this.scrollOffset + MAX_BODY_LINES);
		const border = (text: string) => this.theme.fg("border", text);
		const row = (text: string) => {
			const truncated = truncateToWidth(text, innerWidth, "", true);
			return border("│") + truncated + " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated))) + border("│");
		};

		const counter = `${this.selected + 1}/${this.entries.length}`;
		const title = ` /btw ${counter} `;
		const titleWidth = visibleWidth(title);
		const lines = [
			border("╭") + this.theme.fg("accent", title) + border(`${"─".repeat(Math.max(0, innerWidth - titleWidth))}╮`),
			...visibleBody.map((line) => row(` ${line}`)),
		];
		for (let index = visibleBody.length; index < MAX_BODY_LINES; index++) lines.push(row(""));

		const scroll = maxOffset > 0 ? ` | ${this.scrollOffset + 1}-${Math.min(body.length, this.scrollOffset + MAX_BODY_LINES)}/${body.length}` : "";
		lines.push(row(this.theme.fg("dim", ` ←→ history | ↑↓ scroll | Esc close${scroll}`)));
		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	invalidate(): void {}

	private resetScroll(): void {
		this.scrollOffset = 0;
		this.followTail = false;
	}

	private renderBody(entry: DisplayEntry, width: number): string[] {
		const question = new Text(this.theme.fg("accent", entry.question), 0, 0).render(width);
		const status = entry.state === "running" ? entry.status ?? "Thinking..." : undefined;
		const answer = entry.answer || (entry.state === "running" ? "" : "No answer.");
		const markdown = answer ? new Markdown(answer, 0, 0, getMarkdownTheme()).render(width) : [];
		return [
			...question,
			this.theme.fg("dim", "─".repeat(width)),
			...(status ? [this.theme.fg("muted", status)] : []),
			...markdown,
		];
	}
}

interface ActiveBtwRun {
	cancel(): Promise<void>;
}

function appendPartialAssistant(
	messages: AgentMessage[],
	partialText: string,
	ctx: ExtensionCommandContext,
): AgentMessage[] {
	const text = partialText.trim();
	if (!text || !ctx.model) return messages;
	return [
		...messages,
		{
			role: "assistant",
			content: [{ type: "text", text }],
			api: ctx.model.api,
			provider: ctx.model.provider,
			model: ctx.model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		},
	];
}

async function showBtw(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	partialMainText: string,
	activeRuns: Set<ActiveBtwRun>,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/btw requires interactive mode", "error");
		return;
	}
	if (!ctx.model) {
		ctx.ui.notify("No model selected", "error");
		return;
	}

	const question = args.trim();
	const originSessionId = ctx.sessionManager.getSessionId();
	const context = appendPartialAssistant(
		trimDanglingToolCalls(ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages)),
		partialMainText,
		ctx,
	);
	const history: DisplayEntry[] = loadHistory(ctx.sessionManager.getBranch()).map((entry) => ({
		...entry,
		state: "complete",
	}));
	if (!question && history.length === 0) {
		ctx.ui.notify("Usage: /btw <question>", "info");
		return;
	}

	const current: DisplayEntry | undefined = question
		? {
				question,
				answer: "",
				createdAt: Date.now(),
				model: `${ctx.model.provider}/${ctx.model.id}`,
				state: "running",
				status: "Thinking...",
			}
		: undefined;
	if (current) history.push(current);

	let nestedSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let run: Promise<void> | undefined;
	let cancelled = false;
	const activeRun: ActiveBtwRun = {
		cancel: async () => {
			cancelled = true;
			if (nestedSession?.isStreaming) await nestedSession.abort();
		},
	};
	if (current) activeRuns.add(activeRun);

	try {
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const overlay = new BtwOverlay(
					tui,
					theme,
					history,
					() => done(undefined),
					() => void activeRun.cancel(),
				);

				if (current) {
					run = (async () => {
						try {
							const created = await createAgentSession({
							cwd: ctx.cwd,
							model: ctx.model!,
							thinkingLevel: ctx.thinkingLevel,
							modelRuntime: modelRuntime(ctx),
							resourceLoader: createResourceLoader(),
							tools: ["read", "grep", "find", "ls"],
							sessionManager: SessionManager.inMemory(ctx.cwd),
							settingsManager: SettingsManager.inMemory({
								compaction: { enabled: false },
								retry: { enabled: true, maxRetries: 2 },
							}),
						});
						nestedSession = created.session;
						if (cancelled) {
							await nestedSession.abort();
							return;
						}
						nestedSession.agent.state.messages = context;
						let streamed = "";
						nestedSession.subscribe((event) => {
							if (event.type === "message_start" && event.message.role === "assistant") {
								streamed = "";
								overlay.setAnswer("");
							} else if (
								event.type === "message_update" &&
								event.assistantMessageEvent.type === "text_delta"
							) {
								streamed += event.assistantMessageEvent.delta;
								overlay.setAnswer(streamed);
							} else if (event.type === "tool_execution_start") {
								const path = "path" in event.args && typeof event.args.path === "string" ? event.args.path : "";
								overlay.setStatus(`${event.toolName}${path ? ` ${path}` : ""}...`);
							} else if (event.type === "turn_start") {
								overlay.setStatus("Thinking...");
							}
						});

						await nestedSession.prompt(question);
						if (cancelled) return;
						const sideMessages = nestedSession.messages.slice(context.length);
						const answer = finalAssistantAnswer(sideMessages);
						if (ctx.sessionManager.getSessionId() !== originSessionId) return;
						overlay.complete(answer);
						const saved: BtwHistoryEntry = {
							question,
							answer,
							createdAt: current.createdAt,
							model: current.model,
							usage: aggregateUsage(sideMessages),
						};
						pi.appendEntry(ENTRY_TYPE, saved);
					} catch (error) {
						if (!cancelled) overlay.fail(error instanceof Error ? error.message : String(error));
					}
					})();
				}

				return overlay;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "75%",
					minWidth: 50,
					maxHeight: 22,
					margin: 1,
				},
			},
		);
	} finally {
		await activeRun.cancel();
		if (run) await run;
		nestedSession?.dispose();
		activeRuns.delete(activeRun);
	}
}

export default function (pi: ExtensionAPI) {
	const activeRuns = new Set<ActiveBtwRun>();
	let mainStreamingText: string | undefined;

	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") mainStreamingText = "";
	});
	pi.on("message_update", (event) => {
		if (event.assistantMessageEvent.type === "text_delta") {
			mainStreamingText = (mainStreamingText ?? "") + event.assistantMessageEvent.delta;
		}
	});
	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") mainStreamingText = undefined;
	});

	const cancelActiveRuns = async () => {
		await Promise.allSettled([...activeRuns].map((run) => run.cancel()));
	};
	pi.on("session_tree", cancelActiveRuns);
	pi.on("session_shutdown", cancelActiveRuns);

	pi.registerCommand("btw", {
		description: "Ask a side question without affecting the main conversation",
		handler: async (args, ctx) => showBtw(args, ctx, pi, mainStreamingText ?? "", activeRuns),
	});
}
