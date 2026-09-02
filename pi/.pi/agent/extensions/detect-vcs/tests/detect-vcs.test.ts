import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type {
	ExecOptions,
	ExecResult,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import detectVcsExtension, {
	detectVcs,
	formatDetection,
	normalizeToolPath,
	type VcsDetection,
} from "../index.ts";

type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

const failed = (stderr = "not a repository"): ExecResult => ({
	stdout: "",
	stderr,
	code: 1,
	killed: false,
});

const succeeded = (root = ""): ExecResult => ({
	stdout: root ? `${root}\n` : "",
	stderr: "",
	code: 0,
	killed: false,
});

const killed = (): ExecResult => ({
	stdout: "",
	stderr: "",
	code: 143,
	killed: true,
});

async function fixture(): Promise<{ base: string; project: string; cleanup(): Promise<void> }> {
	const base = await mkdtemp(join(tmpdir(), "detect-vcs-"));
	const project = join(base, "project with spaces");
	await mkdir(project);
	return { base, project, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test("prefers jj over Git and invokes commands without a shell", async (t) => {
	const fs = await fixture();
	t.after(fs.cleanup);
	const calls: Array<{ command: string; args: string[]; options?: ExecOptions }> = [];
	const exec: Exec = async (command, args, options) => {
		calls.push({ command, args, options });
		return succeeded(fs.base);
	};

	const result = await detectVcs(fs.project, fs.base, { exec, timeoutMs: 321 });
	assert.deepEqual(result, { vcs: "jj", path: fs.project, root: fs.base });
	assert.deepEqual(calls, [{
		command: "jj",
		args: ["--ignore-working-copy", "root"],
		options: { cwd: fs.project, signal: undefined, timeout: 321 },
	}]);
});

test("falls back to Git after jj for relative and absolute paths", async (t) => {
	const fs = await fixture();
	t.after(fs.cleanup);
	for (const directory of ["project with spaces", fs.project]) {
		const calls: string[] = [];
		const exec: Exec = async (command, args, options) => {
			calls.push(`${command} ${args.join(" ")}`);
			assert.equal(options?.cwd, fs.project);
			if (command === "jj") return failed();
			return succeeded(fs.base);
		};
		assert.deepEqual(await detectVcs(directory, fs.base, { exec }), {
			vcs: "git",
			path: fs.project,
			root: fs.base,
		});
		assert.deepEqual(calls, ["jj --ignore-working-copy root", "git rev-parse --show-toplevel"]);
	}
});

test("recognizes bare repositories through the Git directory fallback", async (t) => {
	const fs = await fixture();
	t.after(fs.cleanup);
	const calls: string[] = [];
	const exec: Exec = async (command, args) => {
		calls.push(`${command} ${args.join(" ")}`);
		if (command === "jj" || args.includes("--show-toplevel")) return failed();
		return succeeded(".");
	};

	assert.deepEqual(await detectVcs(fs.project, fs.base, { exec }), {
		vcs: "git",
		path: fs.project,
		root: fs.project,
	});
	assert.deepEqual(calls, [
		"jj --ignore-working-copy root",
		"git rev-parse --show-toplevel",
		"git rev-parse --git-dir",
	]);
});

test("recognizes directories inside .git and derives the worktree root", async (t) => {
	const fs = await fixture();
	t.after(fs.cleanup);
	const internal = join(fs.project, ".git", "objects");
	await mkdir(internal, { recursive: true });
	const exec: Exec = async (command, args) => {
		if (command === "jj" || args.includes("--show-toplevel")) return failed();
		return succeeded(join(fs.project, ".git"));
	};

	assert.deepEqual(await detectVcs(internal, fs.base, { exec }), {
		vcs: "git",
		path: internal,
		root: fs.project,
	});
});

test("successful probes with empty stdout identify the VCS without a root", async (t) => {
	const fs = await fixture();
	t.after(fs.cleanup);
	assert.deepEqual(await detectVcs(fs.project, fs.base, { exec: async () => succeeded() }), {
		vcs: "jj",
		path: fs.project,
	});

	let calls = 0;
	assert.deepEqual(await detectVcs(fs.project, fs.base, {
		exec: async () => (++calls === 1 ? failed() : succeeded()),
	}), {
		vcs: "git",
		path: fs.project,
	});
	assert.equal(calls, 2);

	calls = 0;
	assert.deepEqual(await detectVcs(fs.project, fs.base, {
		exec: async () => (++calls < 3 ? failed() : succeeded()),
	}), {
		vcs: "git",
		path: fs.project,
	});
	assert.equal(calls, 3);
});

test("returns none when no probe finds a repository", async (t) => {
	const fs = await fixture();
	t.after(fs.cleanup);
	const calls: string[] = [];
	const result = await detectVcs("project with spaces", fs.base, {
		exec: async (command, args) => {
			calls.push(`${command} ${args.join(" ")}`);
			return failed();
		},
	});
	assert.deepEqual(result, { vcs: "none", path: fs.project });
	assert.deepEqual(calls, [
		"jj --ignore-working-copy root",
		"git rev-parse --show-toplevel",
		"git rev-parse --git-dir",
	]);
	assert.equal(formatDetection(result), `VCS: none\nPath: ${fs.project}`);
});

test("rejects missing paths and files before invoking VCS commands", async (t) => {
	const fs = await fixture();
	t.after(fs.cleanup);
	const file = join(fs.base, "plain file");
	await writeFile(file, "content");
	let calls = 0;
	const exec: Exec = async () => {
		calls += 1;
		return failed();
	};

	await assert.rejects(detectVcs("missing", fs.base, { exec }), new RegExp(`Path does not exist: ${resolve(fs.base, "missing")}`));
	await assert.rejects(detectVcs(file, fs.base, { exec }), new RegExp(`Path is not a directory: ${file}`));
	assert.equal(calls, 0);
});

test("reports cancellation and preserves jj precedence on timeout", async (t) => {
	const fs = await fixture();
	t.after(fs.cleanup);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		detectVcs(fs.project, fs.base, { exec: async () => failed(), signal: controller.signal }),
		/VCS detection cancelled/u,
	);

	let calls = 0;
	await assert.rejects(
		detectVcs(fs.project, fs.base, { exec: async () => {
			calls += 1;
			return killed();
		} }),
		/VCS detection timed out while running jj/u,
	);
	assert.equal(calls, 1);
});

interface RegisteredTool {
	name: string;
	promptSnippet?: string;
	execute: (
		toolCallId: string,
		params: { directory: string },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: { cwd: string },
	) => Promise<{ content: Array<{ type: string; text: string }>; details: VcsDetection }>;
}

type BeforeAgentStart = (
	event: { systemPrompt: string },
	ctx: { cwd: string; signal?: AbortSignal },
) => Promise<{ systemPrompt: string; message?: unknown }>;

function registerTestExtension(exec: Exec): { handler: BeforeAgentStart; tool: RegisteredTool } {
	let handler: BeforeAgentStart | undefined;
	let tool: RegisteredTool | undefined;
	const pi = {
		on(event: string, registered: unknown) {
			if (event === "before_agent_start") handler = registered as BeforeAgentStart;
		},
		registerTool(registered: RegisteredTool) {
			tool = registered;
		},
		exec,
	} as unknown as ExtensionAPI;
	detectVcsExtension(pi);
	assert.ok(handler);
	assert.ok(tool);
	return { handler, tool };
}

test("injects fresh chained VCS context on every agent run", async (t) => {
	const fs = await fixture();
	t.after(fs.cleanup);
	let probes = 0;
	const { handler } = registerTestExtension(async () => {
		probes += 1;
		return succeeded(fs.base);
	});

	for (const incoming of ["base prompt", "base prompt with prior extension context"]) {
		const result = await handler({ systemPrompt: incoming }, { cwd: fs.project });
		assert.ok(result.systemPrompt.startsWith(`${incoming}\n\n## Version Control`));
		assert.match(result.systemPrompt, /VCS: jj/u);
		assert.match(result.systemPrompt, new RegExp(`Path: ${fs.project}`));
		assert.equal(result.systemPrompt.match(/## Version Control/gu)?.length, 1);
		assert.equal(result.message, undefined);
	}
	assert.equal(probes, 2);
});

test("injects unknown VCS context when detection fails unexpectedly", async (t) => {
	const fs = await fixture();
	t.after(fs.cleanup);
	let calls = 0;
	const { handler, tool } = registerTestExtension(async () => {
		calls += 1;
		return killed();
	});

	const result = await handler({ systemPrompt: "base prompt" }, { cwd: fs.project });
	assert.match(result.systemPrompt, /## Version Control\n\nVCS: unknown/u);
	assert.match(result.systemPrompt, /Reason: VCS detection timed out while running jj/u);
	assert.equal(calls, 1);

	await assert.rejects(
		tool.execute("call-error", { directory: fs.project }, undefined, undefined, { cwd: fs.base }),
		/VCS detection timed out while running jj/u,
	);
	assert.equal(calls, 2);
});

test("normalizes documented tool paths and returns concise Git details", async (t) => {
	const fs = await fixture();
	t.after(fs.cleanup);
	const { tool } = registerTestExtension(async (command) => command === "jj" ? failed() : succeeded(fs.base));
	assert.equal(tool.name, "detect_vcs");
	assert.match(tool.promptSnippet ?? "", /outside the current working directory/u);
	assert.equal(normalizeToolPath("@project\u00a0with\u3000spaces"), "project with spaces");
	assert.equal(normalizeToolPath("@~/nested\u202fdir", "/test/home"), join("/test/home", "nested dir"));
	assert.equal(normalizeToolPath("~", "/test/home"), "/test/home");

	const result = await tool.execute(
		"call-1",
		{ directory: "@project\u00a0with\u3000spaces" },
		undefined,
		undefined,
		{ cwd: fs.base },
	);
	assert.deepEqual(result.details, { vcs: "git", path: fs.project, root: fs.base });
	assert.equal(result.content[0]?.text, `VCS: git\nPath: ${fs.project}\nRoot: ${fs.base}`);
});
