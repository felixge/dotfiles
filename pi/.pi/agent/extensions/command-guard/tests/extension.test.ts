import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ALLOW_ONCE } from "../guard.js";
import commandGuardExtension from "../index.js";

describe("command guard extension audit entries", () => {
  it("appends a non-context custom entry for a triggered command", async () => {
    let toolCallHandler: ((event: any, context: any) => Promise<unknown>) | undefined;
    const appendEntry = vi.fn();
    const pi = {
      appendEntry,
      events: { emit: vi.fn() },
      on: vi.fn((event: string, handler: (event: any, context: any) => Promise<unknown>) => {
        if (event === "tool_call") toolCallHandler = handler;
      }),
    } as unknown as ExtensionAPI;
    commandGuardExtension(pi);

    expect(toolCallHandler).toBeDefined();
    await toolCallHandler?.({
      toolName: "bash",
      toolCallId: "call-1",
      input: { command: "code=$?" },
    }, {
      cwd: "/tmp/project",
      hasUI: true,
      abort: vi.fn(),
      ui: { select: vi.fn(async () => ALLOW_ONCE) },
    });

    expect(appendEntry).toHaveBeenCalledOnce();
    expect(appendEntry.mock.calls[0]?.[0]).toBe("command-guard-audit");
    expect(appendEntry.mock.calls[0]?.[1]).toMatchObject({
      version: 1,
      toolCallId: "call-1",
      command: "code=$?",
      cwd: "/tmp/project",
      decision: "allow-once",
      uncertainties: ["assignment value is dynamic or unresolved"],
      parseFailures: ["code=$?"],
    });
    expect(appendEntry.mock.calls[0]?.[1].analyzerHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
