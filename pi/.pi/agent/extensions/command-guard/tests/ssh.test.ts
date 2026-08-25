import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeCommand, localExecutionContext } from "../shell.js";
import { matchNames, testFs, type TestFs } from "./helpers.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

describe("SSH command analysis", () => {
  let fixture: TestFs;
  beforeEach(() => fixture = testFs());
  afterEach(() => fixture.cleanup());

  it("allows the PyTorch profiler deployment and cleanup commands", () => {
    const commands = [
      "ssh workspace-felix-gpu 'set -e; rm -rf /tmp/pytorch-profiler; mkdir -p /tmp/pytorch-profiler'",
      "ssh workspace-felix-gpu 'set -e; cd /tmp/pytorch-profiler; rm -rf traces; uv run main.py'",
      "ssh workspace-felix-gpu 'set -e; cd /tmp/pytorch-profiler; rm -f traces/01_matmul_add/output.*'",
      "ssh workspace-felix-gpu 'set -e; cd /home/bits/dd-trace-c; rm -rf build; make autoinstrument'",
      "ssh workspace-felix-gpu 'set -e; rm -rf /home/bits/dd-trace-c; mkdir -p /home/bits/dd-trace-c'",
      "ssh workspace-felix-gpu 'set -e; rm -rf \"$HOME/dd-trace-c\"; mkdir -p \"$HOME/dd-trace-c\"'",
      "ssh workspace-felix-gpu 'docker rm -f dd-agent-gpu-profiler >/dev/null 2>&1 || true'",
      "ssh -o BatchMode=yes -o ConnectTimeout=15 workspace-felix-gpu 'rm -rf /tmp/test'",
      "tar -czf - . | ssh workspace-felix-gpu 'rm -rf /tmp/test; mkdir -p /tmp/test; tar -xzf - -C /tmp/test'",
      "ssh workspace-felix-gpu rm -rf /tmp/test",
      "ssh user@host 'cd /tmp && rm -rf child'",
    ];
    for (const command of commands) expect(matchNames(command, fixture), command).not.toContain("recursive-delete");
  });

  it("blocks dangerous remote targets", () => {
    const commands = [
      "ssh host 'rm -rf /'", "ssh host 'rm -rf ~'", "ssh host 'rm -rf \"$HOME\"'",
      "ssh host 'rm -rf /etc/example'", "ssh host 'rm -rf /usr/local/example'", "ssh host 'rm -rf /var/lib/example'",
      "ssh host 'rm -rf /tmp'", "ssh host 'rm -rf \"$TMPDIR\"'",
      "ssh host 'rm -rf *'", "ssh host 'rm -rf .*'", "ssh host 'rm -rf \"$UNKNOWN_TARGET\"'",
      "ssh host 'sudo rm -rf /opt/example'", "ssh host 'bash -c '\\''rm -rf /'\\'''",
    ];
    for (const command of commands) expect(matchNames(command, fixture), command).toContain("recursive-delete");
    expect(matchNames("ssh host 'sudo rm -rf /opt/example'", fixture)).toEqual(expect.arrayContaining(["sudo", "recursive-delete"]));
  });

  it("parses a quoted heredoc only for an explicitly invoked remote shell", () => {
    const command = "ssh host /bin/zsh <<'EOF'\ncd /tmp\nrm -rf child\nEOF";
    expect(matchNames(command, fixture)).not.toContain("recursive-delete");
    const tar = "tar -czf - . | ssh host 'tar -xzf - -C /tmp/test'";
    const analysis = analyzeCommand(tar, localExecutionContext(fixture.cwd, fixture.env));
    expect(analysis.invocations.filter((invocation) => invocation.execution.kind === "ssh").map((invocation) => invocation.executable.literal)).toEqual(["tar"]);
  });

  it("keeps local and remote expansion domains separate", () => {
    const remoteExpansion = analyzeCommand("ssh host 'rm -rf \"$HOME/test\"'", localExecutionContext(fixture.cwd, fixture.env));
    const remoteRm = remoteExpansion.invocations.find((invocation) => invocation.execution.kind === "ssh" && invocation.executable.literal === "rm");
    expect(remoteRm?.args[1]?.parts).toContainEqual(expect.objectContaining({ kind: "parameter", name: "HOME" }));

    const localExpansion = analyzeCommand('ssh host "rm -rf $HOME/test"', localExecutionContext(fixture.cwd, fixture.env));
    const localRm = localExpansion.invocations.find((invocation) => invocation.execution.kind === "ssh" && invocation.executable.literal === "rm");
    expect(localRm?.args[1]?.literal).toBe(`${fixture.home}/test`);
  });

  it("passes wrapper assignments to nested remote shells", () => {
    const prefixedSource = `ssh host ${shellQuote(`TARGET=/etc sh -c 'rm -rf "$TARGET/child"'`)}`;
    const prefixed = analyzeCommand(prefixedSource, localExecutionContext(fixture.cwd, fixture.env));
    const prefixedRm = prefixed.invocations.find((invocation) => invocation.execution.kind === "ssh" && invocation.executable.literal === "rm");
    expect(prefixedRm?.execution).toMatchObject({ env: { TARGET: "/etc" } });
    expect(matchNames(prefixedSource, fixture)).toContain("recursive-delete");

    const wrappedSource = `ssh host ${shellQuote(`env TARGET=/etc sh -c 'rm -rf "$TARGET/child"'`)}`;
    const wrapped = analyzeCommand(wrappedSource, localExecutionContext(fixture.cwd, fixture.env));
    const wrappedRm = wrapped.invocations.find((invocation) => invocation.execution.kind === "ssh" && invocation.executable.literal === "rm");
    expect(wrappedRm?.execution).toMatchObject({ env: { TARGET: "/etc" } });
    expect(matchNames(wrappedSource, fixture)).toContain("recursive-delete");
  });

  it("tracks remote cd without leaking subshell and pipeline changes", () => {
    const cases = [
      ["ssh host 'cd /tmp/project; rm -rf traces'", { kind: "absolute", value: "/tmp/project" }],
      ["ssh host 'cd /tmp/project && rm -rf traces'", { kind: "absolute", value: "/tmp/project" }],
      ["ssh host '(cd /tmp/project); rm -rf traces'", { kind: "home", value: "" }],
      ["ssh host 'cd /tmp/project | cat; rm -rf traces'", { kind: "home", value: "" }],
    ] as const;
    for (const [command, cwd] of cases) {
      const analysis = analyzeCommand(command, localExecutionContext(fixture.cwd, fixture.env));
      const rm = analysis.invocations.find((invocation) => invocation.execution.kind === "ssh" && invocation.executable.literal === "rm");
      expect(rm?.cwd, command).toEqual(cwd);
    }
    expect(matchNames("ssh host 'cd /etc; rm -rf child'", fixture)).toContain("recursive-delete");
    expect(matchNames("ssh host 'cd \"$UNKNOWN\"; rm -rf child'", fixture)).toContain("recursive-delete");

    const unresolved = analyzeCommand("ssh host 'D=$(printf /etc); cd \"$D\"; rm -rf child'", localExecutionContext(fixture.cwd, fixture.env));
    const unresolvedRm = unresolved.invocations.find((invocation) => invocation.execution.kind === "ssh" && invocation.executable.literal === "rm");
    expect(unresolvedRm?.cwd).toEqual({ kind: "unknown" });
    expect(unresolved.uncertainties).toContain("cd directory is dynamic or unresolved");

    const conditional = analyzeCommand("ssh host 'if true; then cd /etc; fi; rm -rf child'", localExecutionContext(fixture.cwd, fixture.env));
    const conditionalRm = conditional.invocations.find((invocation) => invocation.execution.kind === "ssh" && invocation.executable.literal === "rm");
    expect(conditionalRm?.cwd).toEqual({ kind: "unknown" });
    expect(conditional.uncertainties).toContain("cwd may change across compound control flow");
    expect(matchNames("ssh host 'if true; then cd /etc; fi; rm -rf child'", fixture)).toContain("recursive-delete");
  });

  it("still analyzes a literal remote payload when the destination host is dynamic", () => {
    const analysis = analyzeCommand('ssh "$HOST" \'rm -rf /\'', localExecutionContext(fixture.cwd, fixture.env));
    expect(analysis.uncertainties).toContain("SSH host is dynamic or unresolved");
    expect(analysis.invocations.map((invocation) => invocation.executable.literal)).toEqual(["ssh", "rm"]);
    expect(matchNames('ssh "$HOST" \'rm -rf /\'', fixture)).toEqual(expect.arrayContaining(["analysis-uncertain", "recursive-delete"]));
  });

  it("protects remote home dotfiles without treating nested dotted names as home dotfiles", () => {
    expect(matchNames("ssh host 'rm -rf ~/.password-store/Datadog'", fixture)).toContain("home-dotfile-delete");
    expect(matchNames("ssh host 'rm -rf ~/project/.cache'", fixture)).not.toContain("home-dotfile-delete");
  });
});
