import { clampThinkingLevel, StringEnum, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { showAgentsDashboard } from "./dashboard.ts";
import { AgentManager, resolveCanonicalCwd } from "./manager.ts";
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
import type { AgentAccess, ThinkingLevel, WaitResult, WaitToolDetails } from "./types.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const ACCESS_LEVELS = ["read", "write"] as const;

const AgentSpawnParams = Type.Object({
	name: Type.Optional(
		Type.String({ description: "Human-readable name for the sub-agent", minLength: 1, maxLength: 80 }),
	),
	prompt: Type.String({ description: "Task to send to the sub-agent", minLength: 1 }),
	model: Type.Optional(
		Type.String({ description: "Exact provider/model identifier. Defaults to the parent model." }),
	),
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

const AgentWaitParams = Type.Object({
	ids: Type.Array(Type.String(), {
		minItems: 1,
		maxItems: 8,
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

function modelVisibleResults(results: WaitResult[]): WaitResult[] {
	return results.map((result) => ({
		...result,
		output: truncateModelVisibleOutput(result.output),
		...(result.error ? { error: truncateModelVisibleDiagnostic(result.error) } : {}),
	}));
}

function footerText(snapshots: ReturnType<AgentManager["getAll"]>): string | undefined {
	const running = snapshots.filter((run) => run.status === "running").length;
	const queued = snapshots.filter((run) => run.status === "queued").length;
	if (running === 0 && queued === 0) return undefined;
	const parts: string[] = [];
	if (running > 0) parts.push(`${running} running`);
	if (queued > 0) parts.push(`${queued} queued`);
	return `Agents: ${parts.join(", ")}`;
}

export default function subAgentExtension(pi: ExtensionAPI): void {
	const manager = new AgentManager(new PiProcessRunner());
	let unsubscribeFooter: (() => void) | undefined;
	let footerTimer: ReturnType<typeof setTimeout> | undefined;
	let lastFooterUpdate = 0;
	let activeContext: ExtensionContext | undefined;

	const updateFooter = () => {
		if (!activeContext) return;
		lastFooterUpdate = Date.now();
		activeContext.ui.setStatus("sub-agents", footerText(manager.getAll()));
	};
	const scheduleFooter = () => {
		if (!activeContext || footerTimer) return;
		const delay = Math.max(0, 100 - (Date.now() - lastFooterUpdate));
		footerTimer = setTimeout(() => {
			footerTimer = undefined;
			updateFooter();
		}, delay);
	};

	pi.registerTool({
		name: "agent_spawn",
		label: "Spawn Agent",
		description:
			"Start one isolated background sub-agent and return immediately. An optional name labels the agent in status and results. Start all independent agents before calling agent_wait. Read access is the default; write access allows file mutation and is serialized with other writers in the same canonical working directory.",
		promptSnippet: "Start an isolated background sub-agent",
		promptGuidelines: [
			"Use agent_spawn for independent delegated tasks, start all independent sub-agents before using agent_wait, and retain every returned ID.",
		],
		parameters: AgentSpawnParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = await resolveSpawnConfig(params, ctx);
			const run = manager.spawn(config);
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

	pi.registerTool({
		name: "agent_wait",
		label: "Wait for Agents",
		description:
			"Wait for one to eight background sub-agents. Escaping this tool stops only the wait; it does not cancel any sub-agent. Outputs are capped at 50 KB per agent in model-visible content.",
		promptSnippet: "Wait for background sub-agents and collect their results",
		parameters: AgentWaitParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			const snapshots = await manager.wait(params.ids, signal, (partial) => {
				onUpdate?.({
					content: [{ type: "text", text: formatWaitProgress(partial) }],
					details: { final: false, snapshots: partial } satisfies WaitToolDetails,
				});
			});
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
			await showAgentsDashboard(ctx, manager);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		activeContext = ctx;
		unsubscribeFooter?.();
		unsubscribeFooter = manager.subscribe(scheduleFooter);
		updateFooter();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		unsubscribeFooter?.();
		unsubscribeFooter = undefined;
		if (footerTimer) clearTimeout(footerTimer);
		footerTimer = undefined;
		ctx.ui.setStatus("sub-agents", undefined);
		activeContext = undefined;
		await manager.shutdown();
	});
}
