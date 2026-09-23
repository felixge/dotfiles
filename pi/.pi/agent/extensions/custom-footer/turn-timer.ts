export class TurnTimer {
	private submittedAt: number | undefined;
	private startedAt: number | undefined;
	private lastMs: number | undefined;
	private readonly now: () => number;

	constructor(now: () => number = () => performance.now()) {
		this.now = now;
	}

	reset(lastMs?: number): void {
		this.submittedAt = undefined;
		this.startedAt = undefined;
		this.lastMs = lastMs;
	}

	submitted(): void {
		if (this.startedAt === undefined) this.submittedAt = this.now();
	}

	started(): void {
		if (this.startedAt === undefined) this.startedAt = this.submittedAt ?? this.now();
		this.submittedAt = undefined;
	}

	settled(): void {
		if (this.startedAt === undefined) return;
		this.lastMs = Math.max(0, this.now() - this.startedAt);
		this.startedAt = undefined;
	}

	get durationMs(): number | undefined {
		return this.startedAt === undefined ? this.lastMs : Math.max(0, this.now() - this.startedAt);
	}

	get running(): boolean {
		return this.startedAt !== undefined;
	}

	get lastDurationMs(): number | undefined {
		return this.lastMs;
	}
}
