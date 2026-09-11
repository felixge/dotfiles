import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import {
  extractWebPage,
  formatFetchResult,
  removeExtractedPage,
  validateWebUrl,
  type CommandRunner,
  type ExtractedPage,
} from "../fetch.ts";

function result(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    killed: false,
    ...overrides,
  };
}

test("validates web URLs while allowing private addresses", () => {
  assert.equal(validateWebUrl("http://localhost:8080/docs"), "http://localhost:8080/docs");
  assert.equal(validateWebUrl("http://127.0.0.1/status"), "http://127.0.0.1/status");
  assert.throws(() => validateWebUrl("file:///etc/passwd"), /Unsupported URL protocol/);
  assert.throws(() => validateWebUrl("not a url"), /Invalid URL/);
});

test("extracts markdown with trafilatura", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    return result({ stdout: "# Title\n\nArticle body\n" });
  };

  const page = await extractWebPage("https://example.com/article", run);
  try {
    assert.equal(page.markdown, "# Title\n\nArticle body\n");
    assert.equal(page.details.extractor, "trafilatura");
    assert.equal(page.details.lines, 3);
    assert.deepEqual(calls.map((call) => call.command), ["trafilatura"]);
    assert.deepEqual(calls[0].args, [
      "-u",
      "https://example.com/article",
      "--output-format",
      "markdown",
    ]);
  } finally {
    await removeExtractedPage(page.details);
  }
});

test("falls back to curl and pandoc when trafilatura is empty", async () => {
  const calls: string[] = [];
  const run: CommandRunner = async (command, args) => {
    calls.push(command);
    if (command === "trafilatura") return result({ code: 1, stderr: "no content" });
    if (command === "curl") {
      const outputIndex = args.indexOf("-o");
      await writeFile(args[outputIndex + 1], "<html><body>Fallback</body></html>", "utf8");
      return result({ stdout: "200" });
    }
    if (command === "pandoc") return result({ stdout: "# Fallback\n\nConverted body\n" });
    throw new Error(`Unexpected command: ${command}`);
  };

  const page = await extractWebPage("https://example.com/fallback", run);
  try {
    assert.equal(page.details.extractor, "curl+pandoc");
    assert.equal(page.markdown, "# Fallback\n\nConverted body\n");
    assert.deepEqual(calls, ["trafilatura", "curl", "pandoc"]);
  } finally {
    await removeExtractedPage(page.details);
  }
});

test("reports failed fallback HTTP responses", async () => {
  const run: CommandRunner = async (command) => {
    if (command === "trafilatura") return result();
    if (command === "curl") return result({ stdout: "403" });
    throw new Error(`Unexpected command: ${command}`);
  };

  await assert.rejects(
    extractWebPage("https://example.com/blocked", run),
    /curl returned HTTP 403/,
  );
});

test("truncates model-facing content and preserves the full path", () => {
  const markdown = Array.from({ length: 2_500 }, (_, index) => `line ${index + 1}`).join("\n");
  const page: ExtractedPage = {
    markdown,
    details: {
      url: "https://example.com/large",
      extractor: "trafilatura",
      outputPath: "/tmp/pi-web-fetch-test/page.md",
      lines: 2_500,
      bytes: Buffer.byteLength(markdown),
    },
  };

  const formatted = formatFetchResult(page);

  assert.equal(formatted.details.truncation?.truncated, true);
  assert.match(formatted.content, /Content truncated/);
  assert.match(formatted.content, /Full markdown: \/tmp\/pi-web-fetch-test\/page\.md/);
  assert.ok(formatted.content.length < markdown.length);
});
