import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { AgentManager, resolveCanonicalCwd } from "../manager.ts";
import { createInitialProgress } from "../runner.ts";
import type {
	AgentAccess,
	AgentRunConfig,
	AgentRunner,
	RunnerProgress,
	RunnerResult,
	RunningAgentProcess,
} from "../types.ts";
import { ManualClock, ManualWaitTimer } from "./helpers.ts";

interface DeferredRun {
	config: AgentRunConfig;
	onProgress: (progress: RunnerProgress) => void;
	resolve: (result: RunnerResult) => void;
	cancelled: boolean;
}

class FakeRunner implements AgentRunner {
	readonly runs = new Map<string, DeferredRun>();
	active = 0;
	maxActive = 0;

	start(config: AgentRunConfig, onProgress: (progress: RunnerProgress) => void): RunningAgentProcess {
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		let resolve!: (result: RunnerResult) => void;
		const result = new Promise<RunnerResult>((done) => {
			resolve = (value) => {
				this.active--;
				done(value);
			};
		});
		const deferred: DeferredRun = { config, onProgress, resolve, cancelled: false };
		this.runs.set(config.id, deferred);
		return {
			result,
			cancel: () => {
				if (deferred.cancelled) return;
				deferred.cancelled = true;
				deferred.resolve(this.result({ finalAssistantSeen: false }));
			},
		};
	}

	complete(id: string, overrides: Partial<RunnerProgress> = {}): void {
		const run = this.runs.get(id);
		assert.ok(run, `missing fake run ${id}`);
		const progress = { ...createInitialProgress(), finalAssistantSeen: true, finalOutput: `output ${id}`, ...overrides };
		run.onProgress(progress);
		run.resolve(this.result(progress));
	}

	private result(progressOverrides: Partial<RunnerProgress>): RunnerResult {
		return {
			exitCode: 0,
			signal: null,
			stderr: "",
			progress: { ...createInitialProgress(), ...progressOverrides },
			timedOut: false,
		};
	}
}

function ids(): () => string {
	const values = ["aaaaaa", "bbbbbb", "cccccc", "dddddd", "eeeeee", "ffffff"];
	return () => values.shift()!;
}

function request(
	cwd: string,
	access: AgentAccess = "read",
	originEntryId = "origin-1",
	parentRunId = "parent-1",
) {
	return { originEntryId, parentRunId, prompt: "task", model: "provider/model", thinking: "low" as const, cwd, access };
}

async function tick(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function settleResult(result: RunnerResult, prompt = "task") {
	const runner: AgentRunner = {
		start: () => ({ result: Promise.resolve(result), cancel() {} }),
	};
	const manager = new AgentManager(runner, { idFactory: ids() });
	const run = manager.spawn({ ...request("/repo"), prompt });
	await tick();
	return manager.get(run.id)!;
}

test("manager applies only global concurrency, including writers sharing a cwd", async () => {
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, { maxConcurrency: 2, idFactory: ids() });
	const firstWriter = manager.spawn(request("/repo", "write"));
	const secondWriter = manager.spawn(request("/repo", "write"));
	const reader = manager.spawn(request("/repo", "read"));

	assert.equal(manager.get(firstWriter.id)?.status, "running");
	assert.equal(manager.get(secondWriter.id)?.status, "running");
	assert.equal(manager.get(reader.id)?.status, "queued");
	assert.equal(manager.get(reader.id)?.currentActivity, "capacity");
	assert.equal(runner.maxActive, 2);

	runner.complete(firstWriter.id);
	await tick();
	assert.equal(manager.get(reader.id)?.status, "running");
	runner.complete(secondWriter.id);
	runner.complete(reader.id);
	await tick();
	assert.equal(manager.get(secondWriter.id)?.status, "completed");
	assert.equal(manager.get(reader.id)?.status, "completed");
	assert.equal(runner.maxActive, 2);
});

