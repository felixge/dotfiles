#!/usr/bin/env bash
# Query the Kagi Search API.
#
# Usage:
#   ./search.sh "<query>" [limit]
#   ./search.sh --json "<query>" [limit]
#
# Requires KAGI_TOKEN in the environment.

set -euo pipefail

json_output=0
if [[ "${1:-}" == "--json" ]]; then
  json_output=1
  shift
fi

if [[ $# -lt 1 || -z "${1:-}" ]]; then
  echo "usage: $0 [--json] <query> [limit]" >&2
  exit 2
fi

if [[ -z "${KAGI_TOKEN:-}" ]]; then
  echo "error: KAGI_TOKEN is not set" >&2
  exit 1
fi

query=$1
limit=${2:-10}

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

http_status=$(curl -sS \
  -H "Authorization: Bot ${KAGI_TOKEN}" \
  --get \
  --data-urlencode "q=${query}" \
  --data-urlencode "limit=${limit}" \
  -o "$tmp" \
  -w "%{http_code}" \
  "https://kagi.com/api/v0/search")

if [[ "$http_status" != "200" ]]; then
  echo "error: Kagi API returned HTTP $http_status" >&2
  cat "$tmp" >&2
  echo >&2
  exit 1
fi

if [[ $json_output -eq 1 ]]; then
  cat "$tmp"
  exit 0
fi

# Pretty-print: search results first, related searches last, plus a footer
# with API metadata (balance, latency).
jq -r '
  def fmt_result:
    "• \(.title)\n  \(.url)"
    + (if .published then "\n  published: \(.published)" else "" end)
    + (if .snippet then "\n  \(.snippet | gsub("\\s+"; " "))" else "" end);

  ((.data // []) | map(select(.t == 0)) | to_entries
    | map("\(.key + 1). \(.value | fmt_result)") | .[]),
  "",
  ((.data // []) | map(select(.t == 1)) | .[0].list // [] |
    if length > 0 then "Related searches: " + (map("\"" + . + "\"") | join(", "))
    else empty end),
  "",
  "— api_balance: $\(.meta.api_balance // "?"), time: \(.meta.ms // "?")ms"
' "$tmp"
