import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
  type ExecOptions,
  type ExecResult,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";

const COMMAND_TIMEOUT_MS = 120_000;

export type CommandRunner = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

export interface FetchDetails {
  url: string;
  extractor: "trafilatura" | "curl+pandoc";
  outputPath: string;
  lines: number;
  bytes: number;
  truncation?: TruncationResult;
}

export interface ExtractedPage {
  markdown: string;
  details: FetchDetails;
}

export function validateWebUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }

  return url.href;
}

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.endsWith("\n")
    ? content.split("\n").length - 1
    : content.split("\n").length;
}

function commandError(command: string, result: ExecResult): string {
  const detail = result.stderr.replace(/\s+/g, " ").trim().slice(0, 1_000);
  return `${command} failed with exit code ${result.code}${detail ? `: ${detail}` : ""}`;
}

export async function extractWebPage(
  inputUrl: string,
  run: CommandRunner,
  signal?: AbortSignal,
): Promise<ExtractedPage> {
  const url = validateWebUrl(inputUrl);
  signal?.throwIfAborted();

  const tempDirectory = await mkdtemp(join(tmpdir(), "pi-web-fetch-"));
  const outputPath = join(tempDirectory, "page.md");
  const rawHtmlPath = join(tempDirectory, "page.html");

  try {
    return await withFileMutationQueue(outputPath, async () => {
      const trafilatura = await run(
        "trafilatura",
        ["-u", url, "--output-format", "markdown"],
        { signal, timeout: COMMAND_TIMEOUT_MS },
      );

      let markdown = trafilatura.code === 0 ? trafilatura.stdout.trim() : "";
      let extractor: FetchDetails["extractor"] = "trafilatura";

      if (!markdown) {
        const curl = await run(
          "curl",
          [
            "-sSL",
            "--compressed",
            "--connect-timeout",
            "15",
            "--max-time",
            "120",
            "-A",
            "Mozilla/5.0 (compatible; pi-web-fetch/1.0)",
            "-o",
            rawHtmlPath,
            "-w",
            "%{http_code}",
            url,
          ],
          { signal, timeout: COMMAND_TIMEOUT_MS },
        );

        if (curl.code !== 0) throw new Error(commandError("curl", curl));
        const status = curl.stdout.trim();
        if (!/^2\d\d$/.test(status)) {
          throw new Error(`curl returned HTTP ${status || "unknown"}`);
        }

        const pandoc = await run(
          "pandoc",
          ["-f", "html", "-t", "gfm-raw_html", "--wrap=none", rawHtmlPath],
          { signal, timeout: COMMAND_TIMEOUT_MS },
        );
        if (pandoc.code !== 0) throw new Error(commandError("pandoc", pandoc));

        markdown = pandoc.stdout.trim();
        extractor = "curl+pandoc";
      }

      if (!markdown) {
        const primaryError = trafilatura.stderr.replace(/\s+/g, " ").trim().slice(0, 1_000);
        throw new Error(
          `Web extraction produced no content${primaryError ? `; trafilatura: ${primaryError}` : ""}`,
        );
      }

      await writeFile(outputPath, `${markdown}\n`, "utf8");
      const savedMarkdown = await readFile(outputPath, "utf8");
      const bytes = Buffer.byteLength(savedMarkdown, "utf8");

      return {
        markdown: savedMarkdown,
        details: {
          url,
          extractor,
          outputPath,
          lines: lineCount(savedMarkdown),
          bytes,
        },
      };
    });
  } catch (error) {
    await rm(tempDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function formatFetchResult(page: ExtractedPage): {
  content: string;
  details: FetchDetails;
} {
  const truncation = truncateHead(page.markdown, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  const details: FetchDetails = { ...page.details };
  let content = truncation.content;

  if (truncation.truncated) {
    details.truncation = truncation;
    content += `\n\n[Content truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
    content += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
    content += ` Full markdown: ${details.outputPath}]`;
  } else {
    content += `\n[Full markdown: ${details.outputPath}]`;
  }

  return { content, details };
}

export async function removeExtractedPage(details: Pick<FetchDetails, "outputPath">): Promise<void> {
  await rm(dirname(details.outputPath), { recursive: true, force: true });
}
