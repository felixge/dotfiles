import path from "node:path";
import { parse } from "unbash";
import type {
  ArithmeticExpression,
  AssignmentPrefix,
  Node as ShellNode,
  ParsedScript,
  Redirect,
  TestExpression,
  Word as ShellWord,
  WordPart as ShellWordPart,
} from "unbash";
import type {
  CommandAnalysis,
  CommandInvocation,
  ExecutionContext,
  ParsedWord,
  ResolvedWord,
  SymbolicPath,
  WordPart,
} from "./types.js";
import { isProtectedRootOperand } from "./paths.js";

const MAX_NESTING = 5;
const MAX_LOOP_VALUES = 32;
const MAX_LOOP_EXPANSIONS = 1024;
const SHELLS = new Set(["sh", "bash", "zsh"]);
const EXECUTORS = new Set(["bash", "sh", "zsh", "python", "node", "ruby", "perl"]);
const DOWNLOADERS = new Set(["curl", "wget"]);
const SSH_OPTIONS_WITH_ARGUMENT = new Set([
  "B", "b", "c", "D", "E", "e", "F", "I", "i", "J", "L", "l", "m", "O", "o", "p", "Q", "R", "S", "W", "w",
]);

type ShellCommand = Extract<ShellNode, { type: "Command" }>;

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
  loopExpansions: number;
}

interface NormalizedInvocation {
  executable: ParsedWord;
  args: ParsedWord[];
  wrappers: string[];
  execution: ExecutionContext;
  envSplitString?: string;
  uncertain?: string;
}

const EMPTY_WORD: ParsedWord = { raw: "", parts: [], dynamic: true, hasUnquotedGlob: false };

function basename(value: string): string {
  return path.posix.basename(value);
}

function cloneSymbolic(value: SymbolicPath): SymbolicPath {
  return { ...value };
}

function cloneExecution(execution: ExecutionContext): ExecutionContext {
  if (execution.kind === "local") {
    return {
      ...execution,
      tempRoots: [...execution.tempRoots],
      env: { ...execution.env },
      pathValues: { ...execution.pathValues },
    };
  }
  return {
    ...execution,
    cwd: cloneSymbolic(execution.cwd),
    home: cloneSymbolic(execution.home),
    env: execution.env ? { ...execution.env } : undefined,
    pathValues: { ...execution.pathValues },
  };
}

function clearEnvironment(execution: ExecutionContext): ExecutionContext {
  return { ...execution, env: {}, pathValues: {} };
}

function unsetEnvironmentVariable(execution: ExecutionContext, name: string): ExecutionContext {
  const env = { ...(execution.env ?? {}) };
  const pathValues = { ...execution.pathValues };
  delete env[name];
  delete pathValues[name];
  return { ...execution, env, pathValues };
}

function setEnvironmentVariable(execution: ExecutionContext, name: string, value: string | undefined): ExecutionContext {
  const pathValues = { ...execution.pathValues };
  delete pathValues[name];
  return { ...execution, env: { ...(execution.env ?? {}), [name]: value }, pathValues };
}

function sourceSlice(source: string, node: { pos: number; end: number }): string {
  if (!Number.isInteger(node.pos) || !Number.isInteger(node.end) || node.pos < 0 || node.end < node.pos) return "";
  return source.slice(node.pos, node.end);
}

function containsUnquotedGlob(raw: string): boolean {
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (char === "\\") {
      index++;
      continue;
    }
    if (char === "*" || char === "?") return true;
    if (char !== "[") continue;

    for (let end = index + 1; end < raw.length; end++) {
      if (raw[end] === "\\") {
        end++;
        continue;
      }
      if (raw[end] === "]") return true;
    }
  }
  return false;
}

function simpleParameterName(text: string): string | undefined {
  return /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(text)?.[1];
}

function parseParts(nodes: readonly ShellWordPart[], quoted = false): { parts: WordPart[]; literal?: string; glob: boolean } {
  const parts: WordPart[] = [];
  let literal = "";
  let allLiteral = true;
  let glob = false;

  for (const node of nodes) {
    if (node.type === "Literal") {
      parts.push({ kind: "literal", value: node.value, quoted });
      literal += node.value;
      if (!quoted && containsUnquotedGlob(node.text)) glob = true;
    } else if (node.type === "SingleQuoted" || node.type === "AnsiCQuoted") {
      parts.push({ kind: "literal", value: node.value, quoted: true });
      literal += node.value;
    } else if (node.type === "DoubleQuoted" || node.type === "LocaleString") {
      const nested = parseParts(node.parts, true);
      parts.push(...nested.parts);
      glob ||= nested.glob;
      if (nested.literal === undefined) allLiteral = false;
      else literal += nested.literal;
    } else if (node.type === "SimpleExpansion") {
      parts.push({ kind: "parameter", name: simpleParameterName(node.text), quoted });
      allLiteral = false;
    } else if (node.type === "ParameterExpansion") {
      const simple = !node.indirect && !node.length && node.index === undefined && node.operator === undefined
        && node.slice === undefined && node.replace === undefined;
      parts.push({ kind: "parameter", name: simple ? node.parameter : undefined, quoted });
      allLiteral = false;
    } else if (node.type === "CommandExpansion" || node.type === "ProcessSubstitution") {
      parts.push({ kind: "command-substitution", quoted });
      allLiteral = false;
    } else if (node.type === "ArithmeticExpansion") {
      parts.push({ kind: "arithmetic", quoted });
      allLiteral = false;
    } else {
      parts.push({ kind: "other", quoted });
      allLiteral = false;
      if (!quoted && containsUnquotedGlob(node.text)) glob = true;
    }
  }

  return { parts, literal: allLiteral ? literal : undefined, glob };
}

export function parsedWord(node: ShellWord, _source?: string): ParsedWord {
  const astParts = node.parts;
  if (!astParts) {
    const glob = containsUnquotedGlob(node.text);
    return {
      raw: node.text,
      literal: node.value,
      parts: [{ kind: "literal", value: node.value, quoted: false }],
      dynamic: glob,
      hasUnquotedGlob: glob,
    };
  }

  const parsed = parseParts(astParts);
  return {
    raw: node.text,
    literal: parsed.literal,
    parts: parsed.parts,
    dynamic: parsed.literal === undefined || parsed.glob,
    hasUnquotedGlob: parsed.glob,
  };
}

function parameterValue(name: string, execution: ExecutionContext): string | undefined {
  if (execution.kind === "local") return name === "PWD" ? execution.cwd : execution.env[name];
  const present = execution.env && Object.hasOwn(execution.env, name);
  const value = execution.env?.[name];
  if (value !== undefined || present) return value;
  if (name === "HOME") return "<remote-home>";
  if (name === "TMPDIR") return "<remote-tmp>";
  return undefined;
}

export function resolveWord(word: ParsedWord, execution: ExecutionContext): ResolvedWord {
  let value = "";
  let hasUnquotedGlob = word.hasUnquotedGlob;
  let hasUnquotedFieldSplitting = false;
  for (const part of word.parts) {
    if (part.kind === "literal") {
      value += part.value;
      continue;
    }
    if (part.kind !== "parameter" || !part.name) {
      return { unresolved: true, hasUnquotedGlob, hasUnquotedFieldSplitting };
    }

    const resolved = parameterValue(part.name, execution);
    if (resolved === undefined) return { unresolved: true, hasUnquotedGlob, hasUnquotedFieldSplitting };
    value += resolved;
    if (!part.quoted) {
      if (containsUnquotedGlob(resolved)) hasUnquotedGlob = true;
      if (/\s/.test(resolved) || resolved === "") hasUnquotedFieldSplitting = true;
    }
  }
  return { value, unresolved: false, hasUnquotedGlob, hasUnquotedFieldSplitting };
}

function concreteWord(word: ParsedWord, execution: ExecutionContext): ParsedWord {
  const resolved = resolveWord(word, execution);
  if (resolved.unresolved || resolved.hasUnquotedGlob || resolved.hasUnquotedFieldSplitting || resolved.value === undefined) return word;
  return { ...word, literal: resolved.value, dynamic: false, hasUnquotedGlob: false };
}

/**
 * Resolve path-shaped words without pretending their dynamic components are
 * concrete scalar values. The bounded case covers trusted path facts, such as
 * mktemp results, propagated through quoted variables.
 */
