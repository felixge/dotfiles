import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { extractWebPage, formatFetchResult, type FetchDetails } from "./fetch.ts";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  formatSearchResults,
  searchKagi,
  type SearchDetails,
} from "./search.ts";

const searchParameters = Type.Object({
  query: Type.String({ description: "The web search query", minLength: 1 }),
  limit: Type.Optional(
    Type.Integer({
      description: `Number of results to return, default ${DEFAULT_SEARCH_LIMIT}`,
      minimum: 1,
      maximum: MAX_SEARCH_LIMIT,
    }),
  ),
});

const fetchParameters = Type.Object({
  url: Type.String({
    description: "HTTP or HTTPS URL to fetch and extract as markdown",
    minLength: 1,
  }),
});

export default function webToolsExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: `Search the web with Kagi. Returns up to ${MAX_SEARCH_LIMIT} titles, URLs, publication dates, and snippets. Each call incurs an API charge, so reuse prior results when possible. Requires KAGI_TOKEN.`,
    promptSnippet: "Search the web using Kagi",
    promptGuidelines: [
      "Use web_search for current information, external references, or facts unavailable locally.",
      "Avoid redundant web_search calls because every search incurs an API charge.",
      "Use web_fetch when web_search snippets do not contain enough information.",
    ],
    parameters: searchParameters,
    async execute(_toolCallId, params, signal) {
      const details = await searchKagi(params.query, params.limit, { signal });
      return {
        content: [{ type: "text", text: formatSearchResults(details) }],
        details,
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("web_search "))}${theme.fg("accent", `"${args.query}"`)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);

      const details = result.details as SearchDetails | undefined;
      if (!details) return new Text(theme.fg("error", "Search failed"), 0, 0);

      let text = theme.fg("success", `${details.results.length} results`);
      if (details.latencyMs !== undefined) text += theme.fg("muted", ` in ${details.latencyMs}ms`);
      if (details.apiBalance !== undefined) {
        text += theme.fg("dim", `, balance $${details.apiBalance.toFixed(2)}`);
      }

      if (expanded) {
        for (const result of details.results) {
          text += `\n${theme.fg("accent", result.title)}`;
          text += `\n${theme.fg("dim", result.url)}`;
        }
      }

      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: `Fetch an HTTP or HTTPS URL and extract its main content as markdown using trafilatura, with curl and pandoc as fallback. The complete markdown is saved to a managed temporary file. Model-facing output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    promptSnippet: "Fetch a web page and extract its main content as markdown",
    promptGuidelines: [
      "Use web_fetch to inspect, summarize, quote, or extract details from a web page.",
      "Use read or grep on the temporary markdown path when web_fetch reports truncated content.",
    ],
    parameters: fetchParameters,
    async execute(_toolCallId, params, signal) {
      const page = await extractWebPage(
        params.url,
        (command, args, options) => pi.exec(command, args, options),
        signal,
      );
      const result = formatFetchResult(page);
      return {
        content: [{ type: "text", text: result.content }],
        details: result.details,
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("web_fetch "))}${theme.fg("accent", args.url)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0);

      const details = result.details as FetchDetails | undefined;
      if (!details) return new Text(theme.fg("error", "Fetch failed"), 0, 0);

      let summary = theme.fg("success", `${details.lines} lines, ${formatSize(details.bytes)}`);
      summary += theme.fg("muted", ` via ${details.extractor}`);
      if (details.truncation?.truncated) summary += theme.fg("warning", " (truncated)");
      if (!expanded) return new Text(summary, 0, 0);

      const container = new Container();
      container.addChild(new Text(summary, 0, 0));
      const content = result.content.find((item) => item.type === "text");
      if (content?.type === "text") {
        container.addChild(new Markdown(content.text, 0, 0, getMarkdownTheme()));
      }
      return container;
    },
  });
}
