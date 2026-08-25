import path from "node:path";
import sh from "mvdan-sh";
import type {
  CommandAnalysis,
  CommandInvocation,
  ExecutionContext,
  ParsedWord,
  SymbolicPath,
  WordPart,
} from "./types.js";

const { syntax } = sh;
const MAX_NESTING = 5;
const SHELLS = new Set(["sh", "bash", "zsh"]);
const SSH_OPTIONS_WITH_ARGUMENT = new Set([
  "B", "b", "c", "D", "E", "e", "F", "I", "i", "J", "L", "l", "m", "O", "o", "p", "Q", "R", "S", "W",
]);

interface WalkState {
  execution: ExecutionContext;
  pipelineId?: number;
  pipelineIndex?: number;
  parentInvocationId?: number;
  nestedKind?: CommandInvocation["nestedKind"];
}

interface BuildState {
  analysis: CommandAnalysis;
  nextInvocationId: number;
  nextPipelineId: number;
}

function basename(value: string): string {
  return path.posix.basename(value);
}

function cloneSymbolic(value: SymbolicPath): SymbolicPath {
  return { ...value };
}

function cloneExecution(execution: ExecutionContext): ExecutionContext {
  if (execution.kind === "local") {
    return { ...execution, tempRoots: [...execution.tempRoots], env: { ...execution.env } };
  }
  return { ...execution, cwd: cloneSymbolic(execution.cwd), home: cloneSymbolic(execution.home) };
}

function sourceSlice(source: string, node: any): string {
  try {
    const start = node.Pos();
    const end = node.End();
    const lines = source.split("\n");
    if (start.Line() === end.Line()) {
      return (lines[start.Line() - 1] ?? "").slice(start.Col() - 1, end.Col() - 1);
    }
    const selected = lines.slice(start.Line() - 1, end.Line());
    selected[0] = selected[0]?.slice(start.Col() - 1) ?? "";
    selected[selected.length - 1] = selected[selected.length - 1]?.slice(0, end.Col() - 1) ?? "";
    return selected.join("\n");
  } catch {
    return "";
  }
}

function containsUnquotedGlob(raw: string): boolean {
  let escaped = false;
  for (const char of raw) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "*" || char === "?" || char === "[") return true;
  }
  return false;
}