export function resolvePathWord(word: ParsedWord, execution: ExecutionContext): ResolvedWord {
  const concrete = resolveWord(word, execution);
  if (!concrete.unresolved) return concrete;

  let value = "";
  let bounded = true;
  let rawDynamic = false;
  for (const part of word.parts) {
    if (part.kind === "literal") {
      value += part.value;
      continue;
    }
    if (part.kind === "parameter" && part.name) {
      const resolved = parameterValue(part.name, execution);
      if (resolved !== undefined) {
        if (!part.quoted && (/\s/.test(resolved) || resolved === "" || containsUnquotedGlob(resolved))) bounded = false;
        value += resolved;
        continue;
      }
      const fact = execution.pathValues[part.name];
      if (fact !== undefined) {
        value += fact;
        bounded &&= part.quoted;
        continue;
      }
    }
    value += "<dynamic>";
    rawDynamic = true;
    if (!part.quoted) bounded = false;
  }

  if (word.hasUnquotedGlob || rawDynamic) bounded = false;
  return {
    value,
    unresolved: !bounded,
    hasUnquotedGlob: word.hasUnquotedGlob,
    hasUnquotedFieldSplitting: !bounded,
  };
}

function unknownCwd(execution: ExecutionContext): ExecutionContext {
  if (execution.kind === "local") return { ...execution, cwd: undefined };
  return { ...execution, cwd: { kind: "unknown" } };
}

function attachedWord(word: ParsedWord, prefix: string): ParsedWord {
  let remaining = prefix.length;
  const parts: WordPart[] = [];
  for (const part of word.parts) {
    if (remaining > 0) {
      if (part.kind !== "literal") return { ...word, raw: word.raw.slice(prefix.length), literal: undefined, dynamic: true };
      if (part.value.length <= remaining) {
        remaining -= part.value.length;
        continue;
      }
      parts.push({ ...part, value: part.value.slice(remaining) });
      remaining = 0;
    } else {
      parts.push(part);
    }
  }
  const literal = remaining === 0 && parts.every((part) => part.kind === "literal")
    ? parts.map((part) => part.value).join("")
    : undefined;
  return {
    raw: word.raw.slice(prefix.length),
    literal,
    parts,
    dynamic: literal === undefined || word.hasUnquotedGlob,
    hasUnquotedGlob: word.hasUnquotedGlob,
  };
}

function wordStartsWith(word: ParsedWord, prefix: string): boolean {
  return word.literal?.startsWith(prefix) === true || word.raw.startsWith(prefix);
}

function assignmentName(word: ParsedWord): string | undefined {
  let prefix = "";
  for (const part of word.parts) {
    if (part.kind !== "literal") break;
    prefix += part.value;
  }
  return /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(prefix || word.literal || word.raw)?.[1];
}

function singleCommandExpansion(word: ShellWord): ShellCommand | undefined {
  let parts = word.parts ?? [];
  while (parts.length === 1 && (parts[0]?.type === "DoubleQuoted" || parts[0]?.type === "LocaleString")) {
    parts = parts[0].parts;
  }
  const expansion = parts.length === 1 && parts[0]?.type === "CommandExpansion" ? parts[0] : undefined;
  const statement = expansion?.script?.commands.length === 1 ? expansion.script.commands[0] : undefined;
  if (statement?.type !== "Statement" || statement.background || statement.redirects.length > 0) return undefined;
  return statement.command.type === "Command" ? statement.command : undefined;
}

function defaultTempRoot(execution: ExecutionContext): string {
  if (execution.kind === "ssh") return "<remote-tmp>";
  const tmpdir = execution.env.TMPDIR;
  return tmpdir && path.isAbsolute(tmpdir) ? path.resolve(tmpdir) : "/tmp";
}

function mktempPathFact(word: ShellWord, execution: ExecutionContext): string | undefined {
  const command = singleCommandExpansion(word);
  if (!command?.name || command.prefix.length > 0 || command.redirects.length > 0) return undefined;
  const executable = concreteWord(parsedWord(command.name), execution).literal;
  if (!executable || basename(executable) !== "mktemp") return undefined;

  const args = command.suffix.map((arg) => concreteWord(parsedWord(arg), execution).literal);
  if (args.some((arg) => arg === undefined)) return undefined;
  let directory = defaultTempRoot(execution);
  let explicitDirectory = false;
  let template: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (["-d", "--directory", "-u", "--dry-run", "-q", "--quiet"].includes(arg)) continue;
    if (["-p", "--tmpdir"].includes(arg)) {
      const value = args[++index];
      if (!value) return undefined;
      directory = value;
      explicitDirectory = true;
      continue;
    }
    if (arg.startsWith("--tmpdir=")) {
      directory = arg.slice("--tmpdir=".length) || directory;
      explicitDirectory = true;
      continue;
    }
    if (arg === "-t") {
      const prefix = args[++index];
      if (!prefix) return undefined;
      template = path.posix.join(directory, `${prefix}.XXXXXXXXXX`);
      continue;
    }
    if (["--suffix"].includes(arg)) {
      if (!args[++index]) return undefined;
      continue;
    }
    if (arg.startsWith("--suffix=")) continue;
    if (arg.startsWith("-")) return undefined;
    if (template !== undefined) return undefined;
    template = arg;
  }

  template ??= path.posix.join(directory, "tmp.XXXXXXXXXX");
  if (explicitDirectory && !template.startsWith("/") && !template.startsWith("<remote-")) {
    if (template.includes("/")) return undefined;
    template = path.posix.join(directory, template);
  }
  return template.replace(/X{3,}/g, "<mktemp>");
}

function applyAssignments(
  assignments: readonly AssignmentPrefix[],
  initialExecution: ExecutionContext,
  expansionExecution: ExecutionContext,
): ExecutionContext {
  let execution = cloneExecution(initialExecution);
  for (const assignment of assignments) {
    if (!assignment.name) continue;
    const value = assignment.value ? parsedWord(assignment.value) : EMPTY_WORD;
    const resolved = resolveWord(value, expansionExecution);
    let nextValue = resolved.unresolved || resolved.value === undefined ? undefined : resolved.value;
    let pathValue = assignment.value && nextValue === undefined
      ? mktempPathFact(assignment.value, expansionExecution)
      : undefined;
    if (assignment.append) {
      const previous = execution.env?.[assignment.name];
      nextValue = nextValue === undefined || previous === undefined ? undefined : `${previous}${nextValue}`;
      pathValue = undefined;
    }
    execution = {
      ...execution,
      env: { ...(execution.env ?? {}), [assignment.name]: nextValue },
      pathValues: { ...execution.pathValues, [assignment.name]: pathValue },
    };
  }
  return execution;
}

function resolveWrapperCwd(word: ParsedWord, execution: ExecutionContext, expansionExecution: ExecutionContext = execution): ExecutionContext | undefined {
  const resolved = resolveWord(word, expansionExecution);
  if (resolved.unresolved || resolved.hasUnquotedGlob || resolved.hasUnquotedFieldSplitting || resolved.value === undefined) return undefined;
  if (execution.kind === "local") {
    if (!execution.cwd) return undefined;
    let value = resolved.value;
    if (value === "~") value = execution.home;
    else if (value.startsWith("~/")) value = path.join(execution.home, value.slice(2));
    return { ...execution, cwd: path.resolve(execution.cwd, value) };
  }
  return {
    ...execution,
    cwd: remotePathFromWord(word, execution, expansionExecution),
  };
}

