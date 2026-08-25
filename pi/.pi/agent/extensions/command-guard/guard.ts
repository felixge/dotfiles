import { analyzeCommand, localExecutionContext } from "./shell.js";
import { matchingRules } from "./rules.js";
import type { Rule } from "./types.js";

export const ALLOW_ONCE = "Allow once";
export const ALLOW_ALL = "Allow all future commands matching these rule(s)";
export const BLOCK = "Block";

export interface GuardUiContext {
  cwd: string;
  hasUI: boolean;
  choose?: (title: string, options: string[]) => Promise<string | undefined>;
  abort: () => void;
  env?: NodeJS.ProcessEnv;
}

export interface GuardResult {
  block: true;
  reason: string;
}

export class CommandGuard {
  readonly allowedRules = new Set<string>();

  inspect(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Rule[] {
    const analysis = analyzeCommand(command, localExecutionContext(cwd, env));
    return matchingRules({ analysis }).filter((rule) => !this.allowedRules.has(rule.name));
  }

  async handle(command: string, context: GuardUiContext): Promise<GuardResult | undefined> {
    const violations = this.inspect(command, context.cwd, context.env);
    if (violations.length === 0) return undefined;

    const issueList = violations.map((violation) => `- ${violation.description}`).join("\n");
    if (!context.hasUI || !context.choose) {
      return { block: true, reason: `Command blocked (no UI for confirmation):\n${issueList}` };
    }

    const choice = await context.choose(
      `Potential issue${violations.length > 1 ? "s" : ""} detected:\n\n${issueList}\n\nCommand:\n  ${command}\n`,
      [ALLOW_ONCE, ALLOW_ALL, BLOCK],
    );

    if (choice === ALLOW_ONCE) return undefined;
    if (choice === ALLOW_ALL) {
      for (const violation of violations) this.allowedRules.add(violation.name);
      return undefined;
    }

    context.abort();
    return {
      block: true,
      reason: `Command blocked by user. Issues: ${violations.map((violation) => violation.name).join(", ")}`,
    };
  }
}
