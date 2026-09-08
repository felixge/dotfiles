import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import MarkdownIt from "markdown-it";
import { createHighlighter } from "shiki";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

type BrowserHighlighter = Awaited<ReturnType<typeof createHighlighter>>;
type MarkdownRenderer = Pick<MarkdownIt, "render">;

const bundledLanguages = [
  "bash",
  "css",
  "diff",
  "go",
  "html",
  "ini",
  "java",
  "javascript",
  "json",
  "jsonc",
  "lua",
  "markdown",
  "python",
  "ruby",
  "rust",
  "shellscript",
  "sql",
  "toml",
  "tsx",
  "typescript",
  "viml",
  "xml",
  "yaml",
] as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function block(value: string): string {
  return `<pre><code>${escapeHtml(value)}</code></pre>`;
}

function jsonBlock(value: unknown): string {
  return block(JSON.stringify(value, null, 2) ?? "");
}

function toolRequestHtml(name: string, args: any): { summary: string; html: string } {
  switch (name) {
    case "bash":
      return { summary: args?.command?.split("\n")[0] || "Run shell command", html: `<div class="tool-field">Command</div>${block(args?.command ?? "")}` };
    case "read":
      return { summary: `Read ${args?.path ?? "file"}`, html: `<div class="tool-field">Path</div>${block(args?.path ?? "")}` };
    case "write":
      return { summary: `Write ${args?.path ?? "file"}`, html: `<div class="tool-field">Path</div>${block(args?.path ?? "")}<div class="tool-field">Content</div>${block(args?.content ?? "")}` };
    case "edit":
      return { summary: `Edit ${args?.path ?? "file"}`, html: `<div class="tool-field">Path</div>${block(args?.path ?? "")}<div class="tool-field">Edits</div>${jsonBlock(args?.edits ?? [])}` };
    default:
      return { summary: name, html: `<div class="tool-field">Arguments</div>${jsonBlock(args ?? {})}` };
  }
}

function toolKind(name: string): string {
  switch (name) {
    case "bash":
      return "bash";
    case "read":
      return "read";
    case "write":
    case "edit":
      return "write";
    default:
      return "default";
  }
}

function messageText(message: any): string | undefined {
  if (typeof message?.content === "string") return message.content.trim() || undefined;
  if (!Array.isArray(message?.content)) return undefined;

  const text = message.content
    .filter((item: any) => item?.type === "text" && item.text)
    .map((item: any) => item.text)
    .join("\n\n")
    .trim();

  return text || undefined;
}

function toolResponseHtml(message: any): string {
  const text = messageText(message);
  const parts: string[] = [];
  if (text) parts.push(`<div class="tool-field">Response</div>${block(text)}`);
  if (message?.details !== undefined && Object.keys(message.details ?? {}).length > 0) {
    parts.push(`<details class="tool-raw"><summary>Details</summary>${jsonBlock(message.details)}</details>`);
  }
  return parts.join("") || `<span class="muted">No response content</span>`;
}

function createMarkdownRenderer(highlighter: BrowserHighlighter): MarkdownIt {
  return new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    highlight(source, language): string {
      const lang = language?.trim() || "text";
      try {
        return highlighter.codeToHtml(source, { lang, theme: "github-light" });
      } catch {
        return `<pre><code>${escapeHtml(source)}</code></pre>`;
      }
    },
  });
}

export interface ToolInteraction {
  id: string;
  name: string;
  kind: string;
  summary: string;
  requestHtml: string;
  responseHtml?: string;
  isError?: boolean;
}

export type ExchangeItem =
  | { type: "assistant"; html: string }
  | { type: "tool"; tool: ToolInteraction }
  | { type: "context"; label: string; html: string };

export interface ConversationExchange {
  index: number;
  anchor: string;
  userMarkdown: string;
  userHtml: string;
  items: ExchangeItem[];
  title: string;
}

function summarize(markdown: string): string {
  return markdown.replace(/\s+/g, " ").trim().slice(0, 96) || "User message";
}

