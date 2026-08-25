import { analyzeCommand, localExecutionContext } from "./shell.js";
import { matchingRules } from "./rules.js";
import type { CommandAnalysis, Rule } from "./types.js";

export const ALLOW_ONCE = "Allow (Once)";
export const BLOCK = "Block";

function allowAllChoice(violations: Rule[]): string {
  return `Allow All: ${violations.map(({ name }) => name).join(", ")} (Session)`;
}

export type GuardDecision = "allow-once" | "allow-all" | "block" | "dismissed" | "no-ui-block";

export interface GuardAuditRecord {
  command: string;
  cwd: string;
  rules: Array<{ name: string; description: string }>;
  uncertainties: string[];
  parseFailures: string[];
  fallbackMatches: string[];
  decision: GuardDecision;
  promptDurationMs?: number;
  allowedRulesBefore: string[];
  allowedRulesAfter: string[];
}

export interface GuardUiContext {
  cwd: string;
  hasUI: boolean;
  choose?: (title: string, options: string[]) => Promise<string | undefined>;
  abort: () => void;
  env?: NodeJS.ProcessEnv;
  audit?: (record: GuardAuditRecord) => void;
}

export interface GuardResult {
  block: true;
  reason: string;
}

interface GuardInspection {
  analysis: CommandAnalysis;
  violations: Rule[];
}

export class CommandGuard {
  readonly allowedRules = new Set<string>();

  inspect(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Rule[] {
    return this.inspectDetailed(command, cwd, env).violations;
  }

  private inspectDetailed(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): GuardInspection {
    const analysis = analyzeCommand(command, localExecutionContext(cwd, env));
    const violations = matchingRules({ analysis }).filter((rule) => !this.allowedRules.has(rule.name));
    return { analysis, violations };
  }

  async handle(command: string, context: GuardUiContext): Promise<GuardResult | undefined> {
    const { analysis, violations } = this.inspectDetailed(command, context.cwd, context.env);
    if (violations.length === 0) return undefined;

    const allowedRulesBefore = [...this.allowedRules];
    const audit = (decision: GuardDecision, promptDurationMs?: number): void => {
      try {
        context.audit?.({
          command,
          cwd: context.cwd,
          rules: violations.map(({ name, description }) => ({ name, description })),
          uncertainties: [...analysis.uncertainties],
          parseFailures: analysis.parseFailures.map(({ source }) => source),
          fallbackMatches: [...analysis.fallbackMatches],
          decision,
          promptDurationMs,
          allowedRulesBefore,
          allowedRulesAfter: [...this.allowedRules],
        });
      } catch {
        // Audit persistence must not alter the command decision.
      }
    };

    const issueList = violations.map((violation) => `- ${violation.description}`).join("\n");
    if (!context.hasUI || !context.choose) {
      audit("no-ui-block");
      return { block: true, reason: `Command blocked (no UI for confirmation):\n${issueList}` };
    }

    const promptStartedAt = Date.now();
    const allowAll = allowAllChoice(violations);
    const choice = await context.choose(
      `Potential issue${violations.length > 1 ? "s" : ""} detected:\n\n${issueList}\n\nCommand:\n  ${command}\n`,
      [ALLOW_ONCE, allowAll, BLOCK],
    );
    const promptDurationMs = Date.now() - promptStartedAt;

    if (choice === ALLOW_ONCE) {
      audit("allow-once", promptDurationMs);
      return undefined;
    }
    if (choice === allowAll) {
      for (const violation of violations) this.allowedRules.add(violation.name);
      audit("allow-all", promptDurationMs);
      return undefined;
    }

    audit(choice === BLOCK ? "block" : "dismissed", promptDurationMs);
    context.abort();
    return {
      block: true,
      reason: `Command blocked by user. Issues: ${violations.map((violation) => violation.name).join(", ")}`,
    };
  }
}
