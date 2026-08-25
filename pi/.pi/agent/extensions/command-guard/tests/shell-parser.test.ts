import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeCommand, localExecutionContext } from "../shell.js";
import { matchingRules } from "../rules.js";
import { testFs, type TestFs } from "./helpers.js";

function analyze(command: string, fixture: TestFs) {
  return analyzeCommand(command, localExecutionContext(fixture.cwd, fixture.env));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

describe("unbash parser adapter", () => {
  let fixture: TestFs;
  beforeEach(() => fixture = testFs());
  afterEach(() => fixture.cleanup());

  it("normalizes commands, arguments, separators, pipelines, and groups", () => {
    const result = analyze("one a; { two b; } | (three c); four d && five e", fixture);
    expect(result.parseFailures).toEqual([]);
    expect(result.invocations.map((invocation) => [invocation.executable.literal, invocation.args[0]?.literal])).toEqual([
      ["one", "a"], ["two", "b"], ["three", "c"], ["four", "d"], ["five", "e"],
    ]);
    const two = result.invocations[1];
    const three = result.invocations[2];
    expect(two?.pipelineId).toBeDefined();
    expect(three?.pipelineId).toBe(two?.pipelineId);
    expect([two?.pipelineIndex, three?.pipelineIndex]).toEqual([0, 1]);
  });

  it("distinguishes single, double, and unquoted words", () => {
    const source = String.raw`printf '%s' "a b" c\ d plain "$HOME" '$HOME' * '*'`;
    const invocation = analyze(source, fixture).invocations[0];
    expect(invocation?.args.map((word) => word.raw)).toEqual([
      "'%s'", '"a b"', String.raw`c\ d`, "plain", '"$HOME"', "'$HOME'", "*", "'*'",
    ]);
    expect(invocation?.args.slice(0, 4).map((word) => word.literal)).toEqual(["%s", "a b", "c d", "plain"]);
    expect(invocation?.args[0]?.parts).toEqual([{ kind: "literal", value: "%s", quoted: true }]);
    expect(invocation?.args[2]?.parts).toEqual([{ kind: "literal", value: "c d", quoted: false }]);
    expect(invocation?.args[4]).toMatchObject({ literal: undefined, dynamic: true, hasUnquotedGlob: false });
    expect(invocation?.args[4]?.parts).toEqual([{ kind: "parameter", name: "HOME", quoted: true }]);
    expect(invocation?.args[5]).toMatchObject({ literal: "$HOME", dynamic: false, hasUnquotedGlob: false });
    expect(invocation?.args[6]).toMatchObject({ literal: "*", dynamic: true, hasUnquotedGlob: true });
    expect(invocation?.args[7]).toMatchObject({ literal: "*", dynamic: false, hasUnquotedGlob: false });
  });

  it("does not mistake the [ test builtin for a globbed executable", () => {
    const source = String.raw`if [ -f terminology.md ]; then rg -n -i 'hero run' terminology.md || true; else printf 'terminology.md not found\n'; fi
printf '\n=== repo ===\n'
repo_vcs "$PWD" 2>/dev/null || true
printf '\n=== status ===\n'
git status --short 2>/dev/null || true`;
    const result = analyze(source, fixture);
    expect(result.parseFailures).toEqual([]);
    expect(result.uncertainties).toEqual([]);
    expect(matchingRules({ analysis: result })).toEqual([]);

    const globbedExecutable = analyze("./[ab] arg", fixture);
    expect(globbedExecutable.uncertainties).toContain("executable is dynamic or unresolved");
  });

  it("walks command, process, and arithmetic substitutions", () => {
    const source = 'echo "$(rm -rf /tmp/child)" <(curl https://example.test) "$((1 + $(mkfs.ext4 /dev/x)))"';
    const result = analyze(source, fixture);
    expect(result.parseFailures).toEqual([]);
    expect(result.invocations.map((invocation) => invocation.executable.literal)).toEqual([
      "echo", "rm", "curl", "mkfs.ext4",
    ]);
    expect(result.invocations.slice(1).map((invocation) => invocation.nestedKind)).toEqual([
      "command-substitution", "process-substitution", "command-substitution",
    ]);
    expect(matchingRules({ analysis: result }).map((rule) => rule.name)).toContain("mkfs");
  });

  it("rejects top-level and lazy nested partial ASTs before walking them", () => {
    const malformed = analyze("rm -rf / |", fixture);
    expect(malformed.invocations).toEqual([]);
    expect(malformed.parseFailures).toHaveLength(1);
    expect(malformed.fallbackMatches).toContain("recursive-delete");

    const nested = analyze('echo "$(if true)"', fixture);
    expect(nested.invocations).toEqual([]);
    expect(nested.parseFailures).toHaveLength(1);
    expect(nested.fallbackMatches.size).toBe(0);
  });

  it("uses the narrow fallback for malformed shell -c and SSH payloads", () => {
    for (const source of ["bash -c 'rm -rf / \"'", "ssh host 'rm -rf / \"'"]) {
      const result = analyze(source, fixture);
      expect(result.parseFailures).toHaveLength(1);
      expect(result.fallbackMatches, source).toContain("recursive-delete");
      expect(matchingRules({ analysis: result }).map((rule) => rule.name), source).toContain("recursive-delete");
    }
  });

  it("never interprets comments as commands, including during fallback", () => {
    for (const source of ["# rm -rf /", "true # mkfs /dev/x", "echo ok\n# sudo rm -rf /\nprintf done"]) {
      const result = analyze(source, fixture);
      expect(result.parseFailures, source).toEqual([]);
      expect(matchingRules({ analysis: result }), source).toEqual([]);
    }

    const malformed = analyze("echo >\n# ignored; rm -rf /\n", fixture);
    expect(malformed.parseFailures).toHaveLength(1);
    expect(malformed.invocations).toEqual([]);
    expect(malformed.fallbackMatches.size).toBe(0);
  });

  it("fails closed when the explicit shell payload recursion limit is reached", () => {
    let source = "rm -rf /";
    for (let index = 0; index < 7; index++) source = `bash -c ${shellQuote(source)}`;
    const result = analyze(source, fixture);
    expect(result.invocations).toHaveLength(6);
    expect(result.invocations.every((invocation) => invocation.executable.literal === "bash")).toBe(true);
    expect(result.uncertainties).toContain("nested command recursion limit reached");
    expect(matchingRules({ analysis: result }).map((rule) => rule.name)).toContain("analysis-uncertain");
  });

  it("handles wrapper cwd, environment, and split-string arguments conservatively", () => {
    for (const source of [
      `env 'TARGET=/tmp/pytorch-profiler' rm -rf "$TARGET"`,
      `env TARGET="/tmp/pytorch-profiler" rm -rf "$TARGET"`,
      `env -C"/tmp" rm -rf child`,
      `env --chdir="/tmp" rm -rf child`,
      `env -S"rm -rf /"`,
      `env --split-string="rm -rf /"`,
    ]) {
      const result = analyze(source, fixture);
      expect(result.invocations.some((invocation) => invocation.executable.literal === "rm"), source).toBe(true);
      expect(result.parseFailures, source).toEqual([]);
    }
    expect(matchingRules({ analysis: analyze("env -C /tmp rm -rf child", fixture) }).map((rule) => rule.name))
      .not.toContain("recursive-delete");

    const dynamicCwd = analyze('env -C "$UNKNOWN_CWD" rm -rf child', fixture);
    expect(dynamicCwd.uncertainties).toContain("env chdir is dynamic or unresolved");
    expect(matchingRules({ analysis: dynamicCwd }).map((rule) => rule.name)).toEqual(expect.arrayContaining(["analysis-uncertain", "recursive-delete"]));

    const dynamicEnv = analyze('env "$UNKNOWN_ENV" rm -rf child', fixture);
    expect(dynamicEnv.uncertainties).toContain("env option is dynamic or unsupported");
    expect(matchingRules({ analysis: dynamicEnv }).map((rule) => rule.name)).toContain("analysis-uncertain");

    expect(fixture.env.TARGET).toBeUndefined();
    fixture.env.TARGET = "/etc/example";
    expect(matchingRules({ analysis: analyze('env TARGET=/tmp/pytorch-profiler rm -rf "$TARGET"', fixture) }).map((rule) => rule.name))
      .toContain("recursive-delete");
    expect(matchingRules({ analysis: analyze('env TARGET=/etc rm -rf "$TARGET"', fixture) }).map((rule) => rule.name))
      .toContain("recursive-delete");
    expect(matchingRules({ analysis: analyze('env -i rm -rf "$TARGET"', fixture) }).map((rule) => rule.name))
      .toContain("recursive-delete");
    expect(matchingRules({ analysis: analyze("env -S 'rm -rf /'", fixture) }).map((rule) => rule.name))
      .toContain("recursive-delete");

    const childEnvironment = analyze(`env TARGET="/tmp/pytorch-profiler" sh -c 'rm -rf "$TARGET"'`, fixture);
    const childRm = childEnvironment.invocations.find((invocation) => invocation.executable.literal === "rm");
    expect(childRm?.execution).toMatchObject({ env: { TARGET: "/tmp/pytorch-profiler" } });
    expect(matchingRules({ analysis: childEnvironment }).map((rule) => rule.name)).not.toContain("recursive-delete");

    const prefixEnvironment = analyze(`TARGET="/tmp/pytorch-profiler" sh -c 'rm -rf "$TARGET"'`, fixture);
    expect(prefixEnvironment.invocations.find((invocation) => invocation.executable.literal === "rm")?.execution).toMatchObject({ env: { TARGET: "/tmp/pytorch-profiler" } });
    expect(matchingRules({ analysis: prefixEnvironment }).map((rule) => rule.name)).not.toContain("recursive-delete");

    const unresolvedAssignment = analyze(`env TARGET="$UNKNOWN_TARGET" sh -c 'rm -rf "$TARGET"'`, fixture);
    expect(unresolvedAssignment.invocations.find((invocation) => invocation.executable.literal === "rm")?.execution).toMatchObject({ env: { TARGET: undefined } });
    expect(matchingRules({ analysis: unresolvedAssignment }).map((rule) => rule.name)).toContain("recursive-delete");

    fixture.env.BASE = "/tmp/pytorch-profiler";
    const expandedAssignment = analyze(`env TARGET="$BASE" sh -c 'rm -rf "$TARGET"'`, fixture);
    expect(expandedAssignment.uncertainties).toEqual([]);
    expect(expandedAssignment.invocations.find((invocation) => invocation.executable.literal === "rm")?.execution).toMatchObject({ env: { TARGET: "/tmp/pytorch-profiler" } });

    const quotedExpandedAssignment = analyze(`env "TARGET=$BASE" sh -c 'rm -rf "$TARGET"'`, fixture);
    expect(quotedExpandedAssignment.uncertainties).toEqual([]);
    expect(quotedExpandedAssignment.invocations.find((invocation) => invocation.executable.literal === "rm")?.execution).toMatchObject({ env: { TARGET: "/tmp/pytorch-profiler" } });

    const dynamicSplit = analyze('env -S "$UNKNOWN_SCRIPT"', fixture);
    expect(dynamicSplit.uncertainties).toContain("env split-string command is dynamic or unresolved");
    expect(matchingRules({ analysis: dynamicSplit }).map((rule) => rule.name)).toContain("analysis-uncertain");
  });

  it("invalidates cwd after unresolved cd and cwd-changing control flow", () => {
    const unresolved = analyze('D=$(printf /etc); cd "$D"; rm -rf child', fixture);
    const unresolvedRm = unresolved.invocations.find((invocation) => invocation.executable.literal === "rm");
    expect(unresolvedRm?.cwd).toBeUndefined();
    expect(unresolved.uncertainties).toContain("cd directory is dynamic or unresolved");
    expect(matchingRules({ analysis: unresolved }).map((rule) => rule.name)).toEqual(expect.arrayContaining(["analysis-uncertain", "recursive-delete"]));

    const conditional = analyze("if true; then cd /etc; fi; rm -rf child", fixture);
    const conditionalRm = conditional.invocations.find((invocation) => invocation.executable.literal === "rm");
    expect(conditionalRm?.cwd).toBeUndefined();
    expect(conditional.uncertainties).toContain("cwd may change across compound control flow");
    expect(matchingRules({ analysis: conditional }).map((rule) => rule.name)).toEqual(expect.arrayContaining(["analysis-uncertain", "recursive-delete"]));
  });

  it("tracks sudo directory options and invalidates dynamic directories", () => {
    const changed = analyze("sudo -D /etc rm -rf child", fixture);
    expect(changed.invocations.find((invocation) => invocation.executable.literal === "rm")?.cwd).toBe("/etc");
    expect(matchingRules({ analysis: changed }).map((rule) => rule.name)).toContain("recursive-delete");

    const attached = analyze("sudo --chdir=/etc rm -rf child", fixture);
    expect(attached.invocations.find((invocation) => invocation.executable.literal === "rm")?.cwd).toBe("/etc");

    const dynamic = analyze('sudo -D "$UNKNOWN_CWD" rm -rf child', fixture);
    expect(dynamic.invocations.find((invocation) => invocation.executable.literal === "rm")?.cwd).toBeUndefined();
    expect(dynamic.uncertainties).toContain("sudo chdir is dynamic or unresolved");
    expect(matchingRules({ analysis: dynamic }).map((rule) => rule.name)).toEqual(expect.arrayContaining(["analysis-uncertain", "recursive-delete"]));

    const dynamicAttached = analyze('sudo --chdir="$UNKNOWN_CWD" rm -rf child', fixture);
    expect(dynamicAttached.uncertainties).toContain("sudo chdir is dynamic or unresolved");

    const dynamicShort = analyze('sudo -D"$UNKNOWN_CWD" rm -rf child', fixture);
    expect(dynamicShort.uncertainties).toContain("sudo chdir is dynamic or unresolved");
  });

  it("fails closed for dynamic SSH commands and unquoted SSH heredocs", () => {
    const mixed = analyze('ssh host \'echo a\' "$UNKNOWN_COMMAND"', fixture);
    expect(mixed.uncertainties).toContain("SSH command is dynamic or unresolved");
    expect(matchingRules({ analysis: mixed }).map((rule) => rule.name)).toContain("analysis-uncertain");

    const heredoc = analyze("ssh host /bin/sh <<EOF\nrm -rf /\nEOF", fixture);
    expect(heredoc.uncertainties).toContain("unquoted SSH shell heredoc is dynamic or unresolved");
    expect(matchingRules({ analysis: heredoc }).map((rule) => rule.name)).toContain("analysis-uncertain");
  });

  it("fails closed for dynamic executables and cwd after OR", () => {
    const dynamic = analyze('C=rm; "$C" -rf /', fixture);
    expect(dynamic.uncertainties).toContain("executable is dynamic or unresolved");
    expect(matchingRules({ analysis: dynamic }).map((rule) => rule.name)).toContain("analysis-uncertain");

    const afterOr = analyze("cd /etc || exit; rm -rf child", fixture);
    expect(afterOr.invocations.find((invocation) => invocation.executable.literal === "rm")?.cwd).toBeUndefined();
    expect(matchingRules({ analysis: afterOr }).map((rule) => rule.name)).toContain("recursive-delete");
  });

  it("fails closed for mixed static and dynamic shell payloads", () => {
    const result = analyze('bash -c "rm -rf / $UNKNOWN_PAYLOAD"', fixture);
    expect(result.invocations.map((invocation) => invocation.executable.literal)).toEqual(["bash"]);
    expect(result.uncertainties).toContain("shell payload is dynamic or unresolved");
    expect(matchingRules({ analysis: result }).map((rule) => rule.name)).toContain("analysis-uncertain");
  });

  it("does not leak cwd across mixed AND/OR branches", () => {
    const result = analyze("ssh host 'cd /tmp || cd /home && rm -rf child'", fixture);
    const rm = result.invocations.find((invocation) => invocation.executable.literal === "rm");
    expect(rm?.cwd).toEqual({ kind: "unknown" });
    expect(matchingRules({ analysis: result }).map((rule) => rule.name)).toContain("recursive-delete");
  });

  it("treats globs introduced by unquoted variables as dynamic", () => {
    fixture.env.TARGET = "*";
    const result = analyze("rm -rf $TARGET", fixture);
    expect(result.invocations[0]?.args[1]).toMatchObject({ dynamic: true });
    expect(matchingRules({ analysis: result }).map((rule) => rule.name)).toContain("recursive-delete");
  });

  it("does not use substitution commands as pipeline stages", () => {
    const result = analyze("curl https://example.test/script | echo \"$(bash -c 'true')\"", fixture);
    const nestedShell = result.invocations.find((invocation) => invocation.executable.literal === "bash");
    expect(nestedShell?.pipelineId).toBeUndefined();
    expect(matchingRules({ analysis: result }).map((rule) => rule.name)).not.toContain("curl-pipe-exec");
  });

  it("keeps quoted heredocs remote and unquoted substitutions local", () => {
    const remote = analyze("ssh host /bin/zsh <<'EOF'\ncd /etc\nrm -rf child\nEOF", fixture);
    const remoteRm = remote.invocations.find((invocation) => invocation.executable.literal === "rm");
    expect(remoteRm?.execution.kind).toBe("ssh");
    expect(remoteRm?.nestedKind).toBe("ssh-heredoc");
    expect(matchingRules({ analysis: remote }).map((rule) => rule.name)).toContain("recursive-delete");

    const local = analyze("ssh host /bin/sh <<EOF\n$(rm -rf /)\nEOF", fixture);
    const localRm = local.invocations.find((invocation) => invocation.executable.literal === "rm");
    expect(localRm?.execution.kind).toBe("local");
    expect(localRm?.nestedKind).toBe("command-substitution");
    expect(matchingRules({ analysis: local }).map((rule) => rule.name)).toContain("recursive-delete");
  });

  it("resolves env -S content in the outer expansion context, not the wrapper's own environment", () => {
    fixture.env.TARGET = "/etc";
    const prefixShadowed = analyze('TARGET=/tmp/safe env -S "rm -rf $TARGET"', fixture);
    expect(prefixShadowed.uncertainties).toEqual([]);
    expect(matchingRules({ analysis: prefixShadowed }).map((rule) => rule.name)).toEqual(expect.arrayContaining(["recursive-delete", "root-path-write"]));

    delete fixture.env.TARGET;
    const prefixOnly = analyze('TARGET=/etc env -S "rm -rf $TARGET"', fixture);
    expect(prefixOnly.uncertainties).toContain("env split-string command is dynamic or unresolved");
    expect(matchingRules({ analysis: prefixOnly }).map((rule) => rule.name)).toEqual(["analysis-uncertain"]);

    fixture.env.TARGET = "/etc";
    const attached = analyze('TARGET=/tmp/safe env -S"rm -rf $TARGET"', fixture);
    expect(matchingRules({ analysis: attached }).map((rule) => rule.name)).toEqual(expect.arrayContaining(["recursive-delete", "root-path-write"]));

    const longForm = analyze('TARGET=/tmp/safe env --split-string="rm -rf $TARGET"', fixture);
    expect(matchingRules({ analysis: longForm }).map((rule) => rule.name)).toEqual(expect.arrayContaining(["recursive-delete", "root-path-write"]));
  });

  it("invalidates cwd for cd -P/-L and other ambiguous cd invocations instead of leaving it stale", () => {
    for (const command of ["cd -P /etc; rm -rf child", "cd -L /etc; rm -rf child", "cd /etc /tmp; rm -rf child", "cd -; rm -rf child"]) {
      const result = analyze(command, fixture);
      const rm = result.invocations.find((invocation) => invocation.executable.literal === "rm");
      expect(rm?.cwd, command).toBeUndefined();
      expect(result.uncertainties, command).toContain("cd option or target is ambiguous or unsupported");
      expect(matchingRules({ analysis: result }).map((rule) => rule.name), command).toEqual(expect.arrayContaining(["analysis-uncertain", "recursive-delete"]));
    }

    const dashDash = analyze("cd -- /etc; rm -rf child", fixture);
    expect(dashDash.invocations.find((invocation) => invocation.executable.literal === "rm")?.cwd).toBe("/etc");
    expect(dashDash.uncertainties).toEqual([]);
  });

  it("still parses a literal remote payload when the SSH destination is dynamic", () => {
    const result = analyze('ssh "$HOST" \'rm -rf /\'', fixture);
    expect(result.uncertainties).toContain("SSH host is dynamic or unresolved");
    expect(result.invocations.map((invocation) => invocation.executable.literal)).toEqual(["ssh", "rm"]);
    expect(matchingRules({ analysis: result }).map((rule) => rule.name)).toEqual(expect.arrayContaining(["analysis-uncertain", "recursive-delete"]));
  });

  it("fails closed for dynamic or glob executables and shell payloads", () => {
    const globExecutable = analyze("./*.sh arg", fixture);
    expect(globExecutable.invocations[0]?.executable).toMatchObject({ literal: "./*.sh", dynamic: true });
    expect(globExecutable.uncertainties).toContain("executable is dynamic or unresolved");
    expect(matchingRules({ analysis: globExecutable }).map((rule) => rule.name)).toContain("analysis-uncertain");

    fixture.env.SCRIPT = "*.sh";
    const globPayload = analyze("bash -c $SCRIPT", fixture);
    expect(globPayload.uncertainties).toContain("shell payload is dynamic or unresolved");
    expect(matchingRules({ analysis: globPayload }).map((rule) => rule.name)).toContain("analysis-uncertain");
  });

  it("marks dynamic rule-relevant options for git/chmod/dd/npm as uncertain", () => {
    const cases = [
      ["git push $OPT origin main", "git option is dynamic or unresolved"],
      ["git $SUB push origin main", "git subcommand is dynamic or unresolved"],
      ["chmod $MODE file", "chmod mode is dynamic or unresolved"],
      ["chmod -R $MODE file", "chmod mode is dynamic or unresolved"],
      ["dd if=input $EXTRA", "dd argument is dynamic or unresolved"],
      ["npm install $PKG -g", "npm option is dynamic or unresolved"],
      ["npm $SUB install -g", "npm subcommand is dynamic or unresolved"],
    ] as const;
    for (const [command, reason] of cases) {
      const result = analyze(command, fixture);
      expect(result.uncertainties, command).toContain(reason);
      expect(matchingRules({ analysis: result }).map((rule) => rule.name), command).toContain("analysis-uncertain");
    }

    expect(analyze("chmod 644 file", fixture).uncertainties).toEqual([]);
    expect(analyze("git commit -m message", fixture).uncertainties).toEqual([]);
    expect(analyze("npm run build", fixture).uncertainties).toEqual([]);
    expect(analyze("dd if=input of=output.img", fixture).uncertainties).toEqual([]);
  });

  it("fails closed once the fallback tokenizer's own recursion cutoff is reached, without flagging unrelated malformed input", () => {
    const withinBudget = analyze('sudo '.repeat(5) + 'rm -rf / "', fixture);
    expect(withinBudget.uncertainties).toEqual([]);
    expect(matchingRules({ analysis: withinBudget }).map((rule) => rule.name)).toEqual(expect.arrayContaining(["recursive-delete", "root-path-write", "sudo"]));

    const beyondBudget = analyze('sudo '.repeat(6) + 'rm -rf / "', fixture);
    expect(beyondBudget.uncertainties).toContain("fallback recursion limit reached");
    expect(matchingRules({ analysis: beyondBudget }).map((rule) => rule.name)).toContain("analysis-uncertain");

    const benignBeyondBudget = analyze('sudo '.repeat(6) + 'echo hi "', fixture);
    expect(benignBeyondBudget.uncertainties).toContain("fallback recursion limit reached");

    const unrelatedMalformed = analyze('echo hello "', fixture);
    expect(unrelatedMalformed.uncertainties).toEqual([]);
    expect(matchingRules({ analysis: unrelatedMalformed })).toEqual([]);
  });
});