test("manager preserves provenance and optional names in snapshots and runner config", async () => {
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, { idFactory: ids() });
	const named = manager.spawn({ ...request("/repo", "read", "assistant-1", "parent-7"), name: "reviewer" });

	assert.equal(named.name, "reviewer");
	assert.equal(named.originEntryId, "assistant-1");
	assert.equal(named.parentRunId, "parent-7");
	assert.equal(manager.get(named.id)?.name, "reviewer");
	assert.equal(runner.runs.get(named.id)?.config.name, "reviewer");
	assert.equal(runner.runs.get(named.id)?.config.originEntryId, "assistant-1");
	assert.equal(runner.runs.get(named.id)?.config.parentRunId, "parent-7");

	runner.complete(named.id);
	await tick();
});

test("manager preserves structured progress and returns immutable snapshots", async () => {
	let now = 100;
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, { idFactory: ids(), now: () => now });
	const run = manager.spawn(request("/repo"));
	const deferred = runner.runs.get(run.id);
	assert.ok(deferred);
	const progress = createInitialProgress(100);
	progress.revision = 7;
	progress.lastProgressAt = 180;
	progress.phase = { kind: "using_tools", startedAt: 150 };
	progress.currentActivity = "bash: npm test";
	progress.activeOperations = [{
		toolCallId: "tool-1",
		tool: "bash",
		summary: "bash: npm test",
		startedAt: 150,
		lastUpdatedAt: 170,
	}];
	progress.recentOperations = [{
		kind: "retry",
		summary: "retry 1/3",
		startedAt: 120,
		endedAt: 140,
		outcome: "completed",
	}];
	now = 200;
	deferred.onProgress(progress);
	const snapshot = manager.get(run.id)!;
	assert.equal(snapshot.revision, 8);
	assert.equal(snapshot.lastProgressAt, 180);
	assert.equal(snapshot.phase.kind, "using_tools");
	assert.equal(snapshot.activeOperations[0]?.lastUpdatedAt, 170);
	assert.equal(snapshot.recentOperations[0]?.endedAt, 140);
	assert.ok(Object.isFrozen(snapshot));
	assert.ok(Object.isFrozen(snapshot.phase));
	assert.ok(Object.isFrozen(snapshot.activeOperations));
	assert.ok(Object.isFrozen(snapshot.activeOperations[0]));
	assert.ok(Object.isFrozen(snapshot.recentOperations[0]));
	assert.throws(() => {
		(snapshot.activeOperations as any[]).push({});
	}, TypeError);
	progress.activeOperations[0]!.summary = "mutated";
	assert.equal(snapshot.activeOperations[0]?.summary, "bash: npm test");

	runner.complete(run.id);
	await tick();
});

test("manager snapshots preserve truncated output metadata", async () => {
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, { idFactory: ids() });
	const run = manager.spawn(request("/repo"));
	const fullOutput = Array.from({ length: 2_500 }, (_, index) => `line ${index + 1}`).join("\n");
	const truncation = truncateHead(fullOutput);
	runner.complete(run.id, {
		finalOutput: truncation.content,
		finalOutputTruncation: truncation,
		fullOutputPath: "/tmp/full-output.log",
	});
	await tick();

	const { snapshots: [snapshot] } = await manager.wait([run.id]);
	assert.equal(snapshot.fullOutputPath, "/tmp/full-output.log");
	assert.deepEqual(snapshot.finalOutputTruncation, truncation);
	assert.ok(Object.isFrozen(snapshot.finalOutputTruncation));
	const originalTotalBytes = truncation.totalBytes;
	truncation.totalBytes = 1;
	assert.equal(manager.get(run.id)?.finalOutputTruncation?.totalBytes, originalTotalBytes);
	assert.throws(() => {
		(snapshot.finalOutputTruncation as any).totalBytes = 2;
	}, TypeError);
	assert.equal(manager.get(run.id)?.finalOutputTruncation?.totalBytes, originalTotalBytes);
});