function appendAssistantContent(
  exchange: ConversationExchange,
  message: any,
  md: MarkdownRenderer,
  toolsById: Map<string, ToolInteraction>,
): void {
  if (typeof message?.content === "string") {
    const markdown = message.content.trim();
    if (markdown) exchange.items.push({ type: "assistant", html: md.render(markdown) });
    return;
  }
  if (!Array.isArray(message?.content)) return;

  let text: string[] = [];
  const flushText = () => {
    const markdown = text.join("\n\n").trim();
    text = [];
    if (markdown) exchange.items.push({ type: "assistant", html: md.render(markdown) });
  };

  for (const item of message.content) {
    if (item?.type === "text" && item.text) {
      text.push(item.text);
      continue;
    }
    if (item?.type !== "toolCall") continue;

    flushText();
    const name = item.name ?? "tool";
    const rendered = toolRequestHtml(name, item.arguments ?? {});
    const tool: ToolInteraction = {
      id: item.id ?? `${name}-${exchange.items.length}`,
      name,
      kind: toolKind(name),
      summary: rendered.summary,
      requestHtml: rendered.html,
    };
    exchange.items.push({ type: "tool", tool });
    toolsById.set(tool.id, tool);
  }
  flushText();
}

export function buildConversationExchanges(branch: any[], md: MarkdownRenderer): ConversationExchange[] {
  const exchanges: ConversationExchange[] = [];
  let current: ConversationExchange | undefined;
  let toolsById = new Map<string, ToolInteraction>();

  for (const entry of branch) {
    if (entry.type === "branch_summary") {
      if (current && typeof entry.summary === "string" && entry.summary.trim()) {
        current.items.push({ type: "context", label: "Branch context", html: md.render(entry.summary.trim()) });
      }
      continue;
    }
    if (entry.type !== "message") continue;

    const message = entry.message;
    if (message?.role === "user") {
      const userMarkdown = messageText(message) ?? "";
      const index = exchanges.length + 1;
      current = {
        index,
        anchor: `exchange-${index}`,
        userMarkdown,
        userHtml: userMarkdown ? md.render(userMarkdown) : `<p class="muted">User message without text content</p>`,
        items: [],
        title: summarize(userMarkdown),
      };
      exchanges.push(current);
      toolsById = new Map();
      continue;
    }
    if (!current) continue;

    if (message?.role === "assistant") {
      appendAssistantContent(current, message, md, toolsById);
      continue;
    }
    if (message?.role !== "toolResult") continue;

    const id = message.toolCallId ?? `${message.toolName}-${current.items.length}`;
    let tool = toolsById.get(id);
    if (!tool) {
      const name = message.toolName ?? "tool";
      tool = {
        id,
        name,
        kind: toolKind(name),
        summary: name,
        requestHtml: `<span class="muted">Call details unavailable</span>`,
      };
      current.items.push({ type: "tool", tool });
      toolsById.set(id, tool);
    }
    tool.responseHtml = toolResponseHtml(message);
    tool.isError = Boolean(message.isError);
  }

  return exchanges;
}

function toolHtml(tool: ToolInteraction): string {
  return `<details class="tool tool-${tool.kind}${tool.isError ? " tool-error" : ""}"><summary>${escapeHtml(tool.summary)}<span class="tool-badge">${escapeHtml(tool.isError ? `${tool.name} error` : tool.name)}</span></summary><div class="tool-body"><div class="tool-section"><div class="tool-field">Call</div>${tool.requestHtml}</div><div class="tool-section"><div class="tool-field">Result</div>${tool.responseHtml || '<span class="muted">No result captured</span>'}</div></div></details>`;
}

function exchangeHtml(exchange: ConversationExchange): string {
  const items = exchange.items.map((item) => {
    if (item.type === "assistant") {
      return `<section class="message assistant-message"><div class="message-label">Assistant</div>${item.html}</section>`;
    }
    if (item.type === "context") {
      return `<aside class="context-message"><div class="message-label">${escapeHtml(item.label)}</div>${item.html}</aside>`;
    }
    return `<section class="tools">${toolHtml(item.tool)}</section>`;
  }).join("");

  return `<article class="exchange" id="${exchange.anchor}" data-exchange="${exchange.index}"><section class="message user-message"><div class="message-label">User</div>${exchange.userHtml}</section>${items}</article>`;
}

