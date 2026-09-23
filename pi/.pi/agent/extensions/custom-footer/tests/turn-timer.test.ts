import assert from "node:assert/strict";
import test from "node:test";
import { TurnTimer } from "../turn-timer.ts";

test("times a prompt from submission through settling, including retries", () => {
	let now = 100;
	const timer = new TurnTimer(() => now);
	assert.equal(timer.durationMs, undefined);

	timer.submitted();
	now = 250;
	timer.started();
	now = 1_100;
	assert.equal(timer.running, true);
	assert.equal(timer.durationMs, 1_000);

	// A retry starts another low-level run, but does not restart the turn timer.
	timer.started();
	now = 2_100;
	timer.settled();
	assert.equal(timer.running, false);
	assert.equal(timer.lastDurationMs, 2_000);
	now = 9_000;
	assert.equal(timer.durationMs, 2_000);
});

test("replaces the last duration on each completed turn", () => {
	let now = 0;
	const timer = new TurnTimer(() => now);
	timer.started(); // Non-interactive prompts have no input event.
	now = 4_000;
	timer.settled();
	assert.equal(timer.lastDurationMs, 4_000);

	now = 5_000;
	timer.submitted();
	now = 6_000;
	timer.started();
	now = 7_000;
	timer.settled();
	assert.equal(timer.lastDurationMs, 2_000);
});

test("ignores submissions while running and resets for a resumed session", () => {
	let now = 0;
	const timer = new TurnTimer(() => now);
	timer.submitted();
	timer.started();
	now = 500;
	timer.submitted();
	now = 1_000;
	timer.settled();
	assert.equal(timer.lastDurationMs, 1_000);

	timer.reset(7_000);
	assert.equal(timer.durationMs, 7_000);
	now = 2_000;
	timer.submitted();
	now = 3_000;
	timer.started();
	now = 4_000;
	timer.settled();
	assert.equal(timer.lastDurationMs, 2_000);

	timer.reset();
	assert.equal(timer.durationMs, undefined);
	timer.settled();
	assert.equal(timer.durationMs, undefined);
});
