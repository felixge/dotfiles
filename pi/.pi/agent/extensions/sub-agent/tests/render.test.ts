import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_VISIBLE_OUTPUT_BYTES, truncateModelVisibleOutput, waitResultFromSnapshot } from "../render.ts";
import type { AgentSnapshot } from "../types.ts";

test("model-visible output is capped while wait details can retain the bounded full output", () => {
	const full = "é".repeat(MODEL_VISIBLE_OUTPUT_BYTES);
	const visible = truncateModelVisibleOutput(full);
	assert.ok(Buffer.byteLength(visible, "utf8") <= MODEL_VISIBLE_OUTPUT_BYTES);
	assert.match(visible, /Output truncated/u);
});

test("wait result preserves terminal snapshot metadata", () => {
	const snapshot: AgentSnapshot = {
		id: "abc123",
		name: "reviewer",
		prompt: "task",
		model: "provider/model",
		thinking: "high",
		cwd: "/repo",
		access: "read",
		status: "failed",
		createdAt: 100,
		startedAt: 150,
		endedAt: 250,
		currentActivity: "failed",
		turns: 2,
		usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
		finalOutput: "partial",
		liveOutput: "partial",
		error: "failure",
		stderr: "",
		activity: [],
	};
	assert.deepEqual(waitResultFromSnapshot(snapshot), {
		id: "abc123",
		name: "reviewer",
		status: "failed",
		output: "partial",
		error: "failure",
		model: "provider/model",
		thinking: "high",
		cwd: "/repo",
		elapsedMs: 100,
		turns: 2,
		usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
	});
});
