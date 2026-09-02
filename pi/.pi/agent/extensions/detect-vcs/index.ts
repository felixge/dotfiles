import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExecOptions,
	type ExecResult,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

export type VcsKind = "jj" | "git" | "none";

export interface VcsDetection {
	vcs: VcsKind;
	path: string;
	root?: string;
}

interface DirectoryStat {
	isDirectory(): boolean;
}

type StatDirectory = (path: string) => Promise<DirectoryStat>;
type ExecCommand = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export interface DetectVcsOptions {
	exec: ExecCommand;
	stat?: StatDirectory;
	signal?: AbortSignal;
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

function throwIfCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("VCS detection cancelled");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function validateDirectory(path: string, statDirectory: StatDirectory, signal?: AbortSignal): Promise<void> {
	throwIfCancelled(signal);
	let info: DirectoryStat;
	try {
		info = await statDirectory(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") throw new Error(`Path does not exist: ${path}`, { cause: error });
		throw new Error(`Cannot access directory ${path}: ${errorMessage(error)}`, { cause: error });
	}
	throwIfCancelled(signal);
	if (!info.isDirectory()) throw new Error(`Path is not a directory: ${path}`);
}

async function probe(
	command: string,
	args: string[],
	path: string,
	options: DetectVcsOptions,
): Promise<ExecResult> {
	throwIfCancelled(options.signal);
	let result: ExecResult;
	try {
		result = await options.exec(command, args, {
			cwd: path,
			signal: options.signal,
			timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		});
	} catch (error) {
		throwIfCancelled(options.signal);
		throw new Error(`Could not run ${command}: ${errorMessage(error)}`, { cause: error });
	}
	throwIfCancelled(options.signal);
	if (result.killed) throw new Error(`VCS detection timed out while running ${command}`);
	return result;
}

function repositoryRoot(stdout: string, path: string): string | undefined {
	const root = stdout.trim();
	return root ? resolve(path, root) : undefined;
}

function detection(vcs: "jj" | "git", path: string, root?: string): VcsDetection {
	return { vcs, path, ...(root ? { root } : {}) };
}

function rootFromGitDir(stdout: string, path: string): string | undefined {
	const gitDir = repositoryRoot(stdout, path);
	if (!gitDir) return undefined;
	return basename(gitDir) === ".git" ? dirname(gitDir) : gitDir;
}

export async function detectVcs(directory: string, cwd: string, options: DetectVcsOptions): Promise<VcsDetection> {
	const path = resolve(cwd, directory);
	await validateDirectory(path, options.stat ?? stat, options.signal);

	const jj = await probe("jj", ["--ignore-working-copy", "root"], path, options);
	if (jj.code === 0) return detection("jj", path, repositoryRoot(jj.stdout, path));

	const git = await probe("git", ["rev-parse", "--show-toplevel"], path, options);
	if (git.code === 0) return detection("git", path, repositoryRoot(git.stdout, path));

	const gitDir = await probe("git", ["rev-parse", "--git-dir"], path, options);
	if (gitDir.code === 0) return detection("git", path, rootFromGitDir(gitDir.stdout, path));

	return { vcs: "none", path };
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;

export function normalizeToolPath(path: string, home = homedir()): string {
	let normalized = path.replace(UNICODE_SPACES, " ");
	if (normalized.startsWith("@")) normalized = normalized.slice(1);
	if (normalized === "~") return home;
	return normalized.startsWith("~/") ? join(home, normalized.slice(2)) : normalized;
}

export function formatDetection(result: VcsDetection): string {
	return [
		`VCS: ${result.vcs}`,
		`Path: ${result.path}`,
		...(result.root ? [`Root: ${result.root}`] : []),
	].join("\n");
}

function conciseReason(error: unknown): string {
	const reason = errorMessage(error).replace(/\s+/gu, " ").trim();
	return reason.length > 160 ? `${reason.slice(0, 157)}...` : reason;
}

export default function detectVcsExtension(pi: ExtensionAPI): void {
	const detect = (directory: string, cwd: string, signal?: AbortSignal) =>
		detectVcs(directory, cwd, { exec: pi.exec.bind(pi), signal });

	pi.on("before_agent_start", async (event, ctx) => {
		let context: string;
		try {
			context = formatDetection(await detect(ctx.cwd, ctx.cwd, ctx.signal));
		} catch (error) {
			context = `VCS: unknown\nReason: ${conciseReason(error)}`;
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n## Version Control\n\n${context}`,
		};
	});

	pi.registerTool(defineTool({
		name: "detect_vcs",
		label: "Detect VCS",
		description: "Detect whether another directory belongs to a jj or Git repository. jj takes precedence.",
		promptSnippet: "Detect version control for directories outside the current working directory",
		parameters: Type.Object({
			directory: Type.String({
				minLength: 1,
				description: "Directory path, absolute or relative to the current working directory",
			}),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await detect(normalizeToolPath(params.directory), ctx.cwd, signal);
			return {
				content: [{ type: "text", text: formatDetection(result) }],
				details: result,
			};
		},
	}));
}
