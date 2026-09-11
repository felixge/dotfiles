export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 20;

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  published?: string;
}

export interface SearchDetails {
  query: string;
  results: SearchResult[];
  relatedSearches: string[];
  apiBalance?: number;
  latencyMs?: number;
}

interface KagiSearchResponse {
  meta?: {
    api_balance?: unknown;
    ms?: unknown;
  };
  data?: unknown;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseResponse(payload: KagiSearchResponse, query: string): SearchDetails {
  const data = Array.isArray(payload.data) ? payload.data : [];
  const results: SearchResult[] = [];
  const relatedSearches: string[] = [];

  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;

    if (entry.t === 0) {
      const title = optionalString(entry.title);
      const url = optionalString(entry.url);
      if (!title || !url) continue;

      results.push({
        title,
        url,
        snippet: optionalString(entry.snippet),
        published: optionalString(entry.published),
      });
      continue;
    }

    if (entry.t === 1 && Array.isArray(entry.list)) {
      for (const value of entry.list) {
        const related = optionalString(value);
        if (related) relatedSearches.push(related);
      }
    }
  }

  return {
    query,
    results,
    relatedSearches,
    apiBalance: optionalNumber(payload.meta?.api_balance),
    latencyMs: optionalNumber(payload.meta?.ms),
  };
}

export async function searchKagi(
  query: string,
  limit = DEFAULT_SEARCH_LIMIT,
  options: {
    token?: string;
    signal?: AbortSignal;
    fetch?: typeof fetch;
  } = {},
): Promise<SearchDetails> {
  const token = options.token ?? process.env.KAGI_TOKEN;
  if (!token) throw new Error("KAGI_TOKEN is not set");

  const endpoint = new URL("https://kagi.com/api/v0/search");
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("limit", String(limit));

  const response = await (options.fetch ?? fetch)(endpoint, {
    headers: { Authorization: `Bot ${token}` },
    signal: options.signal,
  });
  const body = await response.text();

  if (!response.ok) {
    const summary = body.replace(/\s+/g, " ").trim().slice(0, 1_000);
    throw new Error(`Kagi API returned HTTP ${response.status}${summary ? `: ${summary}` : ""}`);
  }

  let payload: KagiSearchResponse;
  try {
    payload = JSON.parse(body) as KagiSearchResponse;
  } catch {
    throw new Error("Kagi API returned invalid JSON");
  }

  return parseResponse(payload, query);
}

export function formatSearchResults(details: SearchDetails): string {
  const blocks = details.results.map((result, index) => {
    const lines = [`${index + 1}. ${result.title}`, `   ${result.url}`];
    if (result.published) lines.push(`   Published: ${result.published}`);
    if (result.snippet) lines.push(`   ${result.snippet.replace(/\s+/g, " ").trim()}`);
    return lines.join("\n");
  });

  if (blocks.length === 0) blocks.push(`No results found for: ${details.query}`);
  if (details.relatedSearches.length > 0) {
    blocks.push(`Related searches: ${details.relatedSearches.join(", ")}`);
  }

  return blocks.join("\n\n");
}
