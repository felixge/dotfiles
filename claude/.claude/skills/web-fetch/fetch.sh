#!/usr/bin/env bash
# Fetch a URL and convert it to markdown (or text/html) via trafilatura.
#
# Usage:
#   ./fetch.sh <url> [output-path]
#   ./fetch.sh --format <markdown|txt|html> <url> [output-path]
#   ./fetch.sh --stdout <url>
#
# Output defaults to /tmp/web-fetch-<hash>.<ext>. On success, prints the
# output path and line count. Writes to a file (not stdout) so that raw
# HTML or large pages never flood the caller's context window.

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
      sed -n '2,10p' "$0" | sed 's/^# \?//'
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

# Determine output path if not provided.
if [[ -z "$out_path" && $to_stdout -eq 0 ]]; then
  # Hash the URL so repeated fetches of the same page reuse the same file.
  hash=$(printf '%s' "$url" | shasum -a 256 | cut -c1-12)
  out_path="/tmp/web-fetch-${hash}.${ext}"
fi

# Run trafilatura. Capture stderr so we can surface useful diagnostics.
tmp_err=$(mktemp)
trap 'rm -f "$tmp_err"' EXIT

if [[ $to_stdout -eq 1 ]]; then
  trafilatura -u "$url" --output-format "$format" 2>"$tmp_err"
  status=$?
  if [[ $status -ne 0 ]]; then
    echo "error: trafilatura failed (exit $status)" >&2
    cat "$tmp_err" >&2
    exit $status
  fi
  exit 0
fi

# Guard: if the caller passed a path that already exists as a directory,
# trafilatura would happily dump numbered files inside it. Refuse.
if [[ -d "$out_path" ]]; then
  echo "error: output path is a directory: $out_path" >&2
  exit 2
fi

if ! trafilatura -u "$url" --output-format "$format" >"$out_path" 2>"$tmp_err"; then
  status=$?
  echo "error: trafilatura failed (exit $status)" >&2
  cat "$tmp_err" >&2
  rm -f "$out_path"
  exit $status
fi

# Trafilatura exits 0 even when extraction yields nothing; check size.
if [[ ! -s "$out_path" ]]; then
  echo "warning: extraction produced an empty file (page may be JS-rendered or blocked)" >&2
  echo "url:   $url" >&2
  if [[ -s "$tmp_err" ]]; then
    echo "stderr:" >&2
    sed 's/^/  /' "$tmp_err" >&2
  fi
  rm -f "$out_path"
  exit 1
fi

lines=$(wc -l <"$out_path" | tr -d ' ')
bytes=$(wc -c <"$out_path" | tr -d ' ')
echo "wrote: $out_path"
echo "size:  ${lines} lines, ${bytes} bytes"
