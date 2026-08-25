import { clampThinkingLevel, StringEnum, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { showAgentsDashboard } from "./dashboard.ts";
import {
	mergeAgentRuns,
	persistedTerminalRun,
	readAgentHistory,
	TERMINAL_RUN_ENTRY_TYPE,
} from "./history.ts";
import { AgentManager, resolveCanonicalCwd } from "./manager.ts";
import { branchEntryIds, runsOnBranch } from "./scope.ts";
import {
	formatWaitProgress,
	renderSpawnCall,
	renderSpawnResult,
	renderWaitCall,
	renderWaitResult,
	truncateModelVisibleDiagnostic,
	truncateModelVisibleOutput,
	waitResultFromSnapshot,
} from "./render.ts";
import { PiProcessRunner } from "./runner.ts";
import {
	isTerminalStatus,
	type AgentAccess,
	type AgentSnapshot,
	type SpawnToolDetails,
	type ThinkingLevel,
	type WaitResult,
	type WaitToolDetails,
} from "./types.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const ACCESS_LEVELS = ["read", "write"] as const;
const DEFAULT_MODEL_DESCRIPTION = "Exact provider/model identifier. Defaults to the parent model.";

export function modelParameterDescription(scopedModels: ExtensionContext["scopedModels"]): string {
	if (scopedModels.length === 0) return DEFAULT_MODEL_DESCRIPTION;
	const identifiers = scopedModels.map(({ model }) => `- ${model.provider}/${model.id}`);
	return `${DEFAULT_MODEL_DESCRIPTION}\nScoped models:\n${identifiers.join("\n")}`;
}

function agentSpawnParams(modelDescription = DEFAULT_MODEL_DESCRIPTION) {
	return Type.Object({
		name: Type.Optional(
			Type.String({ description: "Human-readable name for the sub-agent", minLength: 1, maxLength: 80 }),
		),
		prompt: Type.String({ description: "Task to send to the sub-agent", minLength: 1 }),
		model: Type.Optional(Type.String({ description: modelDescription })),
		thinking: Type.Optional(
			StringEnum(THINKING_LEVELS, { description: "Thinking level. Defaults to the parent thinking level." }),
		),
		cwd: Type.Optional(
			Type.String({ description: "Working directory. Relative paths resolve from the parent cwd." }),
		),
		access: Type.Optional(
			StringEnum(ACCESS_LEVELS, { description: "Tool access. Defaults to read.", default: "read" }),
		),
	});
}

const AgentWaitParams = Type.Object({
	ids: Type.Array(Type.String(), {
		minItems: 1,
		description: "Sub-agent IDs to wait for",
	}),
});

export function parseExactModel(value: string): { provider: string; modelId: string } {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) {
		throw new Error(`Model must be an exact provider/model identifier: ${value}`);
	}
	return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

async function resolveSpawnConfig(
	params: {
		name?: string;
		prompt: string;
		model?: string;
		thinking?: ThinkingLevel;
		cwd?: string;
		access?: AgentAccess;
	},
	ctx: ExtensionContext,
): Promise<{ name?: string; prompt: string; model: string; thinking: ThinkingLevel; cwd: string; access: AgentAccess }> {
	if (!params.prompt.trim()) throw new Error("Sub-agent prompt must not be empty");
	const name = params.name?.replace(/\s+/gu, " ").trim();
	if (params.name !== undefined && !name) throw new Error("Sub-agent name must not be empty");
	const modelName = params.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
	if (!modelName) throw new Error("No parent model is selected; provide model as provider/model");
	const { provider, modelId } = parseExactModel(modelName);
	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) throw new Error(`Unknown model: ${modelName}`);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(`Model ${modelName} is not authenticated: ${auth.error}`);

	const requestedThinking = (params.thinking ?? ctx.thinkingLevel) as ModelThinkingLevel;
	const thinking = clampThinkingLevel(model, requestedThinking) as ThinkingLevel;
	const cwd = await resolveCanonicalCwd(ctx.cwd, params.cwd);
	return {
		...(name ? { name } : {}),
		prompt: params.prompt,
		model: modelName,
		thinking,
		cwd,
		access: params.access ?? "read",
	};
}

