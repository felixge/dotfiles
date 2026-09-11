import assert from "node:assert/strict";
import test from "node:test";
import { formatSearchResults, searchKagi } from "../search.ts";

test("searches Kagi and normalizes results", async () => {
  let requestedUrl: URL | undefined;
  let authorization: string | null = null;

  const details = await searchKagi("pi extensions", 3, {
    token: "secret",
    fetch: async (input, init) => {
      requestedUrl = new URL(input.toString());
      authorization = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({
        meta: { api_balance: 12.345, ms: 87 },
        data: [
          {
            t: 0,
            title: "Pi extensions",
            url: "https://example.com/pi",
            snippet: "  Build   custom tools. ",
            published: "2026-01-02T00:00:00Z",
          },
          { t: 0, title: "Missing URL" },
          { t: 1, list: ["pi tools", "custom pi extensions"] },
        ],
      }), { status: 200 });
    },
  });

  assert.equal(requestedUrl?.searchParams.get("q"), "pi extensions");
  assert.equal(requestedUrl?.searchParams.get("limit"), "3");
  assert.equal(authorization, "Bot secret");
  assert.deepEqual(details, {
    query: "pi extensions",
    results: [{
      title: "Pi extensions",
      url: "https://example.com/pi",
      snippet: "  Build   custom tools. ",
      published: "2026-01-02T00:00:00Z",
    }],
    relatedSearches: ["pi tools", "custom pi extensions"],
    apiBalance: 12.345,
    latencyMs: 87,
  });

  const output = formatSearchResults(details);
  assert.match(output, /^1\. Pi extensions/m);
  assert.match(output, /Build custom tools\./);
  assert.match(output, /Related searches: pi tools, custom pi extensions/);
});

test("requires a Kagi token", async () => {
  await assert.rejects(
    searchKagi("query", 10, { token: "" }),
    /KAGI_TOKEN is not set/,
  );
});

test("reports Kagi HTTP errors without unbounded response bodies", async () => {
  await assert.rejects(
    searchKagi("query", 10, {
      token: "secret",
      fetch: async () => new Response(`failure ${"x".repeat(2_000)}`, { status: 429 }),
    }),
    (error: Error) => {
      assert.match(error.message, /^Kagi API returned HTTP 429: failure/);
      assert.ok(error.message.length < 1_100);
      return true;
    },
  );
});
