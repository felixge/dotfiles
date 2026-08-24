import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { AgentManager, resolveCanonicalCwd } from "../manager.ts";
import { createInitialProgress } from "../runner.ts";
import type {
	AgentRunConfig,
	AgentRunner,
	RunnerProgress,
	RunnerResult,
	RunningAgentProcess,
} from "../types.ts";

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

function request(cwd: string, access: "read" | "write" = "read") {
	return { prompt: "task", model: "provider/model", thinking: "low" as const, cwd, access };
}

async function tick(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

test("manager enforces global concurrency and one writer per canonical cwd", async () => {
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, { maxConcurrency: 2, idFactory: ids() });
	const firstWriter = manager.spawn(request("/repo", "write"));
	const secondWriter = manager.spawn(request("/repo", "write"));
	const reader = manager.spawn(request("/repo", "read"));

	assert.equal(manager.get(firstWriter.id)?.status, "running");
	assert.equal(manager.get(secondWriter.id)?.status, "queued");
	assert.equal(manager.get(secondWriter.id)?.currentActivity, "writer lock");
	assert.equal(manager.get(reader.id)?.status, "running");
	assert.equal(runner.maxActive, 2);

	runner.complete(reader.id);
	await tick();
	assert.equal(manager.get(secondWriter.id)?.status, "queued");
	runner.complete(firstWriter.id);
	await tick();
	assert.equal(manager.get(secondWriter.id)?.status, "running");
	runner.complete(secondWriter.id);
	await tick();
	assert.equal(manager.get(secondWriter.id)?.status, "completed");
	assert.equal(runner.maxActive, 2);
});

test("manager preserves optional agent names in snapshots and runner config", async () => {
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, { idFactory: ids() });
	const named = manager.spawn({ ...request("/repo"), name: "reviewer" });

	assert.equal(named.name, "reviewer");
	assert.equal(manager.get(named.id)?.name, "reviewer");
	assert.equal(runner.runs.get(named.id)?.config.name, "reviewer");

	runner.complete(named.id);
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

	const [snapshot] = await manager.wait([run.id]);
	assert.equal(snapshot.fullOutputPath, "/tmp/full-output.log");
	assert.deepEqual(snapshot.finalOutputTruncation, truncation);
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

test("wait preserves input order and aborting wait leaves children running", async () => {
	const runner = new FakeRunner();
	const manager = new AgentManager(runner, { maxConcurrency: 2, idFactory: ids() });
	const first = manager.spawn(request("/one"));
	const second = manager.spawn(request("/two"));
	const controller = new AbortController();
	const abortedWait = manager.wait([first.id], controller.signal);
	controller.abort();
	await assert.rejects(abortedWait, { name: "AbortError" });
	assert.equal(manager.get(first.id)?.status, "running");

	const orderedWait = manager.wait([second.id, first.id]);
	runner.complete(first.id);
	runner.complete(second.id);
	const results = await orderedWait;
	assert.deepEqual(results.map((run) => run.id), [second.id, first.id]);
	assert.ok(results.every((run) => run.status === "completed"));
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
	const snapshots = await manager.wait([first.id, first.id, second.id]);

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
	const results = await waiting;
	assert.deepEqual(results.map((run) => run.id), [first.id, second.id]);
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
