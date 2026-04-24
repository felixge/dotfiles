#!/usr/bin/env bash
# Fetch a URL and convert it to markdown (or text/html) via trafilatura,
# with a curl+pandoc fallback for pages where trafilatura's extraction
# heuristics produce empty output.
#
# Usage:
#   ./fetch.sh <url> [output-path]
#   ./fetch.sh --format <markdown|txt|html> <url> [output-path]
#   ./fetch.sh --stdout <url>
#
# Output defaults to /tmp/web-fetch-<hash>.<ext>. On success, prints the
# output path, line count, and which extractor was used. Writes to a file
# (not stdout) by default so that raw HTML or large pages never flood the
# caller's context window.

set -euo pipefail

format="markdown"
to_stdout=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --format)
      format="${2:-}"
      shift 2
      ;;
    --format=*)
      format="${1#--format=}"
      shift
      ;;
    --stdout)
      to_stdout=1
      shift
      ;;
    -h|--help)
      sed -n '2,14p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "error: unknown flag: $1" >&2
      exit 2
      ;;
    *)
      break
      ;;
  esac
done

if [[ $# -lt 1 || -z "${1:-}" ]]; then
  echo "usage: $0 [--format markdown|txt|html] [--stdout] <url> [output-path]" >&2
  exit 2
fi

url=$1
out_path=${2:-}

case "$format" in
  markdown) ext="md" ;;
  txt)      ext="txt" ;;
  html)     ext="html" ;;
  *)
    echo "error: --format must be one of: markdown, txt, html (got: $format)" >&2
    exit 2
    ;;
esac

if ! command -v trafilatura >/dev/null 2>&1; then
  echo "error: trafilatura not found on PATH. Install with: brew install trafilatura" >&2
  exit 1
fi

# Determine output path. For --stdout we still write to a temp file so the
# fallback path works uniformly; we cat it at the end.
stdout_tmp=""
if [[ $to_stdout -eq 1 ]]; then
  stdout_tmp=$(mktemp -t web-fetch.XXXXXX)
  out_path=$stdout_tmp
elif [[ -z "$out_path" ]]; then
  # Hash the URL so repeated fetches of the same page reuse the same file.
  hash=$(printf '%s' "$url" | shasum -a 256 | cut -c1-12)
  out_path="/tmp/web-fetch-${hash}.${ext}"
fi

# Guard: if the caller passed a path that already exists as a directory,
# trafilatura would happily dump numbered files inside it. Refuse.
if [[ -d "$out_path" ]]; then
  echo "error: output path is a directory: $out_path" >&2
  exit 2
fi

tmp_err=$(mktemp)
cleanup() {
  rm -f "$tmp_err"
  [[ -n "$stdout_tmp" ]] && rm -f "$stdout_tmp"
  return 0  # don't let short-circuit above leak into script exit status
}
trap cleanup EXIT

# --- Step 1: try trafilatura ------------------------------------------------
extractor="trafilatura"
trafilatura -u "$url" --output-format "$format" >"$out_path" 2>"$tmp_err" || {
  status=$?
  # Trafilatura can exit non-zero on network errors; surface and bail. The
  # fallback below uses curl, so a hard network failure there will also fail,
  # but we still want to try it in case this was a trafilatura-specific bug.
  echo "note: trafilatura failed (exit $status), trying curl+pandoc fallback" >&2
  [[ -s "$tmp_err" ]] && sed 's/^/  /' "$tmp_err" >&2
  : >"$out_path"
}

# --- Step 2: fall back to curl + pandoc/raw if extraction was empty --------
if [[ ! -s "$out_path" ]]; then
  extractor="curl+pandoc"
  : >"$tmp_err"

  if ! command -v curl >/dev/null 2>&1; then
    echo "error: curl not found, cannot run fallback" >&2
    exit 1
  fi

  raw_html=$(mktemp -t web-fetch-raw.XXXXXX)
  # shellcheck disable=SC2064
  trap "cleanup; rm -f '$raw_html'; true" EXIT

  http_status=$(curl -sSL --compressed \
    -A 'Mozilla/5.0 (compatible; web-fetch/1.0)' \
    -o "$raw_html" \
    -w '%{http_code}' \
    "$url" 2>"$tmp_err" || true)

  if [[ ! -s "$raw_html" ]] || [[ "$http_status" =~ ^[45] ]]; then
    echo "error: fallback curl failed (HTTP ${http_status:-?})" >&2
    [[ -s "$tmp_err" ]] && sed 's/^/  /' "$tmp_err" >&2
    rm -f "$out_path"
    exit 1
  fi

  case "$format" in
    markdown)
      if ! command -v pandoc >/dev/null 2>&1; then
        echo "error: pandoc not found, cannot convert HTML to markdown" >&2
        echo "hint:  brew install pandoc" >&2
        exit 1
      fi
      pandoc -f html -t gfm-raw_html --wrap=none "$raw_html" -o "$out_path" 2>"$tmp_err"
      ;;
    txt)
      if ! command -v pandoc >/dev/null 2>&1; then
        echo "error: pandoc not found, cannot convert HTML to text" >&2
        echo "hint:  brew install pandoc" >&2
        exit 1
      fi
      pandoc -f html -t plain --wrap=none "$raw_html" -o "$out_path" 2>"$tmp_err"
      ;;
    html)
      # No extraction available; just save the raw HTML.
      cp "$raw_html" "$out_path"
      extractor="curl (raw html)"
      ;;
  esac

  if [[ ! -s "$out_path" ]]; then
    echo "error: fallback produced an empty file" >&2
    [[ -s "$tmp_err" ]] && sed 's/^/  /' "$tmp_err" >&2
    rm -f "$out_path"
    exit 1
  fi
fi

# --- Output ----------------------------------------------------------------
if [[ $to_stdout -eq 1 ]]; then
  cat "$out_path"
  exit 0
fi

lines=$(wc -l <"$out_path" | tr -d ' ')
bytes=$(wc -c <"$out_path" | tr -d ' ')
echo "wrote:     $out_path"
echo "size:      ${lines} lines, ${bytes} bytes"
echo "extractor: $extractor"