function normalizeWrappers(
  words: ParsedWord[],
  initialExecution: ExecutionContext,
  expansionExecution: ExecutionContext = initialExecution,
): NormalizedInvocation {
  let index = 0;
  let execution = cloneExecution(initialExecution);
  const wrappers: string[] = [];
  let uncertain: string | undefined;
  let envSplitString: string | undefined;

  while (index < words.length) {
    const wrapperLiteral = words[index]?.literal;
    const name = wrapperLiteral ? basename(wrapperLiteral) : undefined;
    if (name === "command") {
      const wrapper = words[index] ?? EMPTY_WORD;
      const wrapperArgs = words.slice(index + 1);
      let queryOnly = false;
      index++;
      while (words[index]?.literal?.startsWith("-") && words[index]?.literal !== "--") {
        queryOnly ||= /[vV]/.test(words[index]?.literal?.slice(1) ?? "");
        index++;
      }
      if (words[index]?.literal === "--") index++;
      if (queryOnly || index >= words.length) {
        return { executable: wrapper, args: wrapperArgs, wrappers, execution: initialExecution, uncertain };
      }
      wrappers.push(name);
      continue;
    }
    if (name === "env") {
      const wrapper = words[index] ?? EMPTY_WORD;
      const wrapperArgs = words.slice(index + 1);
      wrappers.push(name);
      index++;
      while (index < words.length) {
        const word = words[index] ?? EMPTY_WORD;
        const value = word.literal;
        if (value === "--") {
          index++;
          break;
        }
        if (value === "-i" || value === "--ignore-environment") {
          execution = clearEnvironment(execution);
          index++;
          continue;
        }
        if (value === "-C" || value === "--chdir") {
          const directory = words[index + 1];
          const next = directory ? resolveWrapperCwd(directory, execution, expansionExecution) : undefined;
          if (next) execution = next;
          else {
            execution = unknownCwd(execution);
            uncertain ??= "env chdir is dynamic or unresolved";
          }
          index += 2;
          continue;
        }
        if (wordStartsWith(word, "--chdir=")) {
          const directory = attachedWord(word, "--chdir=");
          const next = resolveWrapperCwd(directory, execution, expansionExecution);
          if (next) execution = next;
          else {
            execution = unknownCwd(execution);
            uncertain ??= "env chdir is dynamic or unresolved";
          }
          index++;
          continue;
        }
        if (value === "-u" || value === "--unset") {
          const variable = words[index + 1]?.literal;
          if (variable && /^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
            execution = unsetEnvironmentVariable(execution, variable);
          } else {
            uncertain ??= "env unset variable is dynamic or unresolved";
          }
          index += 2;
          continue;
        }
        if (wordStartsWith(word, "--unset=")) {
          const variable = value?.slice("--unset=".length);
          if (variable && /^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
            execution = unsetEnvironmentVariable(execution, variable);
          } else {
            uncertain ??= "env unset variable is dynamic or unresolved";
          }
          index++;
          continue;
        }
        if (value === "-S" || value === "--split-string") {
          envSplitString = payloadFromWords(words.slice(index + 1), expansionExecution);
          if (envSplitString === undefined) uncertain ??= "env split-string command is dynamic or unresolved";
          index = words.length;
          break;
        }
        if (wordStartsWith(word, "--split-string=")) {
          const split = attachedWord(word, "--split-string=");
          envSplitString = payloadFromWords([split], expansionExecution);
          if (envSplitString === undefined) uncertain ??= "env split-string command is dynamic or unresolved";
          index = words.length;
          break;
        }
        if (wordStartsWith(word, "-C") && word.raw.length > 2) {
          const directory = attachedWord(word, "-C");
          const next = resolveWrapperCwd(directory, execution, expansionExecution);
          if (next) execution = next;
          else {
            execution = unknownCwd(execution);
            uncertain ??= "env chdir is dynamic or unresolved";
          }
          index++;
          continue;
        }
        if (wordStartsWith(word, "-u") && word.raw.length > 2) {
          const variable = (value ?? word.raw).slice(2);
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
            execution = unsetEnvironmentVariable(execution, variable);
          } else {
            uncertain ??= "env unset variable is dynamic or unresolved";
          }
          index++;
          continue;
        }
        if (wordStartsWith(word, "-S") && word.raw.length > 2) {
          const split = attachedWord(word, "-S");
          envSplitString = payloadFromWords([split, ...words.slice(index + 1)], expansionExecution);
          if (envSplitString === undefined) uncertain ??= "env split-string command is dynamic or unresolved";
          index = words.length;
          break;
        }
        const assignment = assignmentName(word);
        if (assignment) {
          const resolved = resolveWord(word, expansionExecution);
          const value = !resolved.unresolved && resolved.value !== undefined
            ? resolved.value.slice(assignment.length + 1)
            : undefined;
          execution = setEnvironmentVariable(execution, assignment, value);
          index++;
          continue;
        }
        if (value?.startsWith("-") || value === undefined) {
          uncertain ??= "env option is dynamic or unsupported";
          index++;
          continue;
        }
        break;
      }
      if (index >= words.length && envSplitString === undefined) {
        wrappers.pop();
        return { executable: wrapper, args: wrapperArgs, wrappers, execution: initialExecution, uncertain };
      }
      continue;
    }
    if (name === "sudo") {
      const wrapper = words[index] ?? EMPTY_WORD;
      const wrapperArgs = words.slice(index + 1);
      wrappers.push(name);
      index++;
      while (index < words.length) {
        const word = words[index] ?? EMPTY_WORD;
        const value = word.literal;
        if (value === "--") {
          index++;
          break;
        }
        if (value === "-D" || value === "--chdir") {
          const directory = words[index + 1];
          const next = directory ? resolveWrapperCwd(directory, execution, expansionExecution) : undefined;
          if (next) execution = next;
          else {
            execution = unknownCwd(execution);
            uncertain ??= "sudo chdir is dynamic or unresolved";
          }
          index += 2;
          continue;
        }
        if (wordStartsWith(word, "--chdir=")) {
          const directory = attachedWord(word, "--chdir=");
          const next = resolveWrapperCwd(directory, execution, expansionExecution);
          if (next) execution = next;
          else {
            execution = unknownCwd(execution);
            uncertain ??= "sudo chdir is dynamic or unresolved";
          }
          index++;
          continue;
        }
        if (wordStartsWith(word, "-D") && word.raw.length > 2) {
          const directory = attachedWord(word, "-D");
          const next = resolveWrapperCwd(directory, execution, expansionExecution);
          if (next) execution = next;
          else {
            execution = unknownCwd(execution);
            uncertain ??= "sudo chdir is dynamic or unresolved";
          }
          index++;
          continue;
        }
        if (!value?.startsWith("-")) break;
        index++;
        if (["-C", "-g", "-h", "-p", "-R", "-r", "-t", "-T", "-u"].includes(value)) index++;
      }
      if (index >= words.length) {
        wrappers.pop();
        return { executable: wrapper, args: wrapperArgs, wrappers, execution: initialExecution, uncertain };
      }
      continue;
    }
    break;
  }

  if (envSplitString !== undefined || uncertain?.startsWith("env split-string")) {
    return { executable: EMPTY_WORD, args: [], wrappers, execution, envSplitString, uncertain };
  }
  return {
    executable: words[index] ?? EMPTY_WORD,
    args: words.slice(index + 1),
    wrappers,
    execution,
    uncertain,
  };
}

function stripShellComments(source: string): string {
  let output = "";
  let quote: "single" | "double" | undefined;
  let tokenStart = true;

  for (let index = 0; index < source.length; index++) {
    const char = source[index] ?? "";
    if (quote === "single") {
      output += char;
      if (char === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      output += char;
      if (char === "\\" && index + 1 < source.length) output += source[++index];
      else if (char === "\"") quote = undefined;
      continue;
    }
    if (char === "\\") {
      output += char;
      if (index + 1 < source.length) output += source[++index];
      tokenStart = false;
      continue;
    }
    if (char === "'") {
      output += char;
      quote = "single";
      tokenStart = false;
      continue;
    }
    if (char === "\"") {
      output += char;
      quote = "double";
      tokenStart = false;
      continue;
    }
    if (char === "#" && tokenStart) {
      while (index < source.length && source[index] !== "\n") {
        output += " ";
        index++;
      }
      if (index < source.length) output += "\n";
      tokenStart = true;
      continue;
    }

    output += char;
    if (/\s/.test(char) || /[;&|()]/.test(char)) tokenStart = true;
    else tokenStart = false;
  }

  return output;
}

interface FallbackSegment {
  source: string;
  piped: boolean;
}

function fallbackSegments(source: string): FallbackSegment[] {
  const segments: FallbackSegment[] = [];
  let start = 0;
  let quote: "single" | "double" | undefined;
  let piped = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "single") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      if (char === "\\") escaped = true;
      else if (char === '"') quote = undefined;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char === "'" ? "single" : "double";
      continue;
    }
    if (char === "|" || char === ";" || char === "\n" || char === "&") {
      const value = source.slice(start, index).trim();
      if (value) segments.push({ source: value, piped });
      piped = char === "|" && source[index + 1] !== "|";
      if (char === "|" && source[index + 1] === "|") index++;
      if (char === "&" && source[index + 1] === "&") index++;
      start = index + 1;
    }
  }
  const value = source.slice(start).trim();
  if (value) segments.push({ source: value, piped });
  return segments;
}

function fallbackTokens(source: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "single" | "double" | undefined;
  let escaped = false;
  const finish = (): void => {
    if (token) tokens.push(token);
    token = "";
  };
  for (const char of source) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (quote === "single") {
      token += char;
      if (char === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      token += char;
      if (char === "\\") escaped = true;
      else if (char === '"') quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      token += char;
      quote = char === "'" ? "single" : "double";
    } else if (/\s/.test(char)) {
      finish();
    } else {
      token += char;
    }
  }
  finish();
  return tokens;
}

function fallbackTokenValue(token: string): string {
  if ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"'))) {
    return token.slice(1, -1);
  }
  if (token.startsWith("'") || token.startsWith('"')) return token.slice(1);
  return token;
}

type FallbackInspect = (source: string, depth?: number) => void;

function inspectFallbackPayload(source: string, inspect: FallbackInspect, depth: number): void {
  const segments = fallbackSegments(stripShellComments(source));
  if (segments.length <= 1) {
    inspect(source, depth);
    return;
  }
  for (const segment of segments) inspect(segment.source, depth);
}

