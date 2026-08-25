import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, Model, ModelCost, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import gatewayCostFallback, { directModelCandidates, priceGatewayUsage } from "../index.ts";

function model(provider: string, id: string, cost: ModelCost): Model<Api> {
	return {
		provider,
		id,
		name: id,
		api: "openai-responses",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	};
}

function usage(overrides: Partial<Omit<Usage, "cost">> & { cost?: Partial<Usage["cost"]> } = {}): Usage {
	return {
		input: 100_000,
		output: 10_000,
		cacheRead: 50_000,
		cacheWrite: 1_000,
		totalTokens: 161_000,
		...overrides,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
			...overrides.cost,
		},
	};
}

function finder(models: Model<Api>[]) {
	return {
		find(provider: string, modelId: string) {
			return models.find((candidate) => candidate.provider === provider && candidate.id === modelId);
		},
	};
}

function assertClose(actual: number, expected: number): void {
	assert.ok(Math.abs(actual - expected) < 1e-12, `expected ${actual} to be close to ${expected}`);
}

test("maps Gateway providers to equivalent direct models", () => {
	assert.deepEqual(directModelCandidates("ai-gw-openai", "openai/gpt-5.6-sol"), [
		{ provider: "openai", modelId: "gpt-5.6-sol" },
		{ provider: "openai-codex", modelId: "gpt-5.6-sol" },
	]);
	for (const provider of ["ai-gw-anthropic", "ai-gw-anthropic-200k", "ai-gw-anthropic-1m"]) {
		assert.deepEqual(directModelCandidates(provider, "anthropic/claude-opus-5"), [
			{ provider: "anthropic", modelId: "claude-opus-5" },
		]);
	}
	for (const id of ["gemini-3.7-flash", "google/gemini-3.7-flash"]) {
		assert.deepEqual(directModelCandidates("ai-gw-google", id), [
			{ provider: "google", modelId: "gemini-3.7-flash" },
		]);
	}
	assert.deepEqual(directModelCandidates("ai-gw-baseten", "baseten/example"), []);
	assert.deepEqual(directModelCandidates("openai", "gpt-5.6-sol"), []);
});

test("calculates Gateway cost from direct model pricing", () => {
	const direct = model("openai", "gpt-5.6-sol", {
		input: 5,
		output: 30,
		cacheRead: 0.5,
		cacheWrite: 6.25,
	});
	const priced = priceGatewayUsage("ai-gw-openai", "openai/gpt-5.6-sol", usage(), finder([direct]));

	assert.ok(priced);
	assertClose(priced.cost.input, 0.5);
	assertClose(priced.cost.output, 0.3);
	assertClose(priced.cost.cacheRead, 0.025);
	assertClose(priced.cost.cacheWrite, 0.00625);
	assertClose(priced.cost.total, 0.83125);
});

test("uses direct model pricing tiers even when base rates are free", () => {
	const direct = model("openai", "gpt-5.6-sol", {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		tiers: [{ inputTokensAbove: 272_000, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 }],
	});
	const priced = priceGatewayUsage(
		"ai-gw-openai",
		"openai/gpt-5.6-sol",
		usage({ input: 300_000, cacheRead: 0, cacheWrite: 0, totalTokens: 310_000 }),
		finder([direct]),
	);

	assert.ok(priced);
	assertClose(priced.cost.input, 3);
	assertClose(priced.cost.output, 0.45);
	assertClose(priced.cost.total, 3.45);
});

test("falls back when the canonical direct provider lacks pricing", () => {
	const unpriced = model("openai", "gpt-5.6-sol", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	const priced = model("openai-codex", "gpt-5.6-sol", { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 });
	const result = priceGatewayUsage("ai-gw-openai", "openai/gpt-5.6-sol", usage(), finder([unpriced, priced]));

	assert.ok(result);
	assertClose(result.cost.total, 0.83125);
});

test("preserves native Gateway cost when present", () => {
	const direct = model("openai", "gpt-5.6-sol", { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 });
	const priced = priceGatewayUsage(
		"ai-gw-openai",
		"openai/gpt-5.6-sol",
		usage({ cost: { input: 0.1, total: 0.1 } }),
		finder([direct]),
	);

	assert.equal(priced, undefined);
});

test("preserves cacheWrite1h for Pi's long-retention pricing", () => {
	const direct = model("anthropic", "claude-opus-5", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
	const priced = priceGatewayUsage(
		"ai-gw-anthropic-1m",
		"anthropic/claude-opus-5",
		usage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000, cacheWrite1h: 400, totalTokens: 1_000 }),
		finder([direct]),
	);

	assert.ok(priced);
	assert.equal(priced.cacheWrite1h, 400);
	assertClose(priced.cost.cacheWrite, 0.00775);
});

test("registers a message_end replacement that prices assistant messages", () => {
	type Handler = (event: { message: AssistantMessage }, ctx: { modelRegistry: ReturnType<typeof finder> }) =>
		| { message: AssistantMessage }
		| undefined;
	let handler: Handler | undefined;
	const pi = {
		on(event: string, registered: unknown) {
			assert.equal(event, "message_end");
			handler = registered as Handler;
		},
	} as unknown as ExtensionAPI;
	gatewayCostFallback(pi);
	assert.ok(handler);

	const direct = model("openai", "gpt-5.6-sol", { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 });
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai-responses",
		provider: "ai-gw-openai",
		model: "openai/gpt-5.6-sol",
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const result = handler({ message }, { modelRegistry: finder([direct]) });

	assert.ok(result);
	assert.equal(result.message.role, "assistant");
	assertClose(result.message.usage.cost.total, 0.83125);
});

test("does nothing without tokens or a priced direct model", () => {
	const empty = usage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
	const unpriced = model("openai", "gpt-5.6-sol", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	assert.equal(priceGatewayUsage("ai-gw-openai", "openai/gpt-5.6-sol", empty, finder([])), undefined);
	assert.equal(priceGatewayUsage("ai-gw-openai", "openai/gpt-5.6-sol", usage(), finder([unpriced])), undefined);
	assert.equal(priceGatewayUsage("ai-gw-baseten", "baseten/example", usage(), finder([])), undefined);
});
