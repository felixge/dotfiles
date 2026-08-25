import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchNames, testFs, type TestFs } from "./helpers.js";

describe("local recursive deletion paths", () => {
  let fixture: TestFs;
  beforeEach(() => fixture = testFs());
  afterEach(() => fixture.cleanup());

  it("allows literal project descendants and recognized temporary paths", () => {
    for (const command of [
      "rm -rf ./traces", "rm -rf traces/run-1", "rm -rf ./build ./dist", "rm -rf '*'", "rm -rf './*'",
      "rm -rf /tmp/pytorch-profiler", "rm -rf /private/tmp/pytorch-profiler", "rm -rf \"$TMPDIR/pytorch-profiler\"",
      "rm -rf /var/folders/aa/bb/T/pytorch-profiler", "rm -rf agent-session-persist-model-changes.test.ts",
    ]) {
      expect(matchNames(command, fixture), command).not.toContain("recursive-delete");
    }
  });

  it("blocks root, home, cwd, ancestors, sensitive, external, glob, and unresolved targets", () => {
    for (const command of [
      "rm -rf /", "rm -rf ~", 'rm -rf "$HOME"', "rm -rf .", "rm -rf ..", 'rm -rf "$PWD"',
      "rm -rf /etc/example", "rm -rf /usr/local/example", "rm -rf /var/lib/example", "rm -rf /some/external/directory",
      "rm -rf *", "rm -rf .*", 'rm -rf "$UNKNOWN_TARGET"', 'rm -rf "$(compute_target)"',
      "rm -rf /tmp", "rm -rf /private/tmp", 'rm -rf "$TMPDIR"', 'rm -rf "${HOME%/*}"',
    ]) {
      expect(matchNames(command, fixture), command).toContain("recursive-delete");
    }
  });

  it("allows a final symlink but blocks intermediate symlink escapes", () => {
    fs.symlinkSync("/etc", path.join(fixture.cwd, "final-link"));
    fs.symlinkSync("/etc", path.join(fixture.cwd, "escape"));
    expect(matchNames("rm -rf final-link", fixture)).not.toContain("recursive-delete");
    expect(matchNames("rm -rf escape/child", fixture)).toContain("recursive-delete");
    expect(matchNames("rm -rf escape/missing/child", fixture)).toContain("recursive-delete");
  });

  it("does not treat a relative TMPDIR as safe", () => {
    fixture.env.TMPDIR = "relative-temp";
    expect(matchNames("rm -rf /some/external/relative-temp/child", fixture)).toContain("recursive-delete");
  });

  it("protects home dotfiles but not dotted project or temporary descendants", () => {
    expect(matchNames("rm ~/.ssh/config", fixture)).toContain("home-dotfile-delete");
    expect(matchNames("rm -f ~/.config/tool/config", fixture)).toContain("home-dotfile-delete");
    expect(matchNames("rm -rf ~/.password-store/Datadog", fixture)).toContain("home-dotfile-delete");
    expect(matchNames("rm -rf ./fixtures/.cache", fixture)).not.toContain("home-dotfile-delete");
    expect(matchNames("rm -rf /tmp/test/.state", fixture)).not.toContain("home-dotfile-delete");
  });
});