function unescapeLiteral(value: string, quoted: boolean): string {
  if (!quoted) return value.replace(/\\([\s\S])/g, "$1");
  return value.replace(/\\([$`"\\\n])/g, (_match, char: string) => char === "\n" ? "" : char);
}

function parseParts(nodes: any[], source: string, quoted = false): { parts: WordPart[]; literal?: string; glob: boolean } {
  const parts: WordPart[] = [];
  let literal = "";
  let allLiteral = true;
  let glob = false;

  for (const node of Array.from(nodes ?? [])) {
    const type = syntax.NodeType(node);
    if (type === "Lit") {
      const value = unescapeLiteral(String(node.Value ?? ""), quoted);
      parts.push({ kind: "literal", value, quoted });
      literal += value;
      if (!quoted && containsUnquotedGlob(sourceSlice(source, node))) glob = true;
    } else if (type === "SglQuoted") {
      const value = String(node.Value ?? "");
      parts.push({ kind: "literal", value, quoted: true });
      literal += value;
    } else if (type === "DblQuoted") {
      const nested = parseParts(node.Parts, source, true);
      parts.push(...nested.parts);
      glob ||= nested.glob;
      if (nested.literal === undefined) allLiteral = false;
      else literal += nested.literal;
    } else if (type === "ParamExp") {
      const simple = !node.Excl && !node.Length && !node.Width && !node.Index && !node.Slice && !node.Repl && !node.Exp;
      const name = simple && node.Param?.Value ? String(node.Param.Value) : undefined;
      parts.push({ kind: "parameter", name, quoted });
      allLiteral = false;
    } else if (type === "CmdSubst" || type === "ProcSubst") {
      parts.push({ kind: "command-substitution", quoted });
      allLiteral = false;
    } else if (type === "ArithmExp") {
      parts.push({ kind: "arithmetic", quoted });
      allLiteral = false;
    } else {
      parts.push({ kind: "other", quoted });
      allLiteral = false;
      if (!quoted && containsUnquotedGlob(sourceSlice(source, node))) glob = true;
    }
  }

  return { parts, literal: allLiteral ? literal : undefined, glob };
}

export function parsedWord(node: any, source: string): ParsedWord {
  const parsed = parseParts(node?.Parts ?? [], source);
  return {
    raw: sourceSlice(source, node),
    literal: parsed.literal,
    parts: parsed.parts,
    dynamic: parsed.literal === undefined || parsed.glob,
    hasUnquotedGlob: parsed.glob,
  };
}

export function resolveWord(word: ParsedWord, execution: ExecutionContext): { value?: string; unresolved: boolean; hasUnquotedGlob: boolean } {
  let value = "";
  for (const part of word.parts) {
    if (part.kind === "literal") {
      value += part.value;
      continue;
    }
    if (part.kind !== "parameter" || !part.name) {
      return { unresolved: true, hasUnquotedGlob: word.hasUnquotedGlob };
    }

    if (execution.kind === "local") {
      const resolved = part.name === "PWD" ? execution.cwd : execution.env[part.name];
      if (resolved === undefined) return { unresolved: true, hasUnquotedGlob: word.hasUnquotedGlob };
      value += resolved;
    } else if (part.name === "HOME") {
      value += "<remote-home>";
    } else if (part.name === "TMPDIR") {
      value += "<remote-tmp>";
    } else {
      return { unresolved: true, hasUnquotedGlob: word.hasUnquotedGlob };
    }
  }
  return { value, unresolved: false, hasUnquotedGlob: word.hasUnquotedGlob };
}

function normalizeWrappers(words: ParsedWord[]): { executable: ParsedWord; args: ParsedWord[]; wrappers: string[] } {
  let index = 0;
  const wrappers: string[] = [];

  while (index < words.length) {
    const wrapperLiteral = words[index]?.literal;
    const name = wrapperLiteral ? basename(wrapperLiteral) : undefined;
    if (name === "command") {
      wrappers.push(name);
      index++;
      while (words[index]?.literal?.startsWith("-") && words[index]?.literal !== "--") index++;
      if (words[index]?.literal === "--") index++;
      continue;
    }
    if (name === "env") {
      wrappers.push(name);
      index++;
      while (index < words.length) {
        const value = words[index]?.literal;
        if (value === "--") {
          index++;
          break;
        }
        if (value?.startsWith("-")) {
          index++;
          if (["-u", "--unset", "-C", "--chdir", "-S", "--split-string"].includes(value)) index++;
          continue;
        }
        if (value && /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
          index++;
          continue;
        }
        break;
      }
      continue;
    }
    if (name === "sudo") {
      wrappers.push(name);
      index++;
      while (index < words.length) {
        const value = words[index]?.literal;
        if (value === "--") {
          index++;
          break;
        }
        if (!value?.startsWith("-")) break;
        index++;
        if (["-C", "-D", "-g", "-h", "-p", "-R", "-r", "-t", "-T", "-u"].includes(value)) index++;
      }
      continue;
    }
    break;
  }

  return {
    executable: words[index] ?? { raw: "", parts: [], dynamic: true, hasUnquotedGlob: false },
    args: words.slice(index + 1),
    wrappers,
  };
}

function fallbackRules(source: string): Set<string> {
  const matches = new Set<string>();
  const commandStarts = source
    .split(/(?:^|[;&|()\n])+/)
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith("#"));

  for (const command of commandStarts) {
    const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    let index = 0;
    while (["command", "sudo"].includes(tokens[index] ?? "")) {
      if (tokens[index] === "sudo") matches.add("sudo");
      index++;
    }
    if (tokens[index] === "env") {
      index++;
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index++;
    }
    const executable = basename(tokens[index] ?? "");
    const args = tokens.slice(index + 1);
    if (executable === "rm") {
      let options = true;
      if (args.some((arg) => {
        if (!options) return false;
        if (arg === "--") {
          options = false;
          return false;
        }
        return arg === "--recursive" || (/^-[^-]+$/.test(arg) && /[rR]/.test(arg.slice(1)));
      })) matches.add("recursive-delete");
    }
    if (executable === "mkfs" || executable.startsWith("mkfs.")) matches.add("mkfs");
  }
  return matches;
}

function remotePathFromWord(word: ParsedWord, execution: Extract<ExecutionContext, { kind: "ssh" }>): SymbolicPath {
  const resolved = resolveWord(word, execution);
  if (resolved.unresolved || resolved.hasUnquotedGlob || resolved.value === undefined) return { kind: "unknown" };
  let value = resolved.value;
  if (value === "~") return { kind: "home", value: "" };
  if (value.startsWith("~/")) return { kind: "home", value: path.posix.normalize(value.slice(2)) };
  if (value === "<remote-home>") return { kind: "home", value: "" };
  if (value.startsWith("<remote-home>/")) return { kind: "home", value: path.posix.normalize(value.slice(14)) };
  if (value === "<remote-tmp>") return { kind: "temp", value: "" };
  if (value.startsWith("<remote-tmp>/")) return { kind: "temp", value: path.posix.normalize(value.slice(13)) };
  if (value.startsWith("/")) return { kind: "absolute", value: path.posix.normalize(value) };
  if (execution.cwd.kind === "unknown") return { kind: "unknown" };
  return { kind: execution.cwd.kind, value: path.posix.normalize(path.posix.join(execution.cwd.value, value)) } as SymbolicPath;
}

function updateCwd(invocation: CommandInvocation, execution: ExecutionContext): void {
  const executable = invocation.executable.literal ? basename(invocation.executable.literal) : undefined;
  if (executable !== "cd" || invocation.args.length > 1) return;
  const target = invocation.args[0];
  if (execution.kind === "local") {
    if (!target) {
      execution.cwd = execution.home;
      return;
    }
    const resolved = resolveWord(target, execution);
    if (resolved.unresolved || resolved.hasUnquotedGlob || resolved.value === undefined) return;
    const value = resolved.value === "~" ? execution.home : resolved.value.startsWith("~/") ? path.join(execution.home, resolved.value.slice(2)) : resolved.value;
    execution.cwd = path.resolve(execution.cwd, value);
  } else {
    execution.cwd = target ? remotePathFromWord(target, execution) : { kind: "home", value: "" };
  }
}

function shellPayload(args: ParsedWord[], execution: ExecutionContext): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const value = args[index]?.literal;
    if (value === "-c" || (value && /^-[^-]*c/.test(value))) {
      const payload = args[index + 1];
      if (!payload) return undefined;
      const resolved = resolveWord(payload, execution);
      return resolved.unresolved ? undefined : resolved.value;
    }
  }
  return undefined;
}

export interface SshCommand {
  host: string;
  commandWords: ParsedWord[];
}

export function extractSshCommand(args: ParsedWord[]): SshCommand | undefined {
  let index = 0;
  while (index < args.length) {
    const value = args[index]?.literal;
    if (!value) return undefined;
    if (value === "--") {
      index++;
      break;
    }
    if (!value.startsWith("-") || value === "-") break;
    if (/^-[46AaCfGgKkMNnqsTtVvXxYy]+$/.test(value)) {
      index++;
      continue;
    }
    const option = value[1];
    if (option && SSH_OPTIONS_WITH_ARGUMENT.has(option)) {
      index++;
      if (value.length === 2) index++;
      continue;
    }
    index++;
  }
  const destination = args[index]?.literal;
  if (!destination) return undefined;
  return { host: destination.toLowerCase(), commandWords: args.slice(index + 1) };
}

function payloadFromWords(words: ParsedWord[], execution: ExecutionContext): string | undefined {
  const values: string[] = [];
  for (const word of words) {
    const resolved = resolveWord(word, execution);
    if (resolved.unresolved || resolved.value === undefined) return undefined;
    values.push(resolved.value);
  }
  return values.join(" ");
}

function walkWordCommands(node: any, source: string, state: WalkState, build: BuildState, depth: number): void {
  const visit = (part: any, quoted: boolean): void => {
    const type = syntax.NodeType(part);
    if (type === "DblQuoted") {
      for (const nested of Array.from(part.Parts ?? [])) visit(nested, true);
    } else if (type === "CmdSubst" || type === "ProcSubst") {
      walkStatements(part.Stmts, source, {
        ...state,
        execution: cloneExecution(state.execution),
        parentInvocationId: state.parentInvocationId,
        nestedKind: type === "CmdSubst" ? "command-substitution" : "process-substitution",
      }, build, depth);
    } else if (type === "ParamExp" && part.Exp?.Word) {
      for (const nested of Array.from(part.Exp.Word.Parts ?? [])) visit(nested, quoted);
    }
  };
  for (const part of Array.from(node?.Parts ?? [])) visit(part, false);
}

function parseNested(source: string, execution: ExecutionContext, build: BuildState, depth: number, parentInvocationId: number, nestedKind: CommandInvocation["nestedKind"]): void {
  if (depth >= MAX_NESTING) return;
  try {
    const file = syntax.NewParser().Parse(source, "nested.sh");
    walkStatements(file.Stmts, source, { execution: cloneExecution(execution), parentInvocationId, nestedKind }, build, depth + 1);
  } catch {
    build.analysis.parseFailures.push({ source, context: cloneExecution(execution) });
    for (const match of fallbackRules(source)) build.analysis.fallbackMatches.add(match);
  }
}

function heredocBody(stmt: any, source: string): string | undefined {
  for (const entry of Array.from(stmt?.Redirs ?? [])) {
    const redirect = entry as any;
    if (!redirect.Hdoc) continue;
    const body = parsedWord(redirect.Hdoc, source);
    if (body.literal !== undefined) return body.literal;
  }
  return undefined;
}

function walkCall(stmt: any, source: string, state: WalkState, build: BuildState, depth: number): CommandInvocation | undefined {
  const call = stmt.Cmd;
  const astWords = Array.from(call.Args ?? []);
  if (astWords.length === 0) return undefined;
  const words = astWords.map((word) => parsedWord(word, source));
  const normalized = normalizeWrappers(words);
  const invocation: CommandInvocation = {
    id: build.nextInvocationId++,
    executable: normalized.executable,
    originalExecutable: words[0],
    args: normalized.args,
    execution: cloneExecution(state.execution),
    cwd: state.execution.kind === "local" ? state.execution.cwd : cloneSymbolic(state.execution.cwd),
    wrappers: normalized.wrappers,
    pipelineId: state.pipelineId,
    pipelineIndex: state.pipelineIndex,
    parentInvocationId: state.parentInvocationId,
    nestedKind: state.nestedKind,
    raw: sourceSlice(source, stmt),
  };
  build.analysis.invocations.push(invocation);

  const substitutionState = { ...state, parentInvocationId: invocation.id };
  for (const word of astWords) walkWordCommands(word, source, substitutionState, build, depth);
  for (const entry of Array.from(call.Assigns ?? [])) {
    const assignment = entry as any;
    if (assignment.Value) walkWordCommands(assignment.Value, source, substitutionState, build, depth);
    for (const element of Array.from(assignment.Array?.Elems ?? [])) {
      const value = (element as any).Value;
      if (value) walkWordCommands(value, source, substitutionState, build, depth);
    }
  }
  for (const entry of Array.from(stmt.Redirs ?? [])) {
    const redirect = entry as any;
    if (redirect.Word) walkWordCommands(redirect.Word, source, substitutionState, build, depth);
    if (redirect.Hdoc) walkWordCommands(redirect.Hdoc, source, substitutionState, build, depth);
  }

  const executable = invocation.executable.literal ? basename(invocation.executable.literal) : undefined;
  if (executable && SHELLS.has(executable)) {
    const payload = shellPayload(invocation.args, state.execution);
    if (payload !== undefined) parseNested(payload, state.execution, build, depth, invocation.id, "shell-c");
  } else if (executable === "ssh") {
    const ssh = extractSshCommand(invocation.args);
    if (ssh) {
      const remote: ExecutionContext = {
        kind: "ssh",
        host: ssh.host,
        cwd: { kind: "home", value: "" },
        home: { kind: "home", value: "" },
      };
      const payload = payloadFromWords(ssh.commandWords, state.execution);
      if (payload) parseNested(payload, remote, build, depth, invocation.id, "ssh");

      const remoteExecutable = ssh.commandWords[0]?.literal ? basename(ssh.commandWords[0].literal) : undefined;
      if (remoteExecutable && SHELLS.has(remoteExecutable)) {
        const body = heredocBody(stmt, source);
        if (body !== undefined) parseNested(body, remote, build, depth, invocation.id, "ssh-heredoc");
      }
    }
  }

  updateCwd(invocation, state.execution);
  return invocation;
}

function flattenPipeline(stmt: any, output: any[]): void {
  if (syntax.NodeType(stmt?.Cmd) === "BinaryCmd" && (stmt.Cmd.Op === 12 || stmt.Cmd.Op === 13)) {
    flattenPipeline(stmt.Cmd.X, output);
    flattenPipeline(stmt.Cmd.Y, output);
  } else {
    output.push(stmt);
  }
}

function walkStatement(stmt: any, source: string, state: WalkState, build: BuildState, depth: number): void {
  const command = stmt?.Cmd;
  if (!command) return;
  const type = syntax.NodeType(command);
  if (type === "CallExpr") {
    walkCall(stmt, source, state, build, depth);
    return;
  }
  if (type === "BinaryCmd") {
    if (command.Op === 12 || command.Op === 13) {
      const stages: any[] = [];
      flattenPipeline(stmt, stages);
      const pipelineId = build.nextPipelineId++;
      stages.forEach((stage, index) => walkStatement(stage, source, {
        ...state,
        execution: cloneExecution(state.execution),
        pipelineId,
        pipelineIndex: index,
      }, build, depth));
    } else if (command.Op === 10) {
      walkStatement(command.X, source, state, build, depth);
      walkStatement(command.Y, source, state, build, depth);
    } else {
      walkStatement(command.X, source, { ...state, execution: cloneExecution(state.execution) }, build, depth);
      walkStatement(command.Y, source, { ...state, execution: cloneExecution(state.execution) }, build, depth);
    }
    return;
  }
  if (type === "Subshell") {
    walkStatements(command.Stmts, source, { ...state, execution: cloneExecution(state.execution) }, build, depth);
    return;
  }
  if (type === "Block") {
    walkStatements(command.Stmts, source, state, build, depth);
    return;
  }

  const statementLists = ["Stmts", "Then", "Else", "Do", "Body"];
  for (const key of statementLists) {
    if (command[key]) walkStatements(command[key], source, { ...state, execution: cloneExecution(state.execution) }, build, depth);
  }
  for (const key of ["Cond", "Post", "Init"]) {
    if (command[key]?.Cmd) walkStatement(command[key], source, { ...state, execution: cloneExecution(state.execution) }, build, depth);
  }
}

function walkStatements(statements: any[], source: string, state: WalkState, build: BuildState, depth: number): void {
  for (const stmt of Array.from(statements ?? [])) walkStatement(stmt, source, state, build, depth);
}

export function localExecutionContext(cwd: string, env: NodeJS.ProcessEnv = process.env): ExecutionContext {
  const home = env.HOME ? path.resolve(env.HOME) : path.resolve(cwd);
  const tempRoots = ["/tmp", "/private/tmp"];
  if (env.TMPDIR && path.isAbsolute(env.TMPDIR)) tempRoots.push(path.resolve(env.TMPDIR));
  return { kind: "local", cwd: path.resolve(cwd), home, tempRoots, env: { ...env } };
}

export function analyzeCommand(source: string, execution: ExecutionContext): CommandAnalysis {
  const analysis: CommandAnalysis = { source, invocations: [], parseFailures: [], fallbackMatches: new Set() };
  const build: BuildState = { analysis, nextInvocationId: 1, nextPipelineId: 1 };
  try {
    const file = syntax.NewParser().Parse(source, "command.sh");
    walkStatements(file.Stmts, source, { execution: cloneExecution(execution) }, build, 0);
  } catch {
    analysis.parseFailures.push({ source, context: cloneExecution(execution) });
    analysis.fallbackMatches = fallbackRules(source);
  }
  return analysis;
}
