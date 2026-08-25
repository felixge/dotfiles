import fs from "node:fs";
import path from "node:path";
import { resolveWord } from "./shell.js";
import type { CommandInvocation, ExecutionContext, ParsedWord, SymbolicPath } from "./types.js";

const SENSITIVE_ROOTS = [
  "/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/opt", "/root", "/sbin", "/srv", "/sys", "/usr", "/var",
];

export interface RmInvocation {
  invocation: CommandInvocation;
  recursive: boolean;
  targets: ParsedWord[];
}

function executableName(invocation: CommandInvocation): string | undefined {
  return invocation.executable.literal ? path.posix.basename(invocation.executable.literal) : undefined;
}

export function inspectRm(invocation: CommandInvocation): RmInvocation | undefined {
  if (executableName(invocation) !== "rm") return undefined;
  let recursive = false;
  let options = true;
  const targets: ParsedWord[] = [];
  for (const arg of invocation.args) {
    const value = arg.literal;
    if (options && value === "--") {
      options = false;
      continue;
    }
    if (options && value?.startsWith("-") && value !== "-") {
      if (value === "--recursive" || (/^-[^-]+$/.test(value) && /[rR]/.test(value.slice(1)))) recursive = true;
      continue;
    }
    targets.push(arg);
  }
  return { invocation, recursive, targets };
}

