import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { finalAssistantAnswer, loadHistory, trimDanglingToolCalls } from "../index.ts";

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });

const assistant = (
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AgentMessage => ({
  role: "assistant",
  content,
  api: "test",
  provider: "test",
  model: "test",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: 2,
});

const assistantWithTool = (id: string): AgentMessage =>
  assistant([{ type: "toolCall", id, name: "read", arguments: { path: "x.ts" } }], "toolUse");

test("trimDanglingToolCalls removes an in-flight tool batch", () => {
  const messages = [user("question"), assistantWithTool("call-1")];
  assert.deepEqual(trimDanglingToolCalls(messages), [messages[0]]);
});

test("trimDanglingToolCalls keeps a completed tool batch", () => {
  const messages: AgentMessage[] = [
    user("question"),
    assistantWithTool("call-1"),
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "contents" }],
      isError: false,
      timestamp: 3,
    },
  ];
  assert.deepEqual(trimDanglingToolCalls(messages), messages);
});

test("trimDanglingToolCalls does not truncate after an old malformed batch", () => {
  const messages = [
    user("first"),
    assistantWithTool("missing"),
    user("later"),
    assistant([{ type: "text", text: "valid answer" }]),
  ];
  assert.deepEqual(trimDanglingToolCalls(messages), messages);
});

test("finalAssistantAnswer requires a successful final response", () => {
  const messages = [
    assistant([{ type: "text", text: "tool preamble" }], "toolUse"),
    assistant([{ type: "text", text: "provider failed" }], "error"),
  ];
  assert.throws(() => finalAssistantAnswer(messages), /stopped with error/);
});

test("finalAssistantAnswer returns the final successful text", () => {
  assert.equal(finalAssistantAnswer([assistant([{ type: "text", text: "answer" }])]), "answer");
});

test("loadHistory returns only valid btw entries", () => {
  const entries = [
    {
      type: "custom",
      id: "one",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "btw-history",
      data: { question: "q", answer: "a", createdAt: 1, model: "p/m" },
    },
    {
      type: "custom",
      id: "two",
      parentId: "one",
      timestamp: new Date().toISOString(),
      customType: "other",
      data: { question: "ignored", answer: "ignored", createdAt: 2, model: "p/m" },
    },
  ] as SessionEntry[];

  assert.deepEqual(loadHistory(entries), [{ question: "q", answer: "a", createdAt: 1, model: "p/m" }]);
});
