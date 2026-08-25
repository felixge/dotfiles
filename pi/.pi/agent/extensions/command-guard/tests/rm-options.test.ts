import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectRm } from "../paths.js";
import { analyzeCommand, localExecutionContext } from "../shell.js";
import { testFs, type TestFs } from "./helpers.js";

function recursive(command: string, fixture: TestFs): boolean {
  const analysis = analyzeCommand(command, localExecutionContext(fixture.cwd, fixture.env));
  return analysis.invocations.some((invocation) => inspectRm(invocation)?.recursive);
}

describe("recursive rm option parsing", () => {
  let fixture: TestFs;
  beforeEach(() => fixture = testFs());
  afterEach(() => fixture.cleanup());

  for (const command of [
    "rm -r target", "rm -R target", "rm -rf target", "rm -fr target", "rm -fR target",
    "rm -f -r target", "rm --recursive target", "rm target -r", "/bin/rm -rf target",
    "command rm -rf target", "env FOO=bar rm -rf target", "sudo rm -rf target",
  ]) {
    it(`recognizes ${command}`, () => expect(recursive(command, fixture)).toBe(true));
  }

  for (const command of [
    "rm target", "rm -f target", "rm --force target", "rm -- -rf", "rm path-with-r-and-f",
    "rm agent-session-persist-model-changes.test.ts", "docker rm -f container", "podman rm -f container",
    "pass rm -f entry", "echo rm -rf target", "printf '%s\\n' 'rm -rf target'",
  ]) {
    it(`rejects the false positive ${command}`, () => expect(recursive(command, fixture)).toBe(false));
  }

  it("does not leak options across command boundaries", () => {
    for (const command of ["rm file && grep -r needle .", "rm file; git branch -f topic", "rm file | grep -r needle"]) {
      expect(recursive(command, fixture)).toBe(false);
    }
  });

  it("walks executable command substitutions but not quoted examples or comments", () => {
    expect(recursive('echo "$(rm -rf /tmp/test)"', fixture)).toBe(true);
    expect(recursive("TARGET=$(rm -rf /tmp/test) true", fixture)).toBe(true);
    expect(recursive("cat < <(rm -rf /tmp/test)", fixture)).toBe(true);
    for (const command of ["printf 'rm -rf /\\n'", 'echo "rm -rf /"', "# rm -rf /", "true # rm -rf /"]) {
      expect(recursive(command, fixture)).toBe(false);
    }
  });
});
