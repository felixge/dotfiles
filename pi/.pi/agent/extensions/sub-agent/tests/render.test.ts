import assert from "node:assert/strict";
import test from "node:test";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { modelVisibleResults } from "../index.ts";
import { MODEL_VISIBLE_OUTPUT_BYTES, truncateModelVisibleOutput, waitResultFromSnapshot } from "../render.ts";
import type { AgentSnapshot, WaitResult } from "../types.ts";

test("model-visible output is capped and points to the saved full output", () => {
	const full = "é".repeat(MODEL_VISIBLE_OUTPUT_BYTES);
	const truncation = truncateHead(full);
	const visible = truncateModelVisibleOutput(truncation.content, truncation, "/tmp/full-output.log");
	assert.ok(Buffer.byteLength(visible, "utf8") <= MODEL_VISIBLE_OUTPUT_BYTES);
	assert.match(visible, /Output truncated/u);
	assert.match(visible, /Full output: \/tmp\/full-output\.log/u);
});

test("model-visible results omit duplicate truncation content", () => {
	const full = Array.from({ length: 2_500 }, (_, index) => `line ${index + 1}`).join("\n");
	const truncation = truncateHead(full);
	const result: WaitResult = {
		id: "abc123",
		status: "completed",
		output: truncation.content,
		outputTruncation: truncation,
		fullOutputPath: "/tmp/full-output.log",
		model: "provider/model",
		thinking: "high",
		cwd: "/repo",
		elapsedMs: 100,
		turns: 1,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const [visible] = modelVisibleResults([result]);
	assert.equal("outputTruncation" in visible, false);
	assert.equal(visible.fullOutputPath, "/tmp/full-output.log");
	assert.match(visible.output, /Full output: \/tmp\/full-output\.log/u);
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
		usage: {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0.02, output: 0.08, cacheRead: 0, cacheWrite: 0, total: 0.1 },
		},
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
		usage: {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0.02, output: 0.08, cacheRead: 0, cacheWrite: 0, total: 0.1 },
		},
	});
});
