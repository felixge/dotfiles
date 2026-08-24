import assert from "node:assert/strict";
import test from "node:test";
import { OutputTokenRateTracker } from "../token-rate.ts";

test("calculates a rolling 15-second output token rate", () => {
	let now = 0;
	const tracker = new OutputTokenRateTracker(() => now);
	tracker.startMessage();

	now = 5_000;
	tracker.observeMessage(50);
	assert.equal(tracker.rate(), 10);

	now = 10_000;
	tracker.observeMessage(100);
	assert.equal(tracker.rate(), 10);

	now = 20_000;
	assert.equal(tracker.rate(), 50 / 15);

	now = 26_000;
	assert.equal(tracker.rate(), 0);
});

test("keeps a monotonic total across assistant messages", () => {
	let now = 0;
	const tracker = new OutputTokenRateTracker(() => now);
	tracker.startMessage();

	now = 5_000;
	tracker.observeMessage(50);
	now = 7_000;
	tracker.startMessage();
	now = 10_000;
	tracker.observeMessage(30);

	assert.equal(tracker.rate(), 8);
});

test("reconciles corrected cumulative usage", () => {
	let now = 0;
	const tracker = new OutputTokenRateTracker(() => now);
	tracker.startMessage();

	now = 5_000;
	tracker.observeMessage(50);
	now = 6_000;
	tracker.observeMessage(40);

	assert.equal(tracker.rate(), 40 / 6);
});
