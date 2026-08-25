import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALLOW_ALL, ALLOW_ONCE, BLOCK, CommandGuard } from "../guard.js";
import { testFs, type TestFs } from "./helpers.js";

describe("per-rule approvals", () => {
  let fixture: TestFs;
  beforeEach(() => fixture = testFs());
  afterEach(() => fixture.cleanup());

  function context(choice: string | undefined) {
    return {
      cwd: fixture.cwd,
      env: fixture.env,
      hasUI: true,
      abort: vi.fn(),
      choose: vi.fn(async (_title: string, _options: string[]) => choice),
    };
  }

  it("allows once without changing the allow set and prompts again", async () => {
    const guard = new CommandGuard();
    const first = context(ALLOW_ONCE);
    expect(await guard.handle("rm -rf /", first)).toBeUndefined();
    expect(guard.allowedRules.size).toBe(0);
    const second = context(BLOCK);
    expect(await guard.handle("rm -rf /", second)).toMatchObject({ block: true });
    expect(second.choose).toHaveBeenCalledOnce();
  });

  it("allows all displayed rules and suppresses only those rules", async () => {
    const guard = new CommandGuard();
    const approve = context(ALLOW_ALL);
    await guard.handle("sudo rm -rf /opt/example", approve);
    expect(guard.allowedRules).toEqual(new Set(["recursive-delete", "root-path-write", "sudo"]));
    const noPrompt = context(BLOCK);
    expect(await guard.handle("sudo true", noPrompt)).toBeUndefined();
    expect(noPrompt.choose).not.toHaveBeenCalled();

    const unapproved = context(BLOCK);
    await guard.handle("sudo chmod 777 file", unapproved);
    expect(unapproved.choose).toHaveBeenCalledOnce();
    expect(unapproved.choose.mock.calls[0]?.[0]).toContain("Setting world-writable");
    expect(unapproved.choose.mock.calls[0]?.[0]).not.toContain("Running command with sudo");
  });

  it("applies a recursive-delete approval across local and SSH hosts", async () => {
    const guard = new CommandGuard();
    await guard.handle("ssh first 'rm -rf /'", context(ALLOW_ALL));
    for (const command of ["rm -rf /", "ssh second 'rm -rf /'"]) {
      const next = context(BLOCK);
      expect(await guard.handle(command, next)).toBeUndefined();
      expect(next.choose).not.toHaveBeenCalled();
    }
  });

  it("does not make approval implications between rules", async () => {
    const guard = new CommandGuard();
    await guard.handle("sudo true", context(ALLOW_ALL));
    const recursive = context(BLOCK);
    await guard.handle("sudo rm -rf /", recursive);
    expect(recursive.choose.mock.calls[0]?.[0]).toContain("High-risk recursive file deletion");
    expect(recursive.choose.mock.calls[0]?.[0]).not.toContain("Running command with sudo");
  });

  it("blocks and aborts on block, cancel, or dismissal", async () => {
    for (const choice of [BLOCK, undefined]) {
      const guard = new CommandGuard();
      const ctx = context(choice);
      expect(await guard.handle("rm -rf /", ctx)).toMatchObject({ block: true });
      expect(ctx.abort).toHaveBeenCalledOnce();
    }
  });

  it("starts each extension instance empty", async () => {
    const first = new CommandGuard();
    await first.handle("sudo true", context(ALLOW_ALL));
    expect(first.allowedRules.has("sudo")).toBe(true);
    expect(new CommandGuard().allowedRules.size).toBe(0);
  });

  it("fails closed without UI and never calls a dialog", async () => {
    const guard = new CommandGuard();
    const choose = vi.fn();
    const result = await guard.handle("rm -rf /", {
      cwd: fixture.cwd,
      env: fixture.env,
      hasUI: false,
      choose,
      abort: vi.fn(),
    });
    expect(result).toMatchObject({ block: true });
    expect(choose).not.toHaveBeenCalled();
  });
});