export function htmlDocument(exchanges: ConversationExchange[]): string {
  const exchangeLabel = `${exchanges.length} user exchange${exchanges.length === 1 ? "" : "s"}`;
  const nav = exchanges.map((exchange) => `<a class="nav-item" href="#${exchange.anchor}" data-anchor="${exchange.anchor}" data-title="${escapeHtml(exchange.title.toLowerCase())}"><div class="nav-number">#${exchange.index}</div><div class="nav-title">${escapeHtml(exchange.title)}</div></a>`).join("");
  const transcript = exchanges.map(exchangeHtml).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>pi conversation</title>
  <style>
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; line-height: 1.5; font-family: system-ui, sans-serif; color: #1f2328; background: #ffffff; }
    .app { display: grid; grid-template-columns: 320px minmax(0, 1fr); min-height: 100vh; }
    .sidebar { position: sticky; top: 0; height: 100vh; overflow: auto; padding: 1rem; background: linear-gradient(180deg, #f6f8fa 0%, #fff 100%); border-right: 1px solid #d8dee4; }
    .brand { font-weight: 800; font-size: 1.05rem; margin-bottom: 0.2rem; }
    .meta { color: #57606a; font-size: 0.85rem; margin-bottom: 0.8rem; }
    .filter { width: 100%; padding: 0.65rem 0.75rem; margin: 0.5rem 0 0.9rem; border: 1px solid #d0d7de; border-radius: 10px; font: inherit; background: #fff; }
    .nav { display: flex; flex-direction: column; gap: 0.45rem; }
    .nav-item { width: 100%; text-align: left; text-decoration: none; border: 1px solid transparent; background: transparent; border-radius: 12px; padding: 0.7rem 0.75rem; color: #24292f; }
    .nav-item:hover { background: #ffffff; border-color: #d8dee4; }
    .nav-item.active { background: #ffffff; border-color: #0969da; box-shadow: 0 1px 2px rgba(27,31,36,.04), 0 6px 18px rgba(9,105,218,.10); }
    .nav-number { color: #0969da; font-weight: 800; font-size: 0.8rem; margin-bottom: 0.25rem; }
    .nav-title { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: 0.9rem; }
    .content { max-width: 920px; width: min(100%, 920px); justify-self: center; padding: 2rem 2.5rem 4rem; }
    .topline { color: #57606a; font-size: 0.9rem; margin-bottom: 1rem; }
    .exchange { scroll-margin-top: 1.5rem; padding-bottom: 2rem; }
    .exchange + .exchange { border-top: 2px solid #d8dee4; padding-top: 1.5rem; }
    pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { overflow-x: auto; }
    img { max-width: 100%; }
    :not(pre) > code { background: #f6f8fa; border: 1px solid #d8dee4; border-radius: 4px; padding: 0.12em 0.32em; }
    .shiki { overflow-x: auto; margin: 1.25rem 0; padding: 1rem 1.125rem; border: 1px solid #d0d7de; border-radius: 10px; box-shadow: 0 1px 2px rgba(27,31,36,.06), 0 8px 24px rgba(140,149,159,.14); }
    .message { margin: 1.5rem 0; }
    .message-label { color: #57606a; font-size: 0.82rem; font-weight: 700; letter-spacing: 0.04em; margin-bottom: 0.5rem; text-transform: uppercase; }
    .user-message { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 12px; padding: 1rem 1.125rem; }
    .assistant-message { border-top: 1px solid #d8dee4; padding-top: 1.25rem; }
    .context-message { margin: 1.25rem 0; padding: 0.9rem 1rem; border-left: 4px solid #8250df; background: #fbefff; border-radius: 0 10px 10px 0; }
    .context-message > :last-child, .message > :last-child { margin-bottom: 0; }
    .tools { margin: 1.25rem 0; }
    .tool { --tool: #0969da; --tool-bg: #ddf4ff; border: 1px solid color-mix(in srgb, var(--tool) 28%, #d8dee4); border-left: 5px solid var(--tool); border-radius: 12px; margin: 0.7rem 0; background: #fff; overflow: hidden; box-shadow: 0 1px 2px rgba(27,31,36,.04); }
    .tool summary { cursor: pointer; padding: 0.75rem 0.95rem; color: #24292f; font-weight: 700; list-style-position: inside; background: linear-gradient(90deg, var(--tool-bg), #fff 62%); }
    .tool-read { --tool: #0969da; --tool-bg: #ddf4ff; }
    .tool-write { --tool: #8250df; --tool-bg: #fbefff; }
    .tool-bash { --tool: #1a7f37; --tool-bg: #dafbe1; }
    .tool-default { --tool: #57606a; --tool-bg: #f6f8fa; }
    .tool-badge { float: right; color: var(--tool); background: #fff; border: 1px solid color-mix(in srgb, var(--tool) 30%, #d8dee4); border-radius: 999px; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; margin-left: 1rem; padding: 0.13rem 0.48rem; }
    .tool-error { --tool: #cf222e; --tool-bg: #ffebe9; }
    .tool-body { border-top: 1px solid #d8dee4; background: #f6f8fa; }
    .tool-section { padding: 0.85rem 0.95rem; }
    .tool-section + .tool-section { border-top: 1px solid #d8dee4; }
    .tool-field { color: #57606a; font-size: 0.78rem; font-weight: 800; letter-spacing: 0.04em; margin: 0.2rem 0 0.35rem; text-transform: uppercase; }
    .tool-body pre { margin: 0 0 0.65rem; padding: 0.75rem; background: #fff; border: 1px solid #d8dee4; border-radius: 8px; white-space: pre-wrap; }
    .tool-raw { margin-top: 0.5rem; }
    .tool-raw summary { padding: 0.25rem 0; color: #57606a; font-size: 0.9rem; }
    .muted { color: #57606a; }
    [hidden] { display: none !important; }
    @media (max-width: 800px) { .app { grid-template-columns: 1fr; } .sidebar { position: static; height: auto; max-height: 45vh; } .content { padding: 1.25rem; } .exchange { scroll-margin-top: 1rem; } }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="brand">pi browser</div>
      <div class="meta">${exchangeLabel} · active branch</div>
      <input id="filter" class="filter" placeholder="Filter prompts… (press /)" autocomplete="off">
      <nav id="nav" class="nav">${nav}</nav>
    </aside>
    <main class="content">
      <div class="topline">${exchangeLabel} on the active branch</div>
      <div id="transcript">${transcript}</div>
    </main>
  </div>
  <script>
    const filter = document.getElementById('filter');
    const navItems = Array.from(document.querySelectorAll('.nav-item'));
    const exchanges = Array.from(document.querySelectorAll('.exchange'));

    function setActive(anchor) {
      for (const item of navItems) item.classList.toggle('active', item.dataset.anchor === anchor);
      document.querySelector('.nav-item.active')?.scrollIntoView({ block: 'nearest' });
    }

    function applyFilter() {
      const query = filter.value.trim().toLowerCase();
      for (const item of navItems) item.hidden = Boolean(query) && !item.dataset.title.includes(query);
    }

    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible.length) setActive(visible[0].target.id);
    }, { rootMargin: '-10% 0px -75% 0px' });
    for (const exchange of exchanges) observer.observe(exchange);

    for (const item of navItems) item.addEventListener('click', () => setActive(item.dataset.anchor));
    filter.addEventListener('input', applyFilter);
    document.addEventListener('keydown', (event) => {
      if (event.key === '/' && document.activeElement !== filter) { event.preventDefault(); filter.focus(); return; }
      if (event.key === 'Escape' && document.activeElement === filter) { filter.value = ''; filter.blur(); applyFilter(); return; }
      if (!['ArrowDown', 'j', 'ArrowUp', 'k'].includes(event.key) || document.activeElement === filter) return;
      const visible = navItems.filter((item) => !item.hidden);
      if (!visible.length) return;
      event.preventDefault();
      const current = visible.findIndex((item) => item.classList.contains('active'));
      const delta = event.key === 'ArrowDown' || event.key === 'j' ? 1 : -1;
      const next = Math.max(0, Math.min(visible.length - 1, (current < 0 ? 0 : current) + delta));
      visible[next].click();
    });

    setActive(location.hash.slice(1) || exchanges[0]?.id);
  </script>
</body>
</html>
`;
}

function openFile(file: string): void {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", file] : [file];

  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function openConversation(ctx: ExtensionContext & { waitForIdle?: () => Promise<void> }, md: MarkdownIt) {
  await ctx.waitForIdle?.();

  const exchanges = buildConversationExchanges(ctx.sessionManager.getBranch(), md);
  if (exchanges.length === 0) {
    ctx.ui.notify("No user exchange found.", "warning");
    return;
  }

  const dir = join(tmpdir(), "pi-browser");
  mkdirSync(dir, { recursive: true });

  const file = join(dir, `conversation-${Date.now()}.html`);
  writeFileSync(file, htmlDocument(exchanges), "utf8");

  openFile(file);
  ctx.ui.notify(`Opened ${file}`, "info");
}

export default async function (pi: ExtensionAPI) {
  const highlighter = await createHighlighter({
    themes: ["github-light"],
    langs: [...bundledLanguages],
  });
  const md = createMarkdownRenderer(highlighter);

  pi.registerCommand("browser", {
    description: "Open the active conversation branch as rendered HTML in the browser",
    handler: async (_args, ctx) => openConversation(ctx, md),
  });

  pi.registerShortcut("ctrl+h", {
    description: "Open the active conversation branch in the browser",
    handler: async (ctx) => openConversation(ctx, md),
  });
}