test("cancelling a queued run never starts it and cancelling a running run stops it", async () => {
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, { maxConcurrency: 1, idFactory: ids() });
	const running = manager.spawn(request("/one"));
	const queued = manager.spawn(request("/two"));
	assert.equal(manager.cancel(queued.id), true);
	assert.equal(manager.get(queued.id)?.status, "cancelled");
	assert.equal(runner.runs.has(queued.id), false);
	assert.equal(manager.cancel(running.id), true);
	await tick();
	assert.equal(runner.runs.get(running.id)?.cancelled, true);
	assert.equal(manager.get(running.id)?.status, "cancelled");
});

test("bulk cancellation is selective, idempotent, and releases capacity", async () => {
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, { maxConcurrency: 1, idFactory: ids() });
	const abandoned = manager.spawn(request("/repo", "write", "branch-a", "parent-a"));
	const retained = manager.spawn(request("/repo", "write", "branch-b", "parent-b"));

	assert.deepEqual(manager.cancelWhere((run) => run.parentRunId === "parent-a"), [abandoned.id]);
	assert.deepEqual(manager.cancelMany([abandoned.id, abandoned.id]), []);
	await tick();
	assert.equal(manager.get(abandoned.id)?.status, "cancelled");
	assert.equal(manager.get(retained.id)?.status, "running");

	runner.complete(retained.id);
	await tick();
});

test("manager wait preserves input order and does not own abort cancellation", async () => {
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, { maxConcurrency: 2, idFactory: ids() });
	const first = manager.spawn(request("/one"));
	const second = manager.spawn(request("/two"));
	const controller = new AbortController();
	const abortedWait = manager.wait([first.id], controller.signal);
	const abortedWaitRejected = assert.rejects(abortedWait, { name: "AbortError" });
	controller.abort();
	await abortedWaitRejected;
	assert.equal(manager.get(first.id)?.status, "running");

	const orderedWait = manager.wait([second.id, first.id]);
	runner.complete(first.id);
	runner.complete(second.id);
	const outcome = await orderedWait;
	assert.deepEqual(outcome.snapshots.map((run) => run.id), [second.id, first.id]);
	assert.ok(outcome.snapshots.every((run) => run.status === "completed"));
	assert.equal(outcome.timedOut, false);
});

test("bounded wait coalesces progress bursts and eventually publishes the latest revision", async () => {
	const clock = new ManualClock(10_000, 0);
	const timer = new ManualWaitTimer();
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, {
		idFactory: ids(),
		now: clock.wallNow,
		monotonicNow: clock.monotonicNow,
		waitTimer: timer,
	});
	const run = manager.spawn(request("/one"));
	const controller = new AbortController();
	const updates: Array<{ revision: number; output: string; elapsedMs: number }> = [];
	const waiting = manager.wait([run.id], controller.signal, (snapshots, timing) => {
		updates.push({
			revision: snapshots[0]!.revision,
			output: snapshots[0]!.liveOutput,
			elapsedMs: timing.elapsedMs,
		});
	}, 60_000);
	assert.equal(updates.length, 1);

	for (let revision = 1; revision <= 20; revision++) {
		runner.runs.get(run.id)!.onProgress({
			...createInitialProgress(),
			revision,
			liveOutput: `revision ${revision}`,
		});
	}
	assert.equal(updates.length, 1);
	assert.equal(timer.delayMs, 100);

	clock.monotonicMs = 100;
	timer.fire();
	assert.equal(updates.length, 2);
	assert.equal(updates[1]?.output, "revision 20");
	assert.ok((updates[1]?.revision ?? 0) > updates[0]!.revision);
	assert.equal(updates[1]?.elapsedMs, 100);

	const burstWaitRejected = assert.rejects(waiting, { name: "AbortError" });
	controller.abort();
	await burstWaitRejected;
	assert.equal(timer.callback, undefined);
	await manager.shutdown();
});

