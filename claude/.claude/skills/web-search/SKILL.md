---
name: web-search
description: Search the web via the Kagi Search API. Use when the user asks to search the web, look something up online, find current information, or needs external references/URLs.
---

# Web Search (Kagi)

Use the bundled `search.sh` script to query the Kagi Search API. The script reads the API token from the `KAGI_TOKEN` environment variable.

## Default Behavior

When this skill is invoked, **run a search immediately** with the user's query — don't explain the API or ask clarifying questions first. The user wants results.

## Usage

```bash
./search.sh "<query>"            # default: 10 results
./search.sh "<query>" 20         # custom result limit
./search.sh --json "<query>"     # raw JSON response
```

The script prints one result per block: title, URL, optional published date, and snippet. Related searches (Kagi object type `t=1`) are appended at the end when present.

## Examples

```bash
./search.sh "steve jobs biography"
./search.sh "jujutsu vcs tutorial" 5
./search.sh --json "datadog dash 2024 announcements" | jq '.data[] | select(.t==0) | .url'
```

## Fetching Result Pages

Search results only include titles, URLs, and snippets. When the user asks for details that aren't in the snippet (summarize, quote, extract, etc.), use the **web-fetch** skill on the relevant result URL(s) to get the full page as markdown without flooding the context with HTML.

## Notes

- Requires `KAGI_TOKEN` in the environment (Kagi Search API token, from <https://kagi.com/settings/api>).
- Each query costs ~$0.025 against the Kagi API balance, so avoid redundant calls — reuse prior results when possible.
- Kagi inherits per-account settings (blocked/promoted domains, snippet length) from the token's account.
- On HTTP errors the script prints the response body and exits non-zero.