function isEqualOrBelow(value: string, root: string): boolean {
  return value === root || value.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function isAncestorOrEqual(value: string, descendant: string): boolean {
  return isEqualOrBelow(descendant, value);
}

function macTemporaryPath(value: string): boolean {
  return /^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T\/.+/.test(value);
}

function isSensitive(value: string): boolean {
  const systemPath = value.replace(/^\/private(?=\/(?:etc|var)(?:\/|$))/, "");
  return SENSITIVE_ROOTS.some((root) => isEqualOrBelow(systemPath, root));
}

function canonicalLocalTarget(value: string): string | undefined {
  const absolute = path.resolve(value);
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      const parent = fs.realpathSync.native(path.dirname(absolute));
      return path.join(parent, path.basename(absolute));
    }
    return fs.realpathSync.native(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
  }

  const missing: string[] = [];
  let ancestor = absolute;
  while (true) {
    try {
      const canonical = fs.realpathSync.native(ancestor);
      return path.join(canonical, ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return undefined;
      missing.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function resolveLocalTarget(word: ParsedWord, execution: Extract<ExecutionContext, { kind: "local" }>): string | undefined {
  const resolved = resolveWord(word, execution);
  if (resolved.unresolved || resolved.hasUnquotedGlob || resolved.value === undefined) return undefined;
  let value = resolved.value;
  if (value === "~") value = execution.home;
  else if (value.startsWith("~/")) value = path.join(execution.home, value.slice(2));
  const absolute = path.resolve(execution.cwd, value);
  return canonicalLocalTarget(absolute);
}

function safeLocalTemporary(value: string, execution: Extract<ExecutionContext, { kind: "local" }>): boolean {
  if (macTemporaryPath(value)) return true;
  return execution.tempRoots.some((root) => {
    if (!path.isAbsolute(root)) return false;
    const canonical = canonicalLocalTarget(root);
    return canonical ? value.startsWith(`${canonical}/`) : false;
  });
}

export function isHighRiskLocalTarget(word: ParsedWord, execution: Extract<ExecutionContext, { kind: "local" }>): boolean {
  const target = resolveLocalTarget(word, execution);
  if (!target) return true;
  const cwd = canonicalLocalTarget(execution.cwd);
  const home = canonicalLocalTarget(execution.home);
  if (!cwd || !home) return true;
  if (target === "/") return true;
  if (isAncestorOrEqual(target, cwd) || isAncestorOrEqual(target, home)) return true;
  if (safeLocalTemporary(target, execution)) return false;
  if (isSensitive(target)) return true;
  return !isEqualOrBelow(target, cwd);
}

function normalizeSymbolicValue(value: string): string {
  const normalized = path.posix.normalize(value || ".");
  return normalized === "." ? "" : normalized.replace(/^\.\//, "");
}

export function resolveRemoteTarget(word: ParsedWord, execution: Extract<ExecutionContext, { kind: "ssh" }>): SymbolicPath {
  const resolved = resolveWord(word, execution);
  if (resolved.unresolved || resolved.hasUnquotedGlob || resolved.value === undefined) return { kind: "unknown" };
  const value = resolved.value;
  if (value === "~" || value === "<remote-home>") return { kind: "home", value: "" };
  if (value.startsWith("~/")) return { kind: "home", value: normalizeSymbolicValue(value.slice(2)) };
  if (value.startsWith("<remote-home>/")) return { kind: "home", value: normalizeSymbolicValue(value.slice(14)) };
  if (value === "<remote-tmp>") return { kind: "temp", value: "" };
  if (value.startsWith("<remote-tmp>/")) return { kind: "temp", value: normalizeSymbolicValue(value.slice(13)) };
  if (value.startsWith("/")) return { kind: "absolute", value: path.posix.normalize(value) };
  if (execution.cwd.kind === "unknown") return { kind: "unknown" };
  return { kind: execution.cwd.kind, value: normalizeSymbolicValue(path.posix.join(execution.cwd.value, value)) } as SymbolicPath;
}

function symbolicAncestorOrEqual(target: SymbolicPath, current: SymbolicPath): boolean {
  if (target.kind === "unknown" || current.kind === "unknown" || target.kind !== current.kind) return false;
  if (target.kind === "absolute") return isAncestorOrEqual(target.value, current.value);
  return target.value === "" || isAncestorOrEqual(target.value, current.value);
}

export function isHighRiskRemoteTarget(word: ParsedWord, execution: Extract<ExecutionContext, { kind: "ssh" }>): boolean {
  const target = resolveRemoteTarget(word, execution);
  if (target.kind === "unknown") return true;
  if (target.kind === "temp") return target.value === "";
  if (symbolicAncestorOrEqual(target, execution.cwd)) return true;
  if (target.kind === "home") return target.value === "";
  if (target.value === "/") return true;
  if (target.value.startsWith("/tmp/")) return false;
  if (isSensitive(target.value)) return true;
  if (/^\/(?:home|Users)\/[^/]+\/.+/.test(target.value)) return false;
  return true;
}

export function isHighRiskRm(rm: RmInvocation): boolean {
  if (!rm.recursive || rm.targets.length === 0) return false;
  return rm.targets.some((target) => rm.invocation.execution.kind === "local"
    ? isHighRiskLocalTarget(target, rm.invocation.execution)
    : isHighRiskRemoteTarget(target, rm.invocation.execution));
}

export function isHomeDotfileTarget(word: ParsedWord, execution: ExecutionContext): boolean {
  if (execution.kind === "ssh") {
    const target = resolveRemoteTarget(word, execution);
    if (target.kind === "home") return Boolean(target.value.split("/")[0]?.startsWith("."));
    return target.kind === "absolute" && /^\/(?:home|Users)\/[^/]+\/\./.test(target.value);
  }
  const resolved = resolveWord(word, execution);
  if (resolved.unresolved || resolved.value === undefined) return false;
  let value = resolved.value;
  if (value.startsWith("~/")) value = path.join(execution.home, value.slice(2));
  const absolute = path.resolve(execution.cwd, value);
  const relative = path.relative(execution.home, absolute);
  const first = relative.split(path.sep)[0];
  return relative !== "" && !relative.startsWith("..") && Boolean(first?.startsWith("."));
}

export function isProtectedRootOperand(word: ParsedWord, execution: ExecutionContext): boolean {
  if (execution.kind === "ssh") {
    const target = resolveRemoteTarget(word, execution);
    return target.kind === "absolute" && isSensitive(target.value) && !isEqualOrBelow(target.value, "/tmp");
  }
  const target = resolveLocalTarget(word, execution);
  return Boolean(target && isSensitive(target) && !safeLocalTemporary(target, execution));
}
