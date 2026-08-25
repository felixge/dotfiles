export type WordPart =
  | { kind: "literal"; value: string; quoted: boolean }
  | { kind: "parameter"; name?: string; quoted: boolean }
  | { kind: "command-substitution"; quoted: boolean }
  | { kind: "arithmetic"; quoted: boolean }
  | { kind: "other"; quoted: boolean };

export interface ParsedWord {
  raw: string;
  literal?: string;
  parts: WordPart[];
  dynamic: boolean;
  hasUnquotedGlob: boolean;
}

export type SymbolicPath =
  | { kind: "absolute"; value: string }
  | { kind: "home"; value: string }
  | { kind: "temp"; value: string }
  | { kind: "unknown" };

export type ExecutionContext =
  | {
      kind: "local";
      cwd: string;
      home: string;
      tempRoots: string[];
      env: Record<string, string | undefined>;
    }
  | {
      kind: "ssh";
      host: string;
      cwd: SymbolicPath;
      home: SymbolicPath;
    };

export interface CommandInvocation {
  id: number;
  executable: ParsedWord;
  originalExecutable: ParsedWord;
  args: ParsedWord[];
  execution: ExecutionContext;
  cwd: string | SymbolicPath;
  wrappers: string[];
  pipelineId?: number;
  pipelineIndex?: number;
  parentInvocationId?: number;
  nestedKind?: "command-substitution" | "process-substitution" | "shell-c" | "ssh" | "ssh-heredoc";
  raw: string;
}

export interface CommandAnalysis {
  source: string;
  invocations: CommandInvocation[];
  parseFailures: Array<{ source: string; context: ExecutionContext }>;
  fallbackMatches: Set<string>;
}

export interface RuleContext {
  analysis: CommandAnalysis;
}

export interface Rule {
  name: string;
  description: string;
  test: (context: RuleContext) => boolean;
}

export interface ResolvedWord {
  value?: string;
  unresolved: boolean;
  hasUnquotedGlob: boolean;
}