test("bounded wait without a snapshot consumer schedules only its deadline and completes immediately", async () => {
	const clock = new ManualClock(5_000, 0);
	const timer = new ManualWaitTimer();
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, {
		idFactory: ids(),
		now: clock.wallNow,
		monotonicNow: clock.monotonicNow,
		waitTimer: timer,
	});
	const run = manager.spawn(request("/one"));
	const waiting = manager.wait([run.id], undefined, undefined, 60_000);

	assert.equal(timer.delayMs, 60_000);
	clock.monotonicMs = 10;
	runner.runs.get(run.id)!.onProgress({ ...createInitialProgress(), revision: 1 });
	assert.equal(timer.delayMs, 60_000);
	assert.equal(timer.setCalls, 1);

	clock.monotonicMs = 25;
	runner.complete(run.id);
	const outcome = await waiting;
	assert.equal(outcome.timedOut, false);
	assert.equal(outcome.waitedMs, 25);
	assert.equal(outcome.snapshots[0]?.status, "completed");
	assert.equal(timer.callback, undefined);
});

test("wait caps long timer arms and reschedules against the absolute deadline", async () => {
	const maxDelayMs = 2_147_483_647;
	const clock = new ManualClock(0, 0);
	const timer = new ManualWaitTimer();
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, {
		idFactory: ids(),
		monotonicNow: clock.monotonicNow,
		waitTimer: timer,
	});
	const run = manager.spawn(request("/one"));
	const timeoutMs = maxDelayMs + 12_345;
	const waiting = manager.wait([run.id], undefined, undefined, timeoutMs);

	assert.equal(timer.delayMs, maxDelayMs);
	clock.monotonicMs = maxDelayMs;
	timer.fire();
	assert.equal(timer.delayMs, 12_345);
	assert.equal(timer.setCalls, 2);

	clock.monotonicMs = timeoutMs;
	timer.fire();
	const outcome = await waiting;
	assert.equal(outcome.timedOut, true);
	assert.equal(outcome.waitedMs, timeoutMs);
	assert.equal(timer.callback, undefined);
	await manager.shutdown();
});

test("bounded wait emits a countdown heartbeat without child events", async () => {
	const clock = new ManualClock(10_000, 0);
	const timer = new ManualWaitTimer();
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, {
		idFactory: ids(),
		now: clock.wallNow,
		monotonicNow: clock.monotonicNow,
		waitTimer: timer,
	});
	const run = manager.spawn(request("/one"));
	const controller = new AbortController();
	const timings: Array<{ elapsedMs: number; remainingMs?: number }> = [];
	const waiting = manager.wait([run.id], controller.signal, (_snapshots, timing) => timings.push(timing), 60_000);

	assert.deepEqual(timings, [{ elapsedMs: 0, remainingMs: 60_000 }]);
	for (const second of [1, 2]) {
		clock.monotonicMs = second * 1_000;
		timer.fire();
		assert.deepEqual(timings.at(-1), {
			elapsedMs: second * 1_000,
			remainingMs: 60_000 - second * 1_000,
		});
		assert.equal(timer.delayMs, 1_000);
	}

	const heartbeatWaitRejected = assert.rejects(waiting, { name: "AbortError" });
	controller.abort();
	await heartbeatWaitRejected;
	assert.equal(timer.callback, undefined);
	await manager.shutdown();
});

test("bounded wait uses monotonic time and returns an explicit timeout outcome", async () => {
	const clock = new ManualClock(1_000_000, 10);
	const timer = new ManualWaitTimer();
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, {
		idFactory: ids(),
		now: clock.wallNow,
		monotonicNow: clock.monotonicNow,
		waitTimer: timer,
	});
	const run = manager.spawn(request("/one"));
	const waiting = manager.wait([run.id], undefined, undefined, 500);

	clock.wallMs = -50_000;
	clock.monotonicMs = 510;
	timer.fire();
	const outcome = await waiting;
	assert.equal(outcome.timedOut, true);
	assert.equal(outcome.waitedMs, 500);
	assert.equal(outcome.snapshots[0]?.status, "running");
	assert.equal(outcome.snapshots[0]?.createdAt, 1_000_000);
	assert.equal(timer.callback, undefined);
	await manager.shutdown();
});

