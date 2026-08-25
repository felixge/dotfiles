import path from "node:path";
import { inspectRm, isHighRiskRm, isHomeDotfileTarget, isProtectedRootOperand } from "./paths.js";
import type { CommandInvocation, ParsedWord, Rule } from "./types.js";

function name(invocation: CommandInvocation): string | undefined {
  return invocation.executable.literal ? path.posix.basename(invocation.executable.literal) : undefined;
}

function values(invocation: CommandInvocation): string[] {
  return invocation.args.flatMap((arg) => arg.literal === undefined ? [] : [arg.literal]);
}

function hasShortOption(args: string[], option: string): boolean {
  let enabled = true;
  return args.some((arg) => {
    if (arg === "--") {
      enabled = false;
      return false;
    }
    return enabled && /^-[^-]+$/.test(arg) && arg.slice(1).includes(option);
  });
}

function command(invocation: CommandInvocation, executable: string): boolean {
  return name(invocation) === executable;
}

function anyInvocation(test: (invocation: CommandInvocation) => boolean): (context: { analysis: { invocations: CommandInvocation[] } }) => boolean {
  return ({ analysis }) => analysis.invocations.some(test);
}

const ROOT_WRITE_COMMANDS = new Set(["mv", "cp", "rm", "chmod", "chown", "ln", "tee", "dd"]);
const DOWNLOADERS = new Set(["curl", "wget"]);
const EXECUTORS = new Set(["bash", "sh", "zsh", "python", "node", "ruby", "perl"]);

export const rules: Rule[] = [
  {
    name: "recursive-delete",
    description: "High-risk recursive file deletion",
    test: ({ analysis }) => analysis.fallbackMatches.has("recursive-delete") || analysis.invocations.some((invocation) => {
      const rm = inspectRm(invocation);
      return rm ? isHighRiskRm(rm) : false;
    }),
  },
  {
    name: "root-path-write",
    description: "Writing to sensitive system paths",
    test: anyInvocation((invocation) => {
      const executable = name(invocation);
      return Boolean(executable && ROOT_WRITE_COMMANDS.has(executable) && invocation.args.some((arg) => isProtectedRootOperand(arg, invocation.execution)));
    }),
  },
  {
    name: "home-dotfile-delete",
    description: "Deleting home directory dotfiles",
    test: anyInvocation((invocation) => {
      const rm = inspectRm(invocation);
      return Boolean(rm?.targets.some((target) => isHomeDotfileTarget(target, invocation.execution)));
    }),
  },
  {
    name: "sudo",
    description: "Running command with sudo",
    test: ({ analysis }) => analysis.fallbackMatches.has("sudo") || analysis.invocations.some((invocation) => invocation.wrappers.includes("sudo") || command(invocation, "sudo")),
  },
  {
    name: "world-writable",
    description: "Setting world-writable permissions (777/666)",
    test: anyInvocation((invocation) => command(invocation, "chmod") && values(invocation).some((value) => value === "777" || value === "666")),
  },
  {
    name: "curl-pipe-exec",
    description: "Piping a download directly to an interpreter",
    test: ({ analysis }) => analysis.invocations.some((download) => {
      if (!DOWNLOADERS.has(name(download) ?? "")) return false;
      return analysis.invocations.some((executor) => {
        if (!EXECUTORS.has(name(executor) ?? "")) return false;
        const pipeline = download.pipelineId !== undefined && download.pipelineId === executor.pipelineId && (download.pipelineIndex ?? 0) < (executor.pipelineIndex ?? 0);
        const processSubstitution = download.parentInvocationId === executor.id && download.nestedKind === "process-substitution";
        return pipeline || processSubstitution;
      });
    }),
  },
  {
    name: "git-force-push",
    description: "Force pushing to remote",
    test: anyInvocation((invocation) => {
      const args = values(invocation);
      return command(invocation, "git") && args[0] === "push" && (args.includes("--force") || hasShortOption(args.slice(1), "f"));
    }),
  },
  {
    name: "git-hard-reset",
    description: "Hard resetting git history",
    test: anyInvocation((invocation) => {
      const args = values(invocation);
      return command(invocation, "git") && args[0] === "reset" && args.includes("--hard");
    }),
  },
  {
    name: "git-clean-force",
    description: "Force cleaning untracked files",
    test: anyInvocation((invocation) => {
      const args = values(invocation);
      return command(invocation, "git") && args[0] === "clean" && (args.includes("--force") || hasShortOption(args.slice(1), "f"));
    }),
  },
  {
    name: "kill-signal",
    description: "Sending kill signals (kill -9, killall)",
    test: anyInvocation((invocation) => command(invocation, "killall") || (command(invocation, "kill") && values(invocation).includes("-9"))),
  },
  {
    name: "dd-command",
    description: "Raw disk write with dd",
    test: anyInvocation((invocation) => command(invocation, "dd") && values(invocation).some((value) => value.startsWith("of="))),
  },
  {
    name: "mkfs",
    description: "Formatting filesystem",
    test: ({ analysis }) => analysis.fallbackMatches.has("mkfs") || analysis.invocations.some((invocation) => name(invocation) === "mkfs" || name(invocation)?.startsWith("mkfs.")),
  },
  {
    name: "global-npm-install",
    description: "Global npm install/uninstall",
    test: anyInvocation((invocation) => {
      const args = values(invocation);
      return command(invocation, "npm") && ["install", "i", "uninstall", "remove"].includes(args[0] ?? "") && (args.includes("--global") || hasShortOption(args.slice(1), "g"));
    }),
  },
  {
    name: "brew-uninstall",
    description: "Homebrew uninstall/remove",
    test: anyInvocation((invocation) => command(invocation, "brew") && ["uninstall", "remove"].includes(values(invocation)[0] ?? "")),
  },
  {
    name: "docker-system-prune",
    description: "Docker system-wide prune",
    test: anyInvocation((invocation) => command(invocation, "docker") && values(invocation)[0] === "system" && values(invocation)[1] === "prune"),
  },
  {
    name: "reverse-shell",
    description: "Possible reverse shell pattern",
    test: ({ analysis }) => {
      const netcat = analysis.invocations.some((invocation) => ["nc", "ncat", "netcat"].includes(name(invocation) ?? "") && hasShortOption(values(invocation), "e"));
      const devSocket = analysis.invocations.some((invocation) => invocation.args.some((word: ParsedWord) => word.parts.some((part) => part.kind === "literal" && /\/dev\/(?:tcp|udp)\//.test(part.value))));
      const fifo = analysis.invocations.some((invocation) => command(invocation, "mkfifo"));
      const nc = analysis.invocations.some((invocation) => ["nc", "ncat"].includes(name(invocation) ?? ""));
      return netcat || devSocket || (fifo && nc);
    },
  },
];

export function matchingRules(context: { analysis: Parameters<Rule["test"]>[0]["analysis"] }): Rule[] {
  return rules.filter((rule) => rule.test(context));
}
