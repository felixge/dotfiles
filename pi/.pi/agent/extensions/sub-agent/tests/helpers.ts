import assert from "node:assert/strict";
import type { WaitTimer } from "../manager.ts";

export class ManualClock {
	constructor(
		public wallMs = 0,
		public monotonicMs = 0,
	) {}

	readonly wallNow = (): number => this.wallMs;
	readonly monotonicNow = (): number => this.monotonicMs;
}

export class ManualWaitTimer implements WaitTimer {
	private scheduled: { handle: symbol; callback: () => void; delayMs: number } | undefined;
	private readonly firedHandles = new Set<unknown>();
	clearCalls = 0;
	setCalls = 0;
	failure: Error | undefined;

	get callback(): (() => void) | undefined {
		return this.scheduled?.callback;
	}

	get delayMs(): number | undefined {
		return this.scheduled?.delayMs;
	}

	set(callback: () => void, delayMs: number): unknown {
		assert.equal(this.scheduled, undefined, "only one wait timer may be scheduled");
		if (this.failure) {
			const failure = this.failure;
			this.failure = undefined;
			throw failure;
		}
		this.setCalls++;
		const handle = Symbol("wait timer");
		this.scheduled = { handle, callback, delayMs };
		return handle;
	}

	clear(handle: unknown): void {
		this.clearCalls++;
		if (this.scheduled) {
			assert.equal(handle, this.scheduled.handle, "wrong live wait timer handle");
			this.scheduled = undefined;
			return;
		}
		assert.equal(this.firedHandles.delete(handle), true, "unknown wait timer handle");
	}

	fire(): void {
		const callback = this.takeCallback();
		callback();
	}

	takeCallback(): () => void {
		const scheduled = this.scheduled;
		assert.ok(scheduled, "missing wait timer");
		this.scheduled = undefined;
		this.firedHandles.add(scheduled.handle);
		return () => {
			try {
				scheduled.callback();
			} finally {
				this.firedHandles.delete(scheduled.handle);
			}
		};
	}
}