test("indefinite wait schedules no heartbeat or deadline timer", async () => {
	const timer = new ManualWaitTimer();
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, { idFactory: ids(), waitTimer: timer });
	const run = manager.spawn(request("/one"));
	const controller = new AbortController();
	const waiting = manager.wait([run.id], controller.signal, () => {});

	assert.equal(timer.setCalls, 0);
	assert.equal(timer.callback, undefined);
	const indefiniteWaitRejected = assert.rejects(waiting, { name: "AbortError" });
	controller.abort();
	await indefiniteWaitRejected;
	assert.equal(timer.clearCalls, 0);
	await manager.shutdown();
});

test("an immediate indefinite publication clears a stale coalescing timer", async () => {
	const clock = new ManualClock();
	const timer = new ManualWaitTimer();
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, {
		idFactory: ids(),
		monotonicNow: clock.monotonicNow,
		waitTimer: timer,
	});
	const run = manager.spawn(request("/one"));
	const controller = new AbortController();
	const revisions: number[] = [];
	const waiting = manager.wait(
		[run.id],
		controller.signal,
		(snapshots) => revisions.push(snapshots[0]!.revision),
	);

	runner.runs.get(run.id)!.onProgress({ ...createInitialProgress(), revision: 1 });
	assert.equal(timer.delayMs, 100);
	clock.monotonicMs = 100;
	runner.runs.get(run.id)!.onProgress({ ...createInitialProgress(), revision: 2 });
	assert.equal(revisions.length, 2);
	assert.equal(revisions.at(-1), 3);
	assert.equal(timer.callback, undefined);
	assert.equal(timer.clearCalls, 1);

	const waitRejected = assert.rejects(waiting, { name: "AbortError" });
	controller.abort();
	await waitRejected;
	await manager.shutdown();
});

test("wait validates manager timeout values", async () => {
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, { idFactory: ids() });
	const run = manager.spawn(request("/one"));
	for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		await assert.rejects(manager.wait([run.id], undefined, undefined, timeoutMs), /positive finite number/u);
	}
	await manager.shutdown();
});

test("initial snapshot callbacks may synchronously cancel retention-bound queued runs", async () => {
	const timer = new ManualWaitTimer();
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, {
		maxConcurrency: 1,
		maxTerminalRuns: 0,
		idFactory: ids(),
		waitTimer: timer,
	});
	manager.spawn(request("/blocker"));
	const queued = manager.spawn(request("/queued"));
	let publications = 0;
	const outcome = await manager.wait([queued.id], undefined, () => {
		publications++;
		assert.equal(manager.cancel(queued.id), true);
	});

	assert.equal(publications, 1);
	assert.equal(outcome.timedOut, false);
	assert.equal(outcome.snapshots[0]?.status, "cancelled");
	assert.equal(manager.get(queued.id), undefined);
	assert.equal(timer.callback, undefined);
	await manager.shutdown();
});

test("exact-boundary timeout and terminal callbacks are settled in callback order", async () => {
	for (const terminalFirst of [true, false]) {
		const clock = new ManualClock(0, 0);
		const timer = new ManualWaitTimer();
		const runner = new FakeRunner();
		const manager = new AgentManager(runner, {
			maxConcurrency: 1,
			maxTerminalRuns: 0,
			idFactory: ids(),
			monotonicNow: clock.monotonicNow,
			waitTimer: timer,
		});
		manager.spawn(request("/blocker"));
		const queued = manager.spawn(request("/queued"));
		const waiting = manager.wait([queued.id], undefined, undefined, 1_000);
		clock.monotonicMs = 1_000;

		if (terminalFirst) {
			const deadlineCallback = timer.takeCallback();
			assert.equal(manager.cancel(queued.id), true);
			assert.equal(timer.clearCalls, 1);
			assert.equal(timer.callback, undefined);
			deadlineCallback();
		} else {
			timer.fire();
			assert.equal(timer.clearCalls, 0);
			assert.equal(timer.callback, undefined);
			manager.cancel(queued.id);
		}

		const outcome = await waiting;
		assert.equal(outcome.timedOut, !terminalFirst);
		assert.equal(outcome.waitedMs, 1_000);
		assert.equal(outcome.snapshots[0]?.status, terminalFirst ? "cancelled" : "queued");
		assert.equal(manager.get(queued.id), undefined);
		await manager.shutdown();
	}
});

