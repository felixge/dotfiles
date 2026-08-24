export const TOKEN_RATE_WINDOW_MS = 15_000;

interface TokenSample {
	timestamp: number;
	tokens: number;
}

export class OutputTokenRateTracker {
	private completedOutput = 0;
	private currentOutput = 0;
	private samples: TokenSample[] = [];
	private readonly now: () => number;

	constructor(now: () => number = () => performance.now()) {
		this.now = now;
	}

	reset(): void {
		this.completedOutput = 0;
		this.currentOutput = 0;
		this.samples = [];
	}

	startMessage(outputTokens = 0): void {
		this.completedOutput += this.currentOutput;
		this.currentOutput = this.normalize(outputTokens);
		this.record(this.completedOutput + this.currentOutput, true);
	}

	observeMessage(outputTokens: number): void {
		this.currentOutput = this.normalize(outputTokens);
		this.record(this.completedOutput + this.currentOutput, false);
	}

	rate(): number {
		const endpoint = this.now();
		this.prune(endpoint);
		if (this.samples.length < 2) return 0;

		const cutoff = endpoint - TOKEN_RATE_WINDOW_MS;
		let baseline = this.samples[0]!;
		for (const sample of this.samples) {
			if (sample.timestamp > cutoff) break;
			baseline = sample;
		}
		const latest = this.samples.at(-1)!;
		const elapsedMs = Math.min(TOKEN_RATE_WINDOW_MS, endpoint - baseline.timestamp);
		if (elapsedMs <= 0) return 0;
		return Math.max(0, latest.tokens - baseline.tokens) / (elapsedMs / 1000);
	}

	private normalize(tokens: number): number {
		return Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
	}

	private record(tokens: number, force: boolean): void {
		const timestamp = this.now();
		const latest = this.samples.at(-1);
		if (!force && latest?.tokens === tokens) return;
		if (latest?.timestamp === timestamp) {
			latest.tokens = tokens;
		} else {
			this.samples.push({ timestamp, tokens });
		}
		this.prune(timestamp);
	}

	private prune(endpoint: number): void {
		const cutoff = endpoint - TOKEN_RATE_WINDOW_MS;
		while (this.samples.length > 2 && this.samples[1]!.timestamp <= cutoff) this.samples.shift();
	}
}
