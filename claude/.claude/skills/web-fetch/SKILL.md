---
name: web-fetch
description: Fetch a URL and convert it to clean markdown using trafilatura, writing the result to a file to avoid polluting the context window with HTML. Use when the user asks to fetch, read, scrape, summarize, or extract content from a web page.
---

# Web Fetch (trafilatura)

Use the bundled `fetch.sh` script to fetch a URL and convert it to markdown via [trafilatura](https://trafilatura.readthedocs.io/). The script writes the result to a file so raw HTML never flows into the context window.

## Default Behavior

When this skill is invoked, **fetch immediately** with the URL the user provided — don't ask for clarifications. After fetching, decide whether to `read` the file in full or use `head`/`rg` to extract only the relevant section based on the user's request.

## Usage

```bash
./fetch.sh <url>                    # markdown → /tmp/web-fetch-<hash>.md
./fetch.sh <url> <output-path>      # markdown → <output-path>
./fetch.sh --format txt <url>       # plain text instead of markdown
./fetch.sh --format html <url>      # cleaned/minified HTML (for structured scraping)
./fetch.sh --stdout <url>           # print to stdout (use only for known-small pages)
```

On success the script prints the output path, line count, and which extractor was used (`trafilatura` or `curl+pandoc`). Always check the line count before reading — large pages should be read with `offset`/`limit` or filtered with `rg`.

## Extraction Strategy

1. **Primary: trafilatura** — clean article extraction, strips nav/sidebars/ads/footers.
2. **Fallback: `curl` + `pandoc -f html -t gfm-raw_html --wrap=none`** — triggered automatically when trafilatura returns empty (e.g. Jekyll/minimalist blogs, pages whose DOM trafilatura's heuristics don't like). For `--format html` the fallback just writes the raw HTML.

Both extractors run transparently; the caller doesn't need to retry. If the fallback also produces nothing, the page is likely JS-rendered (SPA) or blocked — the script exits non-zero with a diagnostic.

## Examples

```bash
./fetch.sh "https://en.wikipedia.org/wiki/Markdown"
./fetch.sh "https://blog.example.com/post" /tmp/post.md
./fetch.sh --format txt "https://news.ycombinator.com/item?id=12345"
```

Typical follow-up pattern:

```bash
./fetch.sh "$URL"                          # note the printed path, e.g. /tmp/web-fetch-ab12cd.md
rg -n 'installation|install' /tmp/web-fetch-ab12cd.md   # find relevant section
# then: read the file with offset/limit around the match
```

## Notes

- Requires `trafilatura` on `PATH` (installed via Homebrew in `install.bash`).
- `trafilatura -o` expects a **directory**, not a file — the wrapper uses shell redirection internally to avoid this footgun.
- Trafilatura strips boilerplate (nav, sidebars, ads, footers) and keeps only article content. For pages where that's too aggressive (e.g. docs indexes, forum threads), the `curl+pandoc` fallback preserves more structure — or use `--format html` to get raw HTML for structured scraping.
- If both extractors yield empty output, the page is likely JS-rendered (SPA). Trafilatura and pandoc can't execute JS — in that case tell the user and suggest an alternative (e.g. a reader-mode URL, the chrome-devtools MCP, or a specific API).
- Fallback requires `pandoc` (for markdown/txt). Installed via Homebrew.
- Never pipe raw HTML to stdout in a tool call — it will flood the context. Always write to a file first.
