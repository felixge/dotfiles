/**
 * Prices finalized AI Gateway assistant messages from equivalent direct models.
 * refresh-models intentionally omits cost metadata, while Pi calculates cost
 * locally from model metadata rather than consuming LLMObs's asynchronous cost.
 *
 * This hook covers normal assistant messages, including child Pi processes. Pi
 * does not expose equivalent replacement hooks for compaction or branch-summary
 * usage, so those entries remain unpriced when generated with Gateway models.
 */
import { calculateCost, type Api, type Model, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface ModelFinder {
	find(provider: string, modelId: string): Model<Api> | undefined;
}

interface DirectModelCandidate {
	provider: string;
	modelId: string;
}

function stripPrefix(modelId: string, prefix: string): string {
	return modelId.startsWith(`${prefix}/`) ? modelId.slice(prefix.length + 1) : modelId;
}

export function directModelCandidates(provider: string, modelId: string): DirectModelCandidate[] {
	if (provider === "ai-gw-openai") {
		const directId = stripPrefix(modelId, "openai");
		return [
			{ provider: "openai", modelId: directId },
			{ provider: "openai-codex", modelId: directId },
		];
	}
	if (provider === "ai-gw-anthropic" || provider.startsWith("ai-gw-anthropic-")) {
		return [{ provider: "anthropic", modelId: stripPrefix(modelId, "anthropic") }];
	}
	if (provider === "ai-gw-google") {
		return [{ provider: "google", modelId: stripPrefix(modelId, "google") }];
	}
	return [];
}

function hasPricing(model: Model<Api>): boolean {
	const rates = [model.cost, ...(model.cost.tiers ?? [])];
	return rates.some((rate) => rate.input > 0 || rate.output > 0 || rate.cacheRead > 0 || rate.cacheWrite > 0);
}

function hasRecordedCost(usage: Usage): boolean {
	return usage.cost.input !== 0 || usage.cost.output !== 0 || usage.cost.cacheRead !== 0 || usage.cost.cacheWrite !== 0 || usage.cost.total !== 0;
}

function hasTokens(usage: Usage): boolean {
	return usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0;
}

export function priceGatewayUsage(provider: string, modelId: string, usage: Usage, models: ModelFinder): Usage | undefined {
	if (hasRecordedCost(usage) || !hasTokens(usage)) return undefined;

	const pricingModel = directModelCandidates(provider, modelId)
		.map((candidate) => models.find(candidate.provider, candidate.modelId))
		.find((model): model is Model<Api> => model !== undefined && hasPricing(model));
	if (!pricingModel) return undefined;

	const pricedUsage: Usage = {
		...usage,
		cost: { ...usage.cost },
	};
	calculateCost(pricingModel, pricedUsage);
	return pricedUsage.cost.total > 0 ? pricedUsage : undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;

		const usage = priceGatewayUsage(event.message.provider, event.message.model, event.message.usage, ctx.modelRegistry);
		if (!usage) return;

		return {
			message: {
				...event.message,
				usage,
			},
		};
	});
}