function fallbackConsumeSudo(tokens: string[], start: number): number {
  let index = start;
  while (index < tokens.length) {
    const value = fallbackTokenValue(tokens[index] ?? "");
    if (value === "--") return index + 1;
    if (value === "-D" || value === "--chdir" || value === "-C") {
      index += 2;
      continue;
    }
    if (value === "--chdir=" || value.startsWith("--chdir=") || (value.startsWith("-D") && value.length > 2)) {
      index++;
      continue;
    }
    if (!value.startsWith("-")) return index;
    index++;
    if (["-g", "-h", "-p", "-R", "-r", "-t", "-T", "-u"].includes(value)) index++;
  }
  return index;
}

function fallbackConsumeEnv(tokens: string[], start: number, inspect: FallbackInspect, depth: number): number {
  let index = start;
  while (index < tokens.length) {
    const value = fallbackTokenValue(tokens[index] ?? "");
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
      index++;
      continue;
    }
    if (value === "--") return index + 1;
    if (value === "-S" || value === "--split-string") {
      inspectFallbackPayload(tokens.slice(index + 1).map(fallbackTokenValue).join(" "), inspect, depth + 1);
      return tokens.length;
    }
    if (value.startsWith("--split-string=")) {
      inspectFallbackPayload(fallbackTokenValue(value.slice("--split-string=".length)), inspect, depth + 1);
      return tokens.length;
    }
    if (value.startsWith("-S") && value.length > 2) {
      inspectFallbackPayload(fallbackTokenValue(value.slice(2)), inspect, depth + 1);
      return tokens.length;
    }
    if (value === "-C" || value === "--chdir" || value === "-u" || value === "--unset") {
      index += 2;
      continue;
    }
    if (value.startsWith("--chdir=") || value.startsWith("--unset=") || (value.startsWith("-C") && value.length > 2) || (value.startsWith("-u") && value.length > 2)) {
      index++;
      continue;
    }
    if (value === "-i" || value === "--ignore-environment") {
      index++;
      continue;
    }
    if (value.startsWith("-")) {
      index++;
      continue;
    }
    return index;
  }
  return index;
}

interface FallbackAnalysis {
  matches: Set<string>;
  recursionLimitReached: boolean;
}

export function sendsSigkill(args: readonly string[]): boolean {
  const signalIsKill = (value: string | undefined): boolean => {
    const normalized = value?.toUpperCase();
    return normalized === "9" || normalized === "KILL" || normalized === "SIGKILL";
  };

  for (let index = 0; index < args.length; index++) {
    const value = args[index] ?? "";
    if (value === "--") return false;
    if (value === "-9" || value.toUpperCase() === "-KILL" || value.toUpperCase() === "-SIGKILL") return true;
    if ((value === "-s" || value === "--signal" || value === "-n") && signalIsKill(args[index + 1])) return true;
    if ((value.startsWith("-s") || value.startsWith("-n")) && value.length > 2 && signalIsKill(value.slice(2))) return true;
    if (value.startsWith("--signal=") && signalIsKill(value.slice("--signal=".length))) return true;
  }
  return false;
}

