import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import webToolsExtension from "../index.ts";

test("registers only the web search and fetch tools", () => {
  const tools: Array<{ name: string; promptSnippet?: string }> = [];
  let commandCount = 0;
  const pi = {
    registerTool(tool: { name: string; promptSnippet?: string }) {
      tools.push(tool);
    },
    registerCommand() {
      commandCount += 1;
    },
  } as unknown as ExtensionAPI;

  webToolsExtension(pi);

  assert.deepEqual(tools.map((tool) => tool.name), ["web_search", "web_fetch"]);
  assert.ok(tools.every((tool) => tool.promptSnippet));
  assert.equal(commandCount, 0);
});
