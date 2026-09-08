import assert from "node:assert/strict";
import test from "node:test";
import MarkdownIt from "markdown-it";
import { buildConversationExchanges, htmlDocument } from "../index.ts";

const md = new MarkdownIt();

function message(role: string, content: unknown, extra: Record<string, unknown> = {}) {
  return { type: "message", message: { role, content, ...extra } };
}

test("starts exchanges only for user messages", () => {
  const branch = [
    message("user", "First request"),
    message("assistant", [
      { type: "text", text: "I will inspect it." },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
      { type: "text", text: "Waiting for the result." },
    ]),
    message("toolResult", [{ type: "text", text: "file contents" }], {
      toolCallId: "call-1",
      toolName: "read",
      isError: false,
    }),
    message("assistant", [{ type: "text", text: "The file looks good." }]),
    { type: "branch_summary", summary: "The inactive branch tried another approach." },
    message("user", "Second request"),
    message("assistant", [{ type: "text", text: "Second response." }]),
  ];

  const exchanges = buildConversationExchanges(branch, md);

  assert.equal(exchanges.length, 2);
  assert.equal(exchanges[0].userMarkdown, "First request");
  assert.deepEqual(exchanges[0].items.map((item) => item.type), [
    "assistant",
    "tool",
    "assistant",
    "assistant",
    "context",
  ]);
  const toolItem = exchanges[0].items[1];
  assert.equal(toolItem.type, "tool");
  if (toolItem.type === "tool") {
    assert.match(toolItem.tool.responseHtml ?? "", /file contents/);
  }
  assert.equal(exchanges[1].userMarkdown, "Second request");
  assert.equal(exchanges[1].items.length, 1);
});

test("does not create an exchange for assistant messages before the first user", () => {
  const exchanges = buildConversationExchanges([
    message("assistant", [{ type: "text", text: "Preamble" }]),
    { type: "branch_summary", summary: "Earlier branch" },
    message("user", "Actual request"),
    message("assistant", [{ type: "text", text: "Actual response" }]),
  ], md);

  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].userMarkdown, "Actual request");
  assert.doesNotMatch(exchanges[0].items[0].type === "assistant" ? exchanges[0].items[0].html : "", /Preamble/);
});

test("starts an exchange for a user message without text", () => {
  const exchanges = buildConversationExchanges([
    message("user", [{ type: "image", data: "base64", mimeType: "image/png" }]),
    message("assistant", [{ type: "text", text: "I can see the image." }]),
  ], md);

  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].title, "User message");
  assert.match(exchanges[0].userHtml, /without text content/);
});

test("renders all exchanges in one transcript with user-message anchors", () => {
  const exchanges = buildConversationExchanges([
    message("user", "First request"),
    message("assistant", [{ type: "text", text: "First response" }]),
    message("user", "Second request"),
    message("assistant", [{ type: "text", text: "Second response" }]),
  ], md);

  const html = htmlDocument(exchanges);

  assert.match(html, /2 user exchanges · active branch/);
  assert.match(html, /href="#exchange-1"/);
  assert.match(html, /href="#exchange-2"/);
  assert.match(html, /<article class="exchange" id="exchange-1"/);
  assert.match(html, /<article class="exchange" id="exchange-2"/);
  assert.match(html, /First response/);
  assert.match(html, /Second response/);
  assert.doesNotMatch(html, /let selected/);
  assert.doesNotMatch(html, /id="exchange">/);
});
