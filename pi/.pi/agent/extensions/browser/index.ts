import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import MarkdownIt from "markdown-it";
import { createHighlighter } from "shiki";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

type BrowserHighlighter = Awaited<ReturnType<typeof createHighlighter>>;

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

interface ToolInteraction {
  id: string;
  name: string;
  kind: string;
  summary: string;
  requestHtml: string;
  responseHtml?: string;
  isError?: boolean;
}

interface AssistantExchange {
  index: number;
  userMarkdown?: string;
  userHtml?: string;
  tools: ToolInteraction[];
  assistantHtml: string;
  title: string;
}

function messageText(message: any): string | undefined {
  if (typeof message?.content === "string") return message.content.trim() || undefined;
  if (!Array.isArray(message?.content)) return undefined;

  const text = message.content
    .filter((block: any) => block?.type === "text" && block.text)
    .map((block: any) => block.text)
    .join("\n\n")
    .trim();

  return text || undefined;
}

function summarize(markdown: string | undefined): string {
  if (!markdown) return "Assistant response";
  return markdown.replace(/\s+/g, " ").trim().slice(0, 96) || "Assistant response";
}

function toolEventsBetween(branch: any[], fromExclusive: number, toExclusive: number): ToolInteraction[] {
  const tools: ToolInteraction[] = [];
  const byId = new Map<string, ToolInteraction>();

  for (let i = fromExclusive + 1; i < toExclusive; i++) {
    const entry = branch[i];
    if (entry.type !== "message") continue;
    const message = entry.message;

    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const item of message.content) {
        if (item?.type !== "toolCall") continue;
        const name = item.name ?? "tool";
        const rendered = toolRequestHtml(name, item.arguments ?? {});
        const tool = { id: item.id ?? `${name}-${tools.length}`, name, kind: toolKind(name), summary: rendered.summary, requestHtml: rendered.html };
        tools.push(tool);
        byId.set(tool.id, tool);
      }
    }

    if (message?.role === "toolResult") {
      const id = message.toolCallId ?? `${message.toolName}-${tools.length}`;
      let tool = byId.get(id);
      if (!tool) {
        const name = message.toolName ?? "tool";
        tool = { id, name, kind: toolKind(name), summary: name, requestHtml: `<span class="muted">Call details unavailable</span>` };
        tools.push(tool);
        byId.set(id, tool);
      }
      tool.responseHtml = toolResponseHtml(message);
      tool.isError = Boolean(message.isError);
    }
  }

  return tools;
}