function fallbackRules(source: string): FallbackAnalysis {
  const matches = new Set<string>();
  const segments = fallbackSegments(stripShellComments(source));
  const pipeline: string[] = [];
  let sawMkfifo = false;
  let sawNetcat = false;
  let recursionLimitReached = false;

  const inspect = (commandSource: string, depth = 0): void => {
    if (depth > MAX_NESTING) {
      recursionLimitReached = true;
      return;
    }
    const tokens = fallbackTokens(commandSource);
    let index = 0;
    while (fallbackTokenValue(tokens[index] ?? "") === "command") {
      index++;
      while (tokens[index] && fallbackTokenValue(tokens[index] ?? "").startsWith("-")) index++;
    }
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(fallbackTokenValue(tokens[index] ?? ""))) index++;

    const command = fallbackTokenValue(tokens[index] ?? "");
    if (command === "sudo") {
      matches.add("sudo");
      const commandIndex = fallbackConsumeSudo(tokens, index + 1);
      if (commandIndex < tokens.length) inspect(tokens.slice(commandIndex).map(fallbackTokenValue).join(" "), depth + 1);
      return;
    }
    if (command === "env") {
      const commandIndex = fallbackConsumeEnv(tokens, index + 1, inspect, depth);
      if (commandIndex < tokens.length) inspect(tokens.slice(commandIndex).map(fallbackTokenValue).join(" "), depth + 1);
      return;
    }
    if (index >= tokens.length) return;

    const executable = basename(command);
    const args = tokens.slice(index + 1).map(fallbackTokenValue);
    if (["bash", "sh", "zsh"].includes(executable)) {
      if (args.some((arg) => arg.startsWith("<(") && DOWNLOADERS.has(fallbackTokenValue(arg.slice(2)).split(/\s+/)[0] ?? ""))) matches.add("curl-pipe-exec");
      const option = args.findIndex((arg) => arg === "-c" || /^-[^-]*c/.test(arg));
      if (option >= 0 && args[option + 1]) inspectFallbackPayload(args[option + 1] ?? "", inspect, depth + 1);
    } else if (executable === "ssh") {
      const sshIndex = sshDestinationIndex(args);
      if (sshIndex !== undefined && args.length > sshIndex + 1) inspectFallbackPayload(args.slice(sshIndex + 1).join(" "), inspect, depth + 1);
    }
    if (executable === "rm") {
      let options = true;
      let recursive = false;
      for (const arg of args) {
        if (options && arg === "--") {
          options = false;
          continue;
        }
        if (options && arg.startsWith("-") && arg !== "-") {
          if (arg === "--recursive" || (/^-[^-]+$/.test(arg) && /[rR]/.test(arg.slice(1)))) recursive = true;
        }
      }
      if (recursive) matches.add("recursive-delete");
      if (args.some((arg) => /^\/(?:bin|boot|dev|etc|lib|lib32|lib64|opt|root|sbin|srv|sys|usr|var)(?:\/|$)/.test(arg) || arg === "/")) {
        matches.add("root-path-write");
      }
      if (args.some((arg) => arg.startsWith("~/.") || /^\/(?:Users|home)\/[^/]+\/\./.test(arg))) matches.add("home-dotfile-delete");
    }
    if (["mv", "cp", "chmod", "chown", "ln", "tee", "dd"].includes(executable)) {
      if (args.some((arg) => /^\/(?:bin|boot|dev|etc|lib|lib32|lib64|opt|root|sbin|srv|sys|usr|var)(?:\/|$)/.test(arg) || arg === "/")) matches.add("root-path-write");
    }
    if (executable === "chmod" && args.some((arg) => arg === "777" || arg === "666")) matches.add("world-writable");
    if (executable === "git" && args[0] === "push" && (args.includes("--force") || args.slice(1).some((arg) => /^-[^-]+$/.test(arg) && arg.includes("f")))) matches.add("git-force-push");
    if (executable === "git" && args[0] === "reset" && args.includes("--hard")) matches.add("git-hard-reset");
    if (executable === "git" && args[0] === "clean" && (args.includes("--force") || args.slice(1).some((arg) => /^-[^-]+$/.test(arg) && arg.includes("f")))) matches.add("git-clean-force");
    if (executable === "killall" || (executable === "kill" && sendsSigkill(args))) matches.add("kill-signal");
    if (executable === "dd" && args.some((arg) => arg.startsWith("of="))) matches.add("dd-command");
    if (executable === "mkfs" || executable.startsWith("mkfs.")) matches.add("mkfs");
    if (executable === "npm" && ["install", "i", "uninstall", "remove"].includes(args[0] ?? "") && (args.includes("--global") || args.slice(1).some((arg) => /^-[^-]+$/.test(arg) && arg.includes("g")))) matches.add("global-npm-install");
    if (executable === "brew" && ["uninstall", "remove"].includes(args[0] ?? "")) matches.add("brew-uninstall");
    if (executable === "docker" && args[0] === "system" && args[1] === "prune") matches.add("docker-system-prune");
    if (["nc", "ncat", "netcat"].includes(executable) && args.some((arg) => /^-[^-]+$/.test(arg) && arg.includes("e"))) matches.add("reverse-shell");
    if (args.some((arg) => /\/dev\/(?:tcp|udp)\//.test(arg))) matches.add("reverse-shell");
    if (executable === "mkfifo") {
      sawMkfifo = true;
      pipeline.push("mkfifo");
    }
    if (["nc", "ncat"].includes(executable)) {
      sawNetcat = true;
      pipeline.push("nc");
    }
    pipeline.push(executable);
  };

  for (const segment of segments) {
    if (!segment.piped) pipeline.length = 0;
    inspect(segment.source);
    if (segment.piped && pipeline.length > 0 && pipeline.some((executable) => DOWNLOADERS.has(executable)) && pipeline.some((executable) => EXECUTORS.has(executable))) {
      matches.add("curl-pipe-exec");
    }
  }
  if (sawMkfifo && sawNetcat) matches.add("reverse-shell");
  return { matches, recursionLimitReached };
}

function remotePathFromWord(
  word: ParsedWord,
  execution: Extract<ExecutionContext, { kind: "ssh" }>,
  expansionExecution: ExecutionContext = execution,
): SymbolicPath {
  const resolved = resolvePathWord(word, expansionExecution);
  if (resolved.unresolved || resolved.hasUnquotedGlob || resolved.hasUnquotedFieldSplitting || resolved.value === undefined) return { kind: "unknown" };
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

function updateCwd(
  invocation: CommandInvocation,
  execution: ExecutionContext,
  expansionExecution: ExecutionContext,
  build: BuildState,
): void {
  const executable = invocation.executable.literal ? basename(invocation.executable.literal) : undefined;
  if (executable !== "cd") return;

  let target: ParsedWord | undefined;
  let ambiguous = false;
  let sawDashDash = false;
  for (const arg of invocation.args) {
    const value = arg.literal;
    if (!sawDashDash && value === "--") {
      sawDashDash = true;
      continue;
    }
    if (!sawDashDash && value !== undefined && value !== "-" && value.startsWith("-")) {
      // Options such as -L/-P/-e/-@ change symlink-resolution semantics we do not model; fail closed.
      ambiguous = true;
      continue;
    }
    if (target !== undefined) {
      ambiguous = true;
      continue;
    }
    target = arg;
  }

  if (ambiguous || target?.literal === "-") {
    if (execution.kind === "local") execution.cwd = undefined;
    else execution.cwd = { kind: "unknown" };
    markUncertain(build, "cd option or target is ambiguous or unsupported", invocation.raw, execution);
    return;
  }

  if (execution.kind === "local") {
    if (!target) {
      execution.cwd = execution.home;
      return;
    }
    const resolved = resolvePathWord(target, expansionExecution);
    if (resolved.unresolved || resolved.hasUnquotedGlob || resolved.hasUnquotedFieldSplitting || resolved.value === undefined || !execution.cwd) {
      execution.cwd = undefined;
      markUncertain(build, "cd directory is dynamic or unresolved", invocation.raw, execution);
      return;
    }
    const value = resolved.value === "~" ? execution.home : resolved.value.startsWith("~/") ? path.join(execution.home, resolved.value.slice(2)) : resolved.value;
    execution.cwd = path.resolve(execution.cwd, value);
  } else {
    const next = target ? remotePathFromWord(target, execution, expansionExecution) : { kind: "home", value: "" } as const;
    execution.cwd = next;
    if (next.kind === "unknown") markUncertain(build, "cd directory is dynamic or unresolved", invocation.raw, execution);
  }
}

function shellPayload(args: ParsedWord[], execution: ExecutionContext): { found: boolean; value?: string } {
  for (let index = 0; index < args.length; index++) {
    const value = args[index]?.literal;
    if (value === "-c" || (value && /^-[^-]*c/.test(value))) {
      const payload = args[index + 1];
      if (!payload) return { found: true };
      const resolved = resolveWord(payload, execution);
      return {
        found: true,
        value: resolved.unresolved || resolved.hasUnquotedGlob || resolved.hasUnquotedFieldSplitting ? undefined : resolved.value,
      };
    }
  }
  return { found: false };
}

export interface SshCommand {
  /** Lowercased literal destination, or undefined if the destination word is dynamic/unresolved. */
  host: string | undefined;
  commandWords: ParsedWord[];
}

function sshDestinationIndex(values: readonly (string | undefined)[]): number | undefined {
  let index = 0;
  while (index < values.length) {
    const value = values[index];
    // A dynamic token here could be an option or the destination; treat it as the
    // (unresolved) destination so callers still analyze the remaining command words
    // instead of silently skipping analysis entirely.
    if (value === undefined) return index;
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
      if (value.length === 2) {
        if (index >= values.length || values[index] === undefined) return undefined;
        index++;
      }
      continue;
    }
    index++;
  }
  return index < values.length ? index : undefined;
}

export function extractSshCommand(args: ParsedWord[]): SshCommand | undefined {
  const index = sshDestinationIndex(args.map((arg) => arg.literal));
  if (index === undefined) return undefined;
  const destination = args[index];
  if (!destination) return undefined;
  return { host: destination.literal?.toLowerCase(), commandWords: args.slice(index + 1) };
}

function payloadFromWords(words: ParsedWord[], execution: ExecutionContext): string | undefined {
  const values: string[] = [];
  for (const word of words) {
    const resolved = resolveWord(word, execution);
    if (resolved.unresolved || resolved.hasUnquotedGlob || resolved.hasUnquotedFieldSplitting || resolved.value === undefined) return undefined;
    values.push(resolved.value);
  }
  return values.join(" ");
}

function visitArithmetic(expression: ArithmeticExpression | undefined, visitParts: (parts: readonly ShellWordPart[] | undefined) => void, visitScript: (script: ParsedScript | undefined) => void): void {
  if (!expression) return;
  if (expression.type === "ArithmeticBinary") {
    visitArithmetic(expression.left, visitParts, visitScript);
    visitArithmetic(expression.right, visitParts, visitScript);
  } else if (expression.type === "ArithmeticUnary") {
    visitArithmetic(expression.operand, visitParts, visitScript);
  } else if (expression.type === "ArithmeticTernary") {
    visitArithmetic(expression.test, visitParts, visitScript);
    visitArithmetic(expression.consequent, visitParts, visitScript);
    visitArithmetic(expression.alternate, visitParts, visitScript);
  } else if (expression.type === "ArithmeticGroup") {
    visitArithmetic(expression.expression, visitParts, visitScript);
  } else if (expression.type === "ArithmeticWord") {
    visitParts(expression.parts);
  } else {
    visitScript(expression.script);
  }
}

function visitTestWords(expression: TestExpression | undefined, visitWord: (word: ShellWord | undefined) => void): void {
  if (!expression) return;
  if (expression.type === "TestUnary") {
    visitWord(expression.operand);
  } else if (expression.type === "TestBinary") {
    visitWord(expression.left);
    visitWord(expression.right);
  } else if (expression.type === "TestLogical") {
    visitTestWords(expression.left, visitWord);
    visitTestWords(expression.right, visitWord);
  } else if (expression.type === "TestNot") {
    visitTestWords(expression.operand, visitWord);
  } else {
    visitTestWords(expression.expression, visitWord);
  }
}

function isCompleteScript(root: ParsedScript): boolean {
  const visited = new Set<ParsedScript>();
  let complete = true;

  const visitScript = (script: ParsedScript | undefined): void => {
    if (!script) {
      complete = false;
      return;
    }
    if (visited.has(script)) return;
    visited.add(script);
    if ((script.errors?.length ?? 0) > 0) complete = false;
    for (const statement of script.commands) visitNode(statement);
  };

  const visitParts = (parts: readonly ShellWordPart[] | undefined): void => {
    for (const part of parts ?? []) {
      if (part.type === "DoubleQuoted" || part.type === "LocaleString" || part.type === "ExtendedGlob" || part.type === "BraceExpansion") {
        visitParts(part.parts);
      } else if (part.type === "CommandExpansion" || part.type === "ProcessSubstitution") {
        visitScript(part.script);
      } else if (part.type === "ParameterExpansion") {
        visitParts(part.indexParts);
        visitWord(part.operand);
        visitWord(part.slice?.offset);
        visitWord(part.slice?.length);
        visitWord(part.replace?.pattern);
        visitWord(part.replace?.replacement);
      } else if (part.type === "ArithmeticExpansion") {
        visitArithmetic(part.expression, visitParts, visitScript);
      }
    }
  };

  const visitWord = (word: ShellWord | undefined): void => {
    if (word) visitParts(word.parts);
  };

  const visitRedirects = (redirects: readonly Redirect[]): void => {
    for (const redirect of redirects) {
      visitWord(redirect.target);
      visitWord(redirect.body);
    }
  };

  const visitNode = (node: ShellNode): void => {
    if (node.type === "Statement") {
      visitNode(node.command);
      visitRedirects(node.redirects);
    } else if (node.type === "Command") {
      visitWord(node.name);
      for (const assignment of node.prefix) {
        visitParts(assignment.indexParts);
        visitWord(assignment.value);
        for (const word of assignment.array ?? []) visitWord(word);
      }
      for (const word of node.suffix) visitWord(word);
      visitRedirects(node.redirects);
    } else if (node.type === "Pipeline" || node.type === "AndOr") {
      for (const child of node.commands) visitNode(child);
    } else if (node.type === "If") {
      visitNode(node.clause);
      visitNode(node.then);
      if (node.else) visitNode(node.else);
    } else if (node.type === "For" || node.type === "Select") {
      visitWord(node.name);
      for (const word of node.wordlist) visitWord(word);
      visitNode(node.body);
    } else if (node.type === "ArithmeticFor") {
      visitArithmetic(node.initialize, visitParts, visitScript);
      visitArithmetic(node.test, visitParts, visitScript);
      visitArithmetic(node.update, visitParts, visitScript);
      visitNode(node.body);
    } else if (node.type === "While") {
      visitNode(node.clause);
      visitNode(node.body);
    } else if (node.type === "Function") {
      visitWord(node.name);
      visitNode(node.body);
      visitRedirects(node.redirects);
    } else if (node.type === "Subshell" || node.type === "BraceGroup") {
      visitNode(node.body);
    } else if (node.type === "CompoundList") {
      for (const statement of node.commands) visitNode(statement);
    } else if (node.type === "Case") {
      visitWord(node.word);
      for (const item of node.items) {
        for (const word of item.pattern) visitWord(word);
        visitNode(item.body);
      }
    } else if (node.type === "Coproc") {
      visitWord(node.name);
      visitNode(node.body);
      visitRedirects(node.redirects);
    } else if (node.type === "TestCommand") {
      visitTestWords(node.expression, visitWord);
    } else if (node.type === "ArithmeticCommand") {
      visitArithmetic(node.expression, visitParts, visitScript);
    }
  };

  try {
    visitScript(root);
  } catch {
    return false;
  }
  return complete;
}

function parseComplete(source: string): ParsedScript | undefined {
  try {
    const script = parse(source);
    return isCompleteScript(script) ? script : undefined;
  } catch {
    return undefined;
  }
}

function scriptSource(script: ParsedScript, source: string): string {
  return script.source ?? source;
}

function markUncertain(build: BuildState, reason: string, source: string, execution: ExecutionContext): void {
  build.analysis.uncertainties.push(reason);
  build.analysis.parseFailures.push({ source, context: cloneExecution(execution) });
}

function parseNested(source: string, execution: ExecutionContext, build: BuildState, depth: number, parentInvocationId: number, nestedKind: CommandInvocation["nestedKind"]): void {
  if (depth >= MAX_NESTING) {
    markUncertain(build, "nested command recursion limit reached", source, execution);
    return;
  }
  const script = parseComplete(source);
  if (!script) {
    build.analysis.parseFailures.push({ source, context: cloneExecution(execution) });
    const fallback = fallbackRules(source);
    for (const match of fallback.matches) build.analysis.fallbackMatches.add(match);
    if (fallback.recursionLimitReached) build.analysis.uncertainties.push("fallback recursion limit reached");
    return;
  }
  walkStatements(script.commands, scriptSource(script, source), {
    execution: cloneExecution(execution),
    parentInvocationId,
    nestedKind,
  }, build, depth + 1);
}

function walkArithmeticCommands(expression: ArithmeticExpression | undefined, source: string, state: WalkState, build: BuildState, depth: number): void {
  visitArithmetic(
    expression,
    (parts) => walkPartsCommands(parts, source, state, build, depth),
    (script) => {
      if (!script) return;
      walkStatements(script.commands, scriptSource(script, source), {
        ...state,
        execution: cloneExecution(state.execution),
        nestedKind: "command-substitution",
      }, build, depth);
    },
  );
}

function walkPartsCommands(parts: readonly ShellWordPart[] | undefined, source: string, state: WalkState, build: BuildState, depth: number): void {
  for (const part of parts ?? []) {
    if (part.type === "DoubleQuoted" || part.type === "LocaleString" || part.type === "ExtendedGlob" || part.type === "BraceExpansion") {
      walkPartsCommands(part.parts, source, state, build, depth);
    } else if (part.type === "CommandExpansion" || part.type === "ProcessSubstitution") {
      if (!part.script) continue;
      walkStatements(part.script.commands, scriptSource(part.script, source), {
        ...state,
        execution: cloneExecution(state.execution),
        nestedKind: part.type === "CommandExpansion" ? "command-substitution" : "process-substitution",
      }, build, depth);
    } else if (part.type === "ParameterExpansion") {
      walkPartsCommands(part.indexParts, source, state, build, depth);
      for (const word of [part.operand, part.slice?.offset, part.slice?.length, part.replace?.pattern, part.replace?.replacement]) {
        if (word) walkWordCommands(word, source, state, build, depth);
      }
    } else if (part.type === "ArithmeticExpansion") {
      walkArithmeticCommands(part.expression, source, state, build, depth);
    }
  }
}

function walkWordCommands(word: ShellWord, source: string, state: WalkState, build: BuildState, depth: number): void {
  walkPartsCommands(word.parts, source, state, build, depth);
}

function walkRedirectCommands(redirects: readonly Redirect[], source: string, state: WalkState, build: BuildState, depth: number): void {
  for (const redirect of redirects) {
    if (redirect.target) walkWordCommands(redirect.target, source, state, build, depth);
    if (redirect.body) walkWordCommands(redirect.body, source, state, build, depth);
  }
}

const OUTPUT_REDIRECTS = new Set([">", ">>", ">|", "<>", "&>", "&>>"]);

function redirectWriteTargets(redirects: readonly Redirect[], execution: ExecutionContext): ParsedWord[] {
  return redirects.flatMap((redirect) => {
    if (!OUTPUT_REDIRECTS.has(redirect.operator) || !redirect.target) return [];
    return [concreteWord(parsedWord(redirect.target), execution)];
  });
}

function markUnsafeRedirects(
  targets: ParsedWord[],
  source: string,
  execution: ExecutionContext,
  build: BuildState,
  representedByInvocation: boolean,
): void {
  for (const target of targets) {
    const resolved = resolvePathWord(target, execution);
    if (resolved.unresolved || resolved.value === undefined || resolved.hasUnquotedGlob || resolved.hasUnquotedFieldSplitting) {
      markUncertain(build, "redirection target is dynamic or unresolved", source, execution);
    } else if (!representedByInvocation && target.literal !== "/dev/null" && isProtectedRootOperand(target, execution, execution)) {
      markUncertain(build, "redirection writes to a protected root path", source, execution);
    }
  }
}

interface HeredocBody {
  value?: string;
  quoted: boolean;
}

function heredocBody(command: ShellCommand): HeredocBody | undefined {
  for (const redirect of command.redirects) {
    if (redirect.operator !== "<<" && redirect.operator !== "<<-") continue;
    if (redirect.heredocQuoted) return { value: redirect.content, quoted: true };
    if (!redirect.body) return { value: redirect.content, quoted: false };
    const body = parsedWord(redirect.body);
    return { value: body.literal, quoted: false };
  }
  return undefined;
}

const GIT_FORCE_SUBCOMMANDS = new Set(["push", "reset", "clean"]);
const NPM_INSTALL_SUBCOMMANDS = new Set(["install", "i", "uninstall", "remove"]);
const FILESYSTEM_SINKS = new Set(["rm", "mv", "cp", "chmod", "chown", "ln", "tee"]);

function chmodModeArgument(args: ParsedWord[]): ParsedWord | undefined | "ambiguous" {
  let options = true;
  for (const arg of args) {
    const value = arg.literal;
    if (!options) return arg;
    if (value === "--") {
      options = false;
      continue;
    }
    if (value === undefined) return "ambiguous";
    if (value.startsWith("-") && value !== "-") continue;
    return arg;
  }
  return undefined;
}

/**
 * Some rules only inspect literal argument values (e.g. git's subcommand and force flags,
 * chmod's mode, dd's key=value operands, npm's subcommand and global flag). When those
 * positions are dynamic or unresolved we cannot rule out a dangerous value, so fail closed
 * by marking the analysis uncertain instead of silently ignoring the argument.
 */
function markDynamicRuleRelevantArgs(executable: string, invocation: CommandInvocation, build: BuildState, execution: ExecutionContext): void {
  if (executable === "git") {
    const subcommand = invocation.args[0];
    if (!subcommand) return;
    if (subcommand.literal === undefined) {
      markUncertain(build, "git subcommand is dynamic or unresolved", invocation.raw, execution);
    } else if (GIT_FORCE_SUBCOMMANDS.has(subcommand.literal) && invocation.args.slice(1).some((arg) => arg.literal === undefined)) {
      markUncertain(build, "git option is dynamic or unresolved", invocation.raw, execution);
    }
    return;
  }
  if (executable === "chmod") {
    const mode = chmodModeArgument(invocation.args);
    if (mode === "ambiguous" || (mode && mode.literal === undefined)) {
      markUncertain(build, "chmod mode is dynamic or unresolved", invocation.raw, execution);
    }
    return;
  }
  if (executable === "dd") {
    if (invocation.args.some((arg) => arg.literal === undefined)) {
      markUncertain(build, "dd argument is dynamic or unresolved", invocation.raw, execution);
    }
    return;
  }
  if (executable === "npm") {
    const subcommand = invocation.args[0];
    if (!subcommand) return;
    if (subcommand.literal === undefined) {
      markUncertain(build, "npm subcommand is dynamic or unresolved", invocation.raw, execution);
    } else if (NPM_INSTALL_SUBCOMMANDS.has(subcommand.literal) && invocation.args.slice(1).some((arg) => arg.literal === undefined)) {
      markUncertain(build, "npm option is dynamic or unresolved", invocation.raw, execution);
    }
    return;
  }
  if (executable === "brew") {
    if (invocation.args[0]?.literal === undefined) markUncertain(build, "brew subcommand is dynamic or unresolved", invocation.raw, execution);
    return;
  }
  if (executable === "docker") {
    const subcommand = invocation.args[0]?.literal;
    if (subcommand === undefined || (subcommand === "system" && invocation.args[1]?.literal === undefined)) {
      markUncertain(build, "docker subcommand is dynamic or unresolved", invocation.raw, execution);
    }
    return;
  }
  if (executable === "nc" || executable === "ncat" || executable === "netcat") {
    for (const arg of invocation.args) {
      if (arg.literal === "--") break;
      if (arg.literal === undefined) {
        markUncertain(build, "netcat option is dynamic or unresolved", invocation.raw, execution);
        break;
      }
      if (!arg.literal.startsWith("-") || arg.literal === "-") break;
    }
    return;
  }
  if (executable === "kill") {
    let options = true;
    for (let index = 0; index < invocation.args.length && options; index++) {
      const value = invocation.args[index]?.literal;
      if (value === "--") {
        options = false;
        continue;
      }
      if (value === "-l" || value === "--list") return;
      if (value === undefined) {
        markUncertain(build, "kill signal is dynamic or unresolved", invocation.raw, execution);
        return;
      }
      if (value === "-s" || value === "--signal" || value === "-n") {
        if (invocation.args[index + 1]?.literal === undefined) {
          markUncertain(build, "kill signal is dynamic or unresolved", invocation.raw, execution);
        }
        return;
      }
      if (value.startsWith("-") && value !== "-") return;
      options = false;
    }
  }
}

function filesystemOperands(executable: string, args: ParsedWord[]): ParsedWord[] {
  const operands: ParsedWord[] = [];
  let options = true;
  let positional = 0;
  for (const arg of args) {
    const value = arg.literal;
    if (options && value === "--") {
      options = false;
      continue;
    }
    if (options && value?.startsWith("-") && value !== "-") continue;
    positional++;
    if ((executable === "chmod" || executable === "chown") && positional === 1) continue;
    operands.push(arg);
  }
  return operands;
}

function hasLiteralRecursiveRmOption(args: ParsedWord[]): boolean {
  let options = true;
  for (const arg of args) {
    const value = arg.literal;
    if (value === "--") {
      options = false;
      continue;
    }
    if (!options || value === undefined || !value.startsWith("-") || value === "-") continue;
    if (value === "--recursive" || (/^-[^-]+$/.test(value) && /[rR]/.test(value.slice(1)))) return true;
  }
  return false;
}

function markDynamicFilesystemOperands(executable: string, invocation: CommandInvocation, build: BuildState, execution: ExecutionContext): void {
  if (!FILESYSTEM_SINKS.has(executable)) return;
  // Recursive rm already fails closed with the more specific recursive-delete rule.
  if (executable === "rm" && hasLiteralRecursiveRmOption(invocation.args)) return;
  const unresolved = filesystemOperands(executable, invocation.args).some((operand) => {
    const resolved = resolvePathWord(operand, invocation.argumentExecution);
    return resolved.unresolved || resolved.value === undefined || resolved.hasUnquotedGlob || resolved.hasUnquotedFieldSplitting;
  });
  if (unresolved) markUncertain(build, `${executable} filesystem operand is dynamic or unresolved`, invocation.raw, execution);
}

function walkCall(command: ShellCommand, source: string, state: WalkState, build: BuildState, depth: number): CommandInvocation | undefined {
  if (!command.name) {
    for (const assignment of command.prefix) {
      if (assignment.value) walkWordCommands(assignment.value, source, state, build, depth);
      for (const word of assignment.array ?? []) walkWordCommands(word, source, state, build, depth);
      walkPartsCommands(assignment.indexParts, source, state, build, depth);
    }
    state.execution = applyAssignments(command.prefix, state.execution, state.execution);
    const writeTargets = redirectWriteTargets(command.redirects, state.execution);
    markUnsafeRedirects(writeTargets, sourceSlice(source, command), state.execution, build, false);
    walkRedirectCommands(command.redirects, source, state, build, depth);
    return undefined;
  }

  const astWords = [command.name, ...command.suffix];
  const argumentExecution = cloneExecution(state.execution);
  const words = astWords.map((word) => concreteWord(parsedWord(word), argumentExecution));
  const execution = applyAssignments(command.prefix, state.execution, argumentExecution);
  const normalized = normalizeWrappers(words, execution, argumentExecution);
  const invocation: CommandInvocation = {
    id: build.nextInvocationId++,
    executable: normalized.executable,
    originalExecutable: words[0],
    args: normalized.args,
    writeTargets: redirectWriteTargets(command.redirects, argumentExecution),
    argumentExecution,
    execution: cloneExecution(normalized.execution),
    cwd: normalized.execution.kind === "local" ? normalized.execution.cwd : cloneSymbolic(normalized.execution.cwd),
    wrappers: normalized.wrappers,
    pipelineId: state.pipelineId,
    pipelineIndex: state.pipelineIndex,
    parentInvocationId: state.parentInvocationId,
    nestedKind: state.nestedKind,
    raw: sourceSlice(source, command),
  };
  build.analysis.invocations.push(invocation);
  markUnsafeRedirects(invocation.writeTargets ?? [], invocation.raw, argumentExecution, build, true);
  if (normalized.uncertain) markUncertain(build, normalized.uncertain, invocation.raw, state.execution);
  if (normalized.envSplitString === undefined && normalized.executable.dynamic) {
    markUncertain(build, "executable is dynamic or unresolved", invocation.raw, state.execution);
  }

  if (normalized.envSplitString !== undefined) {
    parseNested(normalized.envSplitString, normalized.execution, build, depth, invocation.id, "env-split-string");
    return invocation;
  }

  const substitutionState = {
    ...state,
    pipelineId: undefined,
    pipelineIndex: undefined,
    parentInvocationId: invocation.id,
  };
  for (const word of astWords) walkWordCommands(word, source, substitutionState, build, depth);
  for (const assignment of command.prefix) {
    if (assignment.value) walkWordCommands(assignment.value, source, substitutionState, build, depth);
    for (const word of assignment.array ?? []) walkWordCommands(word, source, substitutionState, build, depth);
    walkPartsCommands(assignment.indexParts, source, substitutionState, build, depth);
  }
  walkRedirectCommands(command.redirects, source, substitutionState, build, depth);

  const executable = invocation.executable.literal ? basename(invocation.executable.literal) : undefined;
  if (executable) {
    markDynamicRuleRelevantArgs(executable, invocation, build, state.execution);
    markDynamicFilesystemOperands(executable, invocation, build, state.execution);
  }
  if (executable && SHELLS.has(executable)) {
    const payload = shellPayload(invocation.args, state.execution);
    if (payload.value !== undefined) parseNested(payload.value, normalized.execution, build, depth, invocation.id, "shell-c");
    else if (payload.found) markUncertain(build, "shell payload is dynamic or unresolved", invocation.raw, state.execution);
  } else if (executable === "ssh") {
    const ssh = extractSshCommand(invocation.args);
    if (ssh) {
      if (ssh.host === undefined) markUncertain(build, "SSH host is dynamic or unresolved", invocation.raw, state.execution);
      const remote: ExecutionContext = {
        kind: "ssh",
        host: ssh.host ?? "<unknown>",
        cwd: { kind: "home", value: "" },
        home: { kind: "home", value: "" },
        env: {},
        pathValues: {},
      };
      const dynamicCommandWord = ssh.commandWords.some((word) => {
        const resolved = resolveWord(word, state.execution);
        return resolved.unresolved || resolved.hasUnquotedGlob || resolved.hasUnquotedFieldSplitting || resolved.value === undefined;
      });
      if (dynamicCommandWord) markUncertain(build, "SSH command is dynamic or unresolved", invocation.raw, state.execution);
      const payload = dynamicCommandWord ? undefined : payloadFromWords(ssh.commandWords, state.execution);
      if (payload) parseNested(payload, remote, build, depth, invocation.id, "ssh");

      const remoteExecutable = ssh.commandWords[0]?.literal ? basename(ssh.commandWords[0].literal) : undefined;
      if (remoteExecutable && SHELLS.has(remoteExecutable)) {
        const body = heredocBody(command);
        if (body && !body.quoted) markUncertain(build, "unquoted SSH shell heredoc is dynamic or unresolved", invocation.raw, state.execution);
        if (body?.value !== undefined) parseNested(body.value, remote, build, depth, invocation.id, "ssh-heredoc");
      }
    }
  }

  if (!normalized.wrappers.includes("env") && !normalized.wrappers.includes("sudo")) {
    updateCwd(invocation, state.execution, argumentExecution, build);
  }
  return invocation;
}

function walkTestCommands(expression: TestExpression | undefined, source: string, state: WalkState, build: BuildState, depth: number): void {
  visitTestWords(expression, (word) => {
    if (word) walkWordCommands(word, source, state, build, depth);
  });
}

function nodeMayChangeCwd(node: ShellNode): boolean {
  if (node.type === "Statement") return nodeMayChangeCwd(node.command);
  if (node.type === "Command") {
    return node.name?.text !== undefined && basename(node.name.text) === "cd" && node.suffix.length <= 1;
  }
  if (node.type === "AndOr") return node.operators.includes("||") && node.commands.some(nodeMayChangeCwd);
  if (node.type === "If") return nodeMayChangeCwd(node.clause) || nodeMayChangeCwd(node.then) || Boolean(node.else && nodeMayChangeCwd(node.else));
  if (node.type === "For" || node.type === "Select") return nodeMayChangeCwd(node.body);
  if (node.type === "While") return nodeMayChangeCwd(node.clause) || nodeMayChangeCwd(node.body);
  if (node.type === "BraceGroup" || node.type === "CompoundList") {
    return node.type === "BraceGroup" ? nodeMayChangeCwd(node.body) : node.commands.some(nodeMayChangeCwd);
  }
  if (node.type === "Case") return node.items.some((item) => nodeMayChangeCwd(item.body));
  return false;
}

function markCwdMayChange(node: ShellNode, source: string, state: WalkState, build: BuildState): void {
  const known = state.execution.kind === "local" ? state.execution.cwd !== undefined : state.execution.cwd.kind !== "unknown";
  if (!known || !nodeMayChangeCwd(node)) return;
  state.execution = unknownCwd(state.execution);
  markUncertain(build, "cwd may change across compound control flow", sourceSlice(source, node), state.execution);
}

function walkNode(node: ShellNode, source: string, state: WalkState, build: BuildState, depth: number): void {
  if (node.type === "Statement") {
    walkNode(node.command, source, state, build, depth);
    walkRedirectCommands(node.redirects, source, state, build, depth);
  } else if (node.type === "Command") {
    walkCall(node, source, state, build, depth);
  } else if (node.type === "Pipeline") {
    const pipelineId = build.nextPipelineId++;
    node.commands.forEach((stage, index) => walkNode(stage, source, {
      ...state,
      execution: cloneExecution(state.execution),
      pipelineId,
      pipelineIndex: index,
    }, build, depth));
  } else if (node.type === "AndOr") {
    if (!node.operators.includes("||")) {
      for (const child of node.commands) walkNode(child, source, state, build, depth);
      return;
    }
    let branchExecution = cloneExecution(state.execution);
    let ambiguous = false;
    node.commands.forEach((child, index) => {
      if (index > 0 && node.operators[index - 1] === "||") ambiguous = true;
      if (ambiguous) branchExecution = unknownCwd(state.execution);
      walkNode(child, source, { ...state, execution: branchExecution }, build, depth);
    });
    markCwdMayChange(node, source, state, build);
  } else if (node.type === "Subshell") {
    walkNode(node.body, source, { ...state, execution: cloneExecution(state.execution) }, build, depth);
  } else if (node.type === "BraceGroup" || node.type === "CompoundList") {
    if (node.type === "BraceGroup") walkNode(node.body, source, state, build, depth);
    else for (const statement of node.commands) walkNode(statement, source, state, build, depth);
  } else if (node.type === "If") {
    walkNode(node.clause, source, { ...state, execution: cloneExecution(state.execution) }, build, depth);
    walkNode(node.then, source, { ...state, execution: cloneExecution(state.execution) }, build, depth);
    if (node.else) walkNode(node.else, source, { ...state, execution: cloneExecution(state.execution) }, build, depth);
    markCwdMayChange(node, source, state, build);
  } else if (node.type === "For" || node.type === "Select") {
    walkWordCommands(node.name, source, state, build, depth);
    for (const word of node.wordlist) walkWordCommands(word, source, state, build, depth);

    const variable = parsedWord(node.name).literal;
    const values = node.wordlist.map((word) => concreteWord(parsedWord(word), state.execution));
    const bounded = variable !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)
      && values.length > 0 && values.length <= MAX_LOOP_VALUES
      && values.every((word) => word.literal !== undefined && !word.dynamic);
    const canExpand = bounded && build.loopExpansions + values.length <= MAX_LOOP_EXPANSIONS;
    if (canExpand) {
      build.loopExpansions += values.length;
      for (const word of values) {
        const execution = cloneExecution(state.execution);
        execution.env = { ...(execution.env ?? {}), [variable]: word.literal };
        execution.pathValues = { ...execution.pathValues, [variable]: undefined };
        walkNode(node.body, source, { ...state, execution }, build, depth);
      }
    } else {
      const execution = cloneExecution(state.execution);
      if (variable !== undefined) {
        execution.env = { ...(execution.env ?? {}), [variable]: undefined };
        execution.pathValues = { ...execution.pathValues, [variable]: undefined };
      }
      walkNode(node.body, source, { ...state, execution }, build, depth);
    }
    markCwdMayChange(node, source, state, build);
  } else if (node.type === "ArithmeticFor") {
    walkArithmeticCommands(node.initialize, source, state, build, depth);
    walkArithmeticCommands(node.test, source, state, build, depth);
    walkArithmeticCommands(node.update, source, state, build, depth);
    walkNode(node.body, source, { ...state, execution: cloneExecution(state.execution) }, build, depth);
    markCwdMayChange(node, source, state, build);
  } else if (node.type === "While") {
    walkNode(node.clause, source, { ...state, execution: cloneExecution(state.execution) }, build, depth);
    walkNode(node.body, source, { ...state, execution: cloneExecution(state.execution) }, build, depth);
    markCwdMayChange(node, source, state, build);
  } else if (node.type === "Function") {
    walkNode(node.body, source, { ...state, execution: cloneExecution(state.execution) }, build, depth);
    walkRedirectCommands(node.redirects, source, state, build, depth);
  } else if (node.type === "Case") {
    walkWordCommands(node.word, source, state, build, depth);
    for (const item of node.items) {
      for (const word of item.pattern) walkWordCommands(word, source, state, build, depth);
      walkNode(item.body, source, { ...state, execution: cloneExecution(state.execution) }, build, depth);
    }
    markCwdMayChange(node, source, state, build);
  } else if (node.type === "Coproc") {
    walkNode(node.body, source, { ...state, execution: cloneExecution(state.execution) }, build, depth);
    walkRedirectCommands(node.redirects, source, state, build, depth);
  } else if (node.type === "TestCommand") {
    walkTestCommands(node.expression, source, state, build, depth);
  } else if (node.type === "ArithmeticCommand") {
    walkArithmeticCommands(node.expression, source, state, build, depth);
  }
}