test("abort and scheduler failure clean up timers, listeners, and waiter pins", async () => {
	for (const failure of [false, true]) {
		const clock = new ManualClock();
		const timer = new ManualWaitTimer();
		const runner = new FakeRunner();
		const manager = new AgentManager(runner, {
			maxTerminalRuns: 0,
			idFactory: ids(),
			monotonicNow: clock.monotonicNow,
			waitTimer: timer,
		});
		const run = manager.spawn(request("/one"));
		const controller = new AbortController();
		let updates = 0;
		const waiting = manager.wait([run.id], controller.signal, () => updates++, 60_000);

		if (failure) {
			const waitRejected = assert.rejects(waiting, /scheduler failed/u);
			timer.failure = new Error("scheduler failed");
			runner.runs.get(run.id)!.onProgress({ ...createInitialProgress(), revision: 1 });
			await waitRejected;
		} else {
			const waitRejected = assert.rejects(waiting, { name: "AbortError" });
			controller.abort();
			await waitRejected;
		}
		assert.equal(timer.callback, undefined);
		const updatesAfterWait = updates;
		runner.runs.get(run.id)!.onProgress({ ...createInitialProgress(), revision: 2 });
		assert.equal(updates, updatesAfterWait);
		runner.complete(run.id);
		await tick();
		assert.equal(manager.get(run.id), undefined);
	}
});

test("snapshots report a rolling 15-second output token rate", async () => {
	let now = 0;
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, { idFactory: ids(), now: () => now });
	const run = manager.spawn(request("/repo"));
	const deferred = runner.runs.get(run.id);
	assert.ok(deferred);

	now = 5_000;
	deferred.onProgress({ ...createInitialProgress(), outputTokens: 50 });
	assert.equal(manager.get(run.id)?.tokensPerSecond15s, 10);

	now = 10_000;
	deferred.onProgress({ ...createInitialProgress(), outputTokens: 100 });
	assert.equal(manager.get(run.id)?.tokensPerSecond15s, 10);

	now = 20_000;
	assert.equal(manager.get(run.id)?.tokensPerSecond15s, 50 / 15);
	runner.complete(run.id, { outputTokens: 100 });
	await tick();

	now = 60_000;
	assert.equal(manager.get(run.id)?.tokensPerSecond15s, 50 / 15);
});

test("usage is attributed exactly once across duplicate and repeated claims", async () => {
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, { maxConcurrency: 2, idFactory: ids() });
	const first = manager.spawn(request("/one"));
	const second = manager.spawn(request("/two"));
	const usage = {
		input: 10,
		output: 2,
		cacheRead: 3,
		cacheWrite: 1,
		totalTokens: 16,
		cost: { input: 0.02, output: 0.04, cacheRead: 0.01, cacheWrite: 0.01, total: 0.08 },
	};
	runner.complete(first.id, { usage });
	runner.complete(second.id, { usage });
	const { snapshots } = await manager.wait([first.id, first.id, second.id]);

	const initial = manager.claimUsage(snapshots);
	assert.deepEqual(initial.attributedIds, [first.id, second.id]);
	assert.deepEqual(initial.usage, {
		input: 20,
		output: 4,
		cacheRead: 6,
		cacheWrite: 2,
		totalTokens: 32,
		cost: { input: 0.04, output: 0.08, cacheRead: 0.02, cacheWrite: 0.02, total: 0.16 },
	});
	assert.deepEqual(manager.claimUsage(snapshots), { attributedIds: [] });
});

test("active waits pin terminal runs while retention remains bounded", async () => {
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, { maxConcurrency: 3, maxTerminalRuns: 1, idFactory: ids() });
	const first = manager.spawn(request("/one"));
	const second = manager.spawn(request("/two"));
	const third = manager.spawn(request("/three"));
	const waiting = manager.wait([first.id, second.id]);
	runner.complete(first.id);
	await tick();
	runner.complete(third.id);
	await tick();
	assert.equal(manager.get(first.id)?.status, "completed");
	runner.complete(second.id);
	const { snapshots } = await waiting;
	assert.deepEqual(snapshots.map((run) => run.id), [first.id, second.id]);
	assert.equal(manager.getAll().filter((run) => run.status === "completed").length, 1);
});