export function modelVisibleResults(results: WaitResult[]): WaitResult[] {
	return results.map((result) => {
		const { outputTruncation, ...visible } = result;
		return {
			...visible,
			output: truncateModelVisibleOutput(result.output, outputTruncation, result.fullOutputPath),
			...(result.error ? { error: truncateModelVisibleDiagnostic(result.error) } : {}),
		};
	});
}

export function footerText(snapshots: ReturnType<AgentManager["getAll"]>): string | undefined {
	const running = snapshots.filter((run) => run.status === "running").length;
	const queued = snapshots.filter((run) => run.status === "queued").length;
	if (running === 0 && queued === 0) return undefined;
	const parts: string[] = [];
	if (running > 0) parts.push(`${running} running`);
	if (queued > 0) parts.push(`${queued} queued`);
	return `Agents: ${parts.join(", ")}`;
}

export function agentRunWasAborted(messages: readonly unknown[]): boolean {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (typeof message !== "object" || message === null || !("role" in message)) continue;
		if (message.role === "assistant") return "stopReason" in message && message.stopReason === "aborted";
	}
	return false;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

export interface SubAgentExtensionOptions {
	manager?: AgentManager;
	parentRunIdFactory?: () => string;
}

export function registerSubAgentExtension(pi: ExtensionAPI, options: SubAgentExtensionOptions = {}): AgentManager {
	const manager = options.manager ?? new AgentManager(new PiProcessRunner());
	let parentRunSequence = 0;
	const parentRunIdFactory = options.parentRunIdFactory ?? (() => `parent-${++parentRunSequence}`);
	let activeParentRunId: string | undefined;
	let unsubscribeFooter: (() => void) | undefined;
	let unsubscribePersistence: (() => void) | undefined;
	let footerTimer: ReturnType<typeof setTimeout> | undefined;
	let lastFooterUpdate = 0;
	let activeContext: ExtensionContext | undefined;
	let archivedRuns: AgentSnapshot[] = [];
	let persistedTerminalIds = new Set<string>();

	const branchIds = (ctx: ExtensionContext) => branchEntryIds(ctx.sessionManager.getBranch());
	const visibleRuns = (ctx: ExtensionContext) =>
		runsOnBranch(mergeAgentRuns(archivedRuns, manager.getAll()), branchIds(ctx));
	const persistTerminalRuns = (snapshots: readonly AgentSnapshot[]) => {
		if (!activeContext) return;
		for (const run of snapshots) {
			if (!isTerminalStatus(run.status) || persistedTerminalIds.has(run.id)) continue;
			const data = persistedTerminalRun(run);
			pi.appendEntry(TERMINAL_RUN_ENTRY_TYPE, data);
			persistedTerminalIds.add(run.id);
			archivedRuns = mergeAgentRuns(archivedRuns, [data.run]);
		}
	};
	const updateFooter = () => {
		if (!activeContext) return;
		lastFooterUpdate = Date.now();
		activeContext.ui.setStatus("sub-agents", footerText(visibleRuns(activeContext)));
	};
	const scheduleFooter = () => {
		if (!activeContext || footerTimer) return;
		const delay = Math.max(0, 100 - (Date.now() - lastFooterUpdate));
		footerTimer = setTimeout(() => {
			footerTimer = undefined;
			updateFooter();
		}, delay);
	};

	const createAgentSpawnTool = (
		modelDescription = DEFAULT_MODEL_DESCRIPTION,
	): ToolDefinition<ReturnType<typeof agentSpawnParams>, SpawnToolDetails> => ({
		name: "agent_spawn",
		label: "Spawn Agent",
		description:
			"Start one isolated background sub-agent and return immediately. An optional name labels the agent in status and results. Start all independent agents before calling agent_wait. Read access is the default; write access allows file mutation and is serialized with other writers in the same canonical working directory.",
		promptSnippet: "Start an isolated background sub-agent",
		promptGuidelines: [
			"Before using agent_spawn, ask the user for permission and wait for explicit approval, unless the current user prompt already explicitly requests sub-agent use. Do not treat task complexity or parallelization opportunities as permission. Once authorized, start all independent sub-agents before using agent_wait and retain every returned ID.",
		],
		parameters: agentSpawnParams(modelDescription),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const originEntryId = ctx.sessionManager.getLeafId();
			if (!originEntryId) throw new Error("Cannot spawn a sub-agent without a persisted session origin entry");
			const parentRunId = activeParentRunId;
			if (!parentRunId) throw new Error("Cannot spawn a sub-agent outside an active parent agent run");
			signal?.throwIfAborted();
			const config = await resolveSpawnConfig(params, ctx);
			signal?.throwIfAborted();
			if (activeParentRunId !== parentRunId) {
				throw new Error("Cannot spawn a sub-agent after its parent agent run has ended");
			}
			const run = manager.spawn({ ...config, originEntryId, parentRunId });
			const response = {
				id: run.id,
				...(run.name ? { name: run.name } : {}),
				status: run.status,
				model: run.model,
				thinking: run.thinking,
				cwd: run.cwd,
				access: run.access,
			};
			return {
				content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
				details: { run },
			};
		},
		renderCall: renderSpawnCall,
		renderResult: renderSpawnResult,
	});

	pi.registerTool(createAgentSpawnTool());

	pi.registerTool({
		name: "agent_wait",
		label: "Wait for Agents",
		description:
			"Wait for one or more background sub-agents. Escaping this tool cancels the selected queued or running sub-agents. Outputs are capped at 50 KB or 2,000 lines per agent; full truncated output is saved to a temp file.",
		promptSnippet: "Wait for background sub-agents and collect their results",
		parameters: AgentWaitParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			let snapshots: AgentSnapshot[];
			try {
				snapshots = await manager.wait(params.ids, signal, (partial) => {
					onUpdate?.({
						content: [{ type: "text", text: formatWaitProgress(partial) }],
						details: { final: false, snapshots: partial } satisfies WaitToolDetails,
					});
				});
			} catch (error) {
				if (isAbortError(error)) manager.cancelMany(params.ids);
				throw error;
			}
			const attribution = manager.claimUsage(snapshots);
			const results = snapshots.map(waitResultFromSnapshot);
			const visible = modelVisibleResults(results);
			return {
				content: [{ type: "text", text: JSON.stringify(visible, null, 2) }],
				details: {
					final: true,
					results,
					attributedIds: attribution.attributedIds,
				} satisfies WaitToolDetails,
				...(attribution.usage ? { usage: attribution.usage } : {}),
			};
		},
		renderCall: renderWaitCall,
		renderResult: renderWaitResult,
	});

	pi.registerCommand("agents", {
		description: "Inspect and cancel background sub-agents",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("The sub-agent dashboard is available in TUI mode.", "info");
				return;
			}
			await showAgentsDashboard(ctx, manager, () => visibleRuns(ctx));
		},
	});

	pi.on("session_start", (_event, ctx) => {
		pi.registerTool(createAgentSpawnTool(modelParameterDescription(ctx.scopedModels)));
		activeContext = ctx;
		const history = readAgentHistory(ctx.sessionManager.getEntries());
		archivedRuns = history.runs;
		persistedTerminalIds = history.persistedTerminalIds;
		unsubscribeFooter?.();
		unsubscribePersistence?.();
		unsubscribeFooter = manager.subscribe(scheduleFooter);
		unsubscribePersistence = manager.subscribe(persistTerminalRuns);
		persistTerminalRuns(manager.getAll());
		updateFooter();
	});

	pi.on("agent_start", () => {
		activeParentRunId = parentRunIdFactory();
	});

	pi.on("agent_end", (event) => {
		const parentRunId = activeParentRunId;
		activeParentRunId = undefined;
		if (parentRunId && agentRunWasAborted(event.messages)) {
			manager.cancelWhere((run) => run.parentRunId === parentRunId);
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		const activeBranchIds = branchIds(ctx);
		manager.cancelWhere((run) => !activeBranchIds.has(run.originEntryId));
		updateFooter();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		unsubscribeFooter?.();
		unsubscribeFooter = undefined;
		if (footerTimer) clearTimeout(footerTimer);
		footerTimer = undefined;
		ctx.ui.setStatus("sub-agents", undefined);
		activeParentRunId = undefined;
		await manager.shutdown();
		unsubscribePersistence?.();
		unsubscribePersistence = undefined;
		activeContext = undefined;
	});

	return manager;
}

export default function subAgentExtension(pi: ExtensionAPI): void {
	registerSubAgentExtension(pi);
}