function walkStatements(statements: ParsedScript["commands"], source: string, state: WalkState, build: BuildState, depth: number): void {
  for (const statement of statements) walkNode(statement, source, state, build, depth);
}

export function localExecutionContext(cwd: string, env: NodeJS.ProcessEnv = process.env): ExecutionContext {
  const home = env.HOME ? path.resolve(env.HOME) : path.resolve(cwd);
  const tempRoots = ["/tmp", "/private/tmp"];
  if (env.TMPDIR && path.isAbsolute(env.TMPDIR)) tempRoots.push(path.resolve(env.TMPDIR));
  return { kind: "local", cwd: path.resolve(cwd), home, tempRoots, env: { ...env }, pathValues: {} };
}

export function analyzeCommand(source: string, execution: ExecutionContext): CommandAnalysis {
  const analysis: CommandAnalysis = { source, invocations: [], parseFailures: [], fallbackMatches: new Set(), uncertainties: [] };
  const build: BuildState = { analysis, nextInvocationId: 1, nextPipelineId: 1, loopExpansions: 0 };
  const script = parseComplete(source);
  if (!script) {
    analysis.parseFailures.push({ source, context: cloneExecution(execution) });
    const fallback = fallbackRules(source);
    analysis.fallbackMatches = fallback.matches;
    if (fallback.recursionLimitReached) analysis.uncertainties.push("fallback recursion limit reached");
    return analysis;
  }
  walkStatements(script.commands, scriptSource(script, source), { execution: cloneExecution(execution) }, build, 0);
  return analysis;
}
