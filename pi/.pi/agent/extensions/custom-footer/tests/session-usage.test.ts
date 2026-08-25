import assert from "node:assert/strict";
import test from "node:test";
import { getSessionEntryUsage, sumSessionUsage } from "../../lib/session-usage.ts";

function usage(cost: number, input = 1) {
	return {
		input,
		output: 2,
		cacheRead: 3,
		cacheWrite: 4,
		totalTokens: input + 9,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

test("sums all usage-bearing session entry types", () => {
	const total = sumSessionUsage([
		{ type: "message", message: { role: "assistant", usage: usage(1, 10) } },
		{ type: "message", message: { role: "toolResult", usage: usage(2, 20) } },
		{ type: "compaction", usage: usage(3, 30) },
		{ type: "branch_summary", usage: usage(4, 40) },
		{ type: "custom", customType: "btw-history", data: { usage: usage(5, 50) } },
	]);

	assert.equal(total.input, 150);
	assert.equal(total.output, 10);
	assert.equal(total.cacheRead, 15);
	assert.equal(total.cacheWrite, 20);
	assert.equal(total.totalTokens, 195);
	assert.equal(total.cost.total, 15);
});

test("does not count usage metadata or unrelated messages", () => {
	const nested = usage(99);
	const entries = [
		{ type: "message", message: { role: "user", usage: nested } },
		{ type: "message", message: { role: "toolResult", details: { results: [{ usage: nested }] } } },
		{ type: "custom", data: { usage: nested } },
	];

	assert.equal(sumSessionUsage(entries).cost.total, 0);
	assert.equal(getSessionEntryUsage(entries[1]), undefined);
});

test("normalizes malformed numeric fields", () => {
	const result = getSessionEntryUsage({
		type: "message",
		message: { role: "toolResult", usage: { input: Number.NaN, cost: { total: 2 } } },
	});

	assert.equal(result?.input, 0);
	assert.equal(result?.cost.total, 2);
});