function allAssistantExchanges(ctx: ExtensionContext, md: MarkdownIt): AssistantExchange[] {
  const branch = ctx.sessionManager.getBranch();
  const exchanges: AssistantExchange[] = [];

  for (let i = 0; i < branch.length; i++) {
    const entry = branch[i];
    if (entry.type !== "message") continue;

    const message = (entry as any).message;
    if (message?.role !== "assistant") continue;

    const assistantMarkdown = messageText(message);
    if (!assistantMarkdown) continue;

    let userMarkdown: string | undefined;
    let userIndex = -1;
    for (let j = i - 1; j >= 0; j--) {
      const prevEntry = branch[j];
      if (prevEntry.type !== "message") continue;
      const prevMessage = (prevEntry as any).message;
      if (prevMessage?.role !== "user") continue;
      userMarkdown = messageText(prevMessage);
      userIndex = j;
      break;
    }

    exchanges.push({
      index: exchanges.length + 1,
      userMarkdown,
      userHtml: userMarkdown ? md.render(userMarkdown) : undefined,
      tools: userIndex >= 0 ? toolEventsBetween(branch, userIndex, i) : [],
      assistantHtml: md.render(assistantMarkdown),
      title: summarize(userMarkdown ?? assistantMarkdown),
    });
  }

  return exchanges;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function htmlDocument(exchanges: AssistantExchange[]): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>pi assistant responses</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; line-height: 1.5; font-family: system-ui, sans-serif; color: #1f2328; background: #ffffff; }
    .app { display: grid; grid-template-columns: 320px minmax(0, 1fr); min-height: 100vh; }
    .sidebar { position: sticky; top: 0; height: 100vh; overflow: auto; padding: 1rem; background: linear-gradient(180deg, #f6f8fa 0%, #fff 100%); border-right: 1px solid #d8dee4; }
    .brand { font-weight: 800; font-size: 1.05rem; margin-bottom: 0.2rem; }
    .meta { color: #57606a; font-size: 0.85rem; margin-bottom: 0.8rem; }
    .filter { width: 100%; padding: 0.65rem 0.75rem; margin: 0.5rem 0 0.9rem; border: 1px solid #d0d7de; border-radius: 10px; font: inherit; background: #fff; }
    .nav { display: flex; flex-direction: column; gap: 0.45rem; }
    .nav-item { width: 100%; text-align: left; cursor: pointer; border: 1px solid transparent; background: transparent; border-radius: 12px; padding: 0.7rem 0.75rem; color: #24292f; }
    .nav-item:hover { background: #ffffff; border-color: #d8dee4; }
    .nav-item.active { background: #ffffff; border-color: #0969da; box-shadow: 0 1px 2px rgba(27,31,36,.04), 0 6px 18px rgba(9,105,218,.10); }
    .nav-number { color: #0969da; font-weight: 800; font-size: 0.8rem; margin-bottom: 0.25rem; }
    .nav-title { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: 0.9rem; }
    .content { max-width: 920px; width: min(100%, 920px); justify-self: center; padding: 2rem 2.5rem 4rem; }
    .topline { color: #57606a; font-size: 0.9rem; margin-bottom: 1rem; }
    pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { overflow-x: auto; }
    img { max-width: 100%; }
    :not(pre) > code { background: #f6f8fa; border: 1px solid #d8dee4; border-radius: 4px; padding: 0.12em 0.32em; }
    .shiki { overflow-x: auto; margin: 1.25rem 0; padding: 1rem 1.125rem; border: 1px solid #d0d7de; border-radius: 10px; box-shadow: 0 1px 2px rgba(27,31,36,.06), 0 8px 24px rgba(140,149,159,.14); }
    .message { margin: 1.5rem 0; }
    .message-label { color: #57606a; font-size: 0.82rem; font-weight: 700; letter-spacing: 0.04em; margin-bottom: 0.5rem; text-transform: uppercase; }
    .user-message { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 12px; padding: 1rem 1.125rem; }
    .assistant-message { border-top: 1px solid #d8dee4; padding-top: 1.25rem; }
    .tools { margin: 1.25rem 0; }
    .tool { --tool: #0969da; --tool-bg: #ddf4ff; border: 1px solid color-mix(in srgb, var(--tool) 28%, #d8dee4); border-left: 5px solid var(--tool); border-radius: 12px; margin: 0.7rem 0; background: #fff; overflow: hidden; box-shadow: 0 1px 2px rgba(27,31,36,.04); }
    .tool summary { cursor: pointer; padding: 0.75rem 0.95rem; color: #24292f; font-weight: 700; list-style-position: inside; background: linear-gradient(90deg, var(--tool-bg), #fff 62%); }
    .tool-read { --tool: #0969da; --tool-bg: #ddf4ff; }
    .tool-write { --tool: #8250df; --tool-bg: #fbefff; }
    .tool-bash { --tool: #1a7f37; --tool-bg: #dafbe1; }
    .tool-web { --tool: #bf8700; --tool-bg: #fff8c5; }
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
    @media (max-width: 800px) { .app { grid-template-columns: 1fr; } .sidebar { position: static; height: auto; max-height: 45vh; } .content { padding: 1.25rem; } }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="brand">pi browser</div>
      <div class="meta">${exchanges.length} assistant exchange${exchanges.length === 1 ? "" : "s"} · latest selected</div>
      <input id="filter" class="filter" placeholder="Filter prompts… (press /)" autocomplete="off">
      <nav id="nav" class="nav"></nav>
    </aside>
    <main class="content">
      <div id="topline" class="topline"></div>
      <div id="exchange"></div>
    </main>
  </div>
  <script>
    const exchanges = ${safeJson(exchanges)};
    let filtered = exchanges.map((_, i) => i);
    let selected = exchanges.length - 1;
    const nav = document.getElementById('nav');
    const pane = document.getElementById('exchange');
    const filter = document.getElementById('filter');
    const topline = document.getElementById('topline');

    function escapeText(value) {
      const span = document.createElement('span');
      span.textContent = value;
      return span.innerHTML;
    }

    function renderNav() {
      nav.innerHTML = '';
      for (const idx of filtered) {
        const ex = exchanges[idx];
        const btn = document.createElement('button');
        btn.className = 'nav-item' + (idx === selected ? ' active' : '');
        btn.innerHTML = '<div class="nav-number">#' + ex.index + '</div><div class="nav-title"></div>';
        btn.querySelector('.nav-title').textContent = ex.title;
        btn.onclick = () => select(idx);
        nav.appendChild(btn);
      }
    }

    function select(idx) {
      selected = idx;
      const ex = exchanges[idx];
      topline.textContent = 'Exchange #' + ex.index + ' of ' + exchanges.length;
      const toolsHtml = ex.tools.length
        ? '<section class="tools"><div class="message-label">Tool calls</div>' + ex.tools.map((tool) =>
            '<details class="tool tool-' + escapeText(tool.kind) + (tool.isError ? ' tool-error' : '') + '"><summary>' + escapeText(tool.summary) + '<span class="tool-badge">' + escapeText(tool.isError ? tool.name + ' error' : tool.name) + '</span></summary><div class="tool-body"><div class="tool-section"><div class="tool-field">Call</div>' + tool.requestHtml + '</div><div class="tool-section"><div class="tool-field">Result</div>' + (tool.responseHtml || '<span class="muted">No result captured</span>') + '</div></div></details>'
          ).join('') + '</section>'
        : '';
      pane.innerHTML = (ex.userHtml ? '<section class="message user-message"><div class="message-label">User</div>' + ex.userHtml + '</section>' : '')
        + toolsHtml
        + '<section class="message assistant-message"><div class="message-label">Assistant</div>' + ex.assistantHtml + '</section>';
      renderNav();
      document.querySelector('.nav-item.active')?.scrollIntoView({ block: 'nearest' });
    }

    function applyFilter() {
      const q = filter.value.trim().toLowerCase();
      filtered = exchanges.map((_, i) => i).filter(i => !q || exchanges[i].title.toLowerCase().includes(q));
      if (!filtered.includes(selected) && filtered.length) selected = filtered[filtered.length - 1];
      renderNav();
    }

    filter.addEventListener('input', applyFilter);
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== filter) { e.preventDefault(); filter.focus(); return; }
      if (e.key === 'Escape' && document.activeElement === filter) { filter.value = ''; filter.blur(); applyFilter(); return; }
      if (!['ArrowDown', 'j', 'ArrowUp', 'k'].includes(e.key) || document.activeElement === filter) return;
      e.preventDefault();
      const pos = filtered.indexOf(selected);
      if (pos < 0) return;
      const next = e.key === 'ArrowDown' || e.key === 'j' ? Math.min(filtered.length - 1, pos + 1) : Math.max(0, pos - 1);
      select(filtered[next]);
    });

    select(selected);
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

async function openLatestAssistantResponse(ctx: ExtensionContext & { waitForIdle?: () => Promise<void> }, md: MarkdownIt) {
  await ctx.waitForIdle?.();

  const exchanges = allAssistantExchanges(ctx, md);
  if (exchanges.length === 0) {
    ctx.ui.notify("No assistant response found.", "warning");
    return;
  }

  const dir = join(tmpdir(), "pi-browser");
  mkdirSync(dir, { recursive: true });

  const file = join(dir, `assistant-responses-${Date.now()}.html`);
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
    description: "Open the latest assistant response as rendered HTML in the browser",
    handler: async (_args, ctx) => openLatestAssistantResponse(ctx, md),
  });

  pi.registerShortcut("ctrl+h", {
    description: "Open latest assistant response in the browser",
    handler: async (ctx) => openLatestAssistantResponse(ctx, md),
  });
}
