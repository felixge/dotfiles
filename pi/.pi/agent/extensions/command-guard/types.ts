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
      cwd: string | undefined;
      home: string;
      tempRoots: string[];
      env: Record<string, string | undefined>;
    }
  | {
      kind: "ssh";
      host: string;
      cwd: SymbolicPath;
      home: SymbolicPath;
      env?: Record<string, string | undefined>;
    };

export interface CommandInvocation {
  id: number;
  executable: ParsedWord;
  originalExecutable: ParsedWord;
  args: ParsedWord[];
  /** Environment used to expand the command's arguments in the outer shell. */
  argumentExecution: ExecutionContext;
  /** Environment and cwd used by the invoked command or nested child shell. */
  execution: ExecutionContext;
  cwd: string | undefined | SymbolicPath;
  wrappers: string[];
  pipelineId?: number;
  pipelineIndex?: number;
  parentInvocationId?: number;
  nestedKind?: "command-substitution" | "process-substitution" | "shell-c" | "ssh" | "ssh-heredoc" | "env-split-string";
  raw: string;
}

export interface CommandAnalysis {
  source: string;
  invocations: CommandInvocation[];
  parseFailures: Array<{ source: string; context: ExecutionContext }>;
  fallbackMatches: Set<string>;
  uncertainties: string[];
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