test("shutdown cancels all queued and running children", async () => {
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, { maxConcurrency: 1, idFactory: ids() });
	const running = manager.spawn(request("/one"));
	const queued = manager.spawn(request("/two"));
	await manager.shutdown();
	assert.equal(manager.get(running.id)?.status, "cancelled");
	assert.equal(manager.get(queued.id)?.status, "cancelled");
	assert.equal(runner.active, 0);
});

test("manager reports non-sensitive early signal deaths as startup policy failures", async () => {
	const prompt = "private prompt marker";
	const argvValue = "private argv marker".repeat(8);
	const maxArgumentBytes = Buffer.byteLength(argvValue, "utf8");
	const run = await settleResult({
		exitCode: null,
		signal: "SIGKILL",
		stderr: "",
		progress: createInitialProgress(100),
		timedOut: false,
		startupSignalDeath: {
			signal: "SIGKILL",
			elapsedMs: 37,
			pid: 42_424,
			argumentCount: 18,
			maxArgumentBytes,
		},
	}, prompt);

	assert.equal(run.status, "failed");
	assert.equal(
		run.error,
		`Pi was killed during startup (signal SIGKILL, 37 ms, pid 42424, 18 argv elements, max argv element ${maxArgumentBytes} bytes). A host security or process policy may be responsible.`,
	);
	assert.equal(run.error?.includes(prompt), false);
	assert.equal(run.error?.includes(argvValue), false);
});

test("manager reports stdin failures without overriding a valid completion", async () => {
	const stdinError = "Could not send prompt to Pi stdin (EIO)";
	const failed = await settleResult({
		exitCode: null,
		signal: "SIGTERM",
		stderr: "",
		progress: createInitialProgress(),
		timedOut: false,
		stdinError,
	});
	assert.equal(failed.status, "failed");
	assert.equal(failed.error, stdinError);

	const completedProgress = createInitialProgress();
	completedProgress.finalAssistantSeen = true;
	completedProgress.finalOutput = "valid completion";
	completedProgress.finalStopReason = "stop";
	const completed = await settleResult({
		exitCode: 0,
		signal: null,
		stderr: "",
		progress: completedProgress,
		timedOut: false,
		stdinError,
	});
	assert.equal(completed.status, "completed");
	assert.equal(completed.error, undefined);
	assert.equal(completed.finalOutput, "valid completion");
});

test("manager keeps post-start and stderr signal failures on the generic path", async () => {
	const afterOutputProgress = createInitialProgress();
	afterOutputProgress.turns = 1;
	const afterOutput = await settleResult({
		exitCode: null,
		signal: "SIGTERM",
		stderr: "",
		progress: afterOutputProgress,
		timedOut: false,
	});
	assert.equal(afterOutput.error, "Pi exited with signal SIGTERM");
	assert.equal(afterOutput.error?.includes("security or process policy"), false);

	const withStderr = await settleResult({
		exitCode: null,
		signal: "SIGKILL",
		stderr: "ordinary child stderr",
		progress: createInitialProgress(),
		timedOut: false,
	});
	assert.equal(withStderr.error, "ordinary child stderr");
	assert.equal(withStderr.error?.includes("security or process policy"), false);
});

test("canonical cwd resolution accepts directories and rejects files", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-manager-"));
	try {
		const nested = join(root, "nested");
		await import("node:fs/promises").then(({ mkdir }) => mkdir(nested));
		assert.equal(await resolveCanonicalCwd(root, "nested"), await import("node:fs/promises").then(({ realpath }) => realpath(nested)));
		const file = join(root, "file.txt");
		await writeFile(file, "x");
		await assert.rejects(resolveCanonicalCwd(root, "file.txt"), /not a directory/u);
		await assert.rejects(resolveCanonicalCwd(root, "missing"), /does not exist/u);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
