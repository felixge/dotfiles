export interface SessionUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function number(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeUsage(value: unknown): SessionUsage | undefined {
	const usage = record(value);
	if (!usage) return undefined;
	const cost = record(usage.cost);
	return {
		input: number(usage.input),
		output: number(usage.output),
		cacheRead: number(usage.cacheRead),
		cacheWrite: number(usage.cacheWrite),
		totalTokens: number(usage.totalTokens),
		cost: {
			input: number(cost?.input),
			output: number(cost?.output),
			cacheRead: number(cost?.cacheRead),
			cacheWrite: number(cost?.cacheWrite),
			total: number(cost?.total),
		},
	};
}

/** Return usage Pi includes in session totals, without double-counting metadata. */
export function getSessionEntryUsage(value: unknown): SessionUsage | undefined {
	const entry = record(value);
	if (!entry) return undefined;

	if (entry.type === "message") {
		const message = record(entry.message);
		if (message?.role === "assistant" || message?.role === "toolResult") {
			return normalizeUsage(message.usage);
		}
		return undefined;
	}

	if (entry.type === "compaction" || entry.type === "branch_summary") {
		return normalizeUsage(entry.usage);
	}

	if (entry.type === "custom" && entry.customType === "btw-history") {
		return normalizeUsage(record(entry.data)?.usage);
	}
	return undefined;
}

export function sumSessionUsage(entries: Iterable<unknown>): SessionUsage {
	const total = normalizeUsage({})!;
	for (const entry of entries) {
		const usage = getSessionEntryUsage(entry);
		if (!usage) continue;
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
