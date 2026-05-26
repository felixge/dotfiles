#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage:
  readpdf.sh extract -o <output-dir> <pdf-or-dir>...
  readpdf.sh read <pdf-or-dir>...

Extract embedded PDF text (no OCR) to XXX.txt and render pages to XXX.N.jpg.
Directories are searched recursively for *.pdf files.
USAGE
}

if [ "$#" -lt 2 ]; then
  usage
  exit 2
fi

mode="$1"
shift

case "$mode" in
  extract)
    if [ "${1:-}" != "-o" ] || [ "$#" -lt 3 ]; then
      usage
      exit 2
    fi
    out_dir="$2"
    shift 2
    ;;
  read)
    out_dir="$(mktemp -d "${TMPDIR:-/tmp}/readpdf.XXXXXX")"
    ;;
  *)
    usage
    exit 2
    ;;
esac

for cmd in pdftotext pdftoppm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: $cmd not found. Install poppler." >&2
    exit 1
  fi
done

mkdir -p "$out_dir"

pdf_list="$(mktemp "${TMPDIR:-/tmp}/readpdf-list.XXXXXX")"
trap 'rm -f "$pdf_list"' EXIT

for input in "$@"; do
  if [ -d "$input" ]; then
    find "$input" -type f \( -iname '*.pdf' \) -print >> "$pdf_list"
  elif [ -f "$input" ]; then
    case "$input" in
      *.pdf|*.PDF) printf '%s\n' "$input" >> "$pdf_list" ;;
      *) echo "warning: skipping non-PDF file: $input" >&2 ;;
    esac
  else
    echo "warning: path does not exist: $input" >&2
  fi
done

if [ ! -s "$pdf_list" ]; then
  echo "error: no PDFs found" >&2
  exit 1
fi

unique_base() {
  local pdf="$1"
  local stem base candidate n
  stem="$(basename "$pdf")"
  stem="${stem%.[Pp][Dd][Ff]}"
  # Avoid awkward shell/path chars in generated file names.
  base="$(printf '%s' "$stem" | tr -c '[:alnum:]_.-' '_')"
  [ -n "$base" ] || base="pdf"
  candidate="$base"
  n=2
  while [ -e "$out_dir/$candidate.txt" ] || compgen -G "$out_dir/$candidate.[0-9]*.jpg" >/dev/null; do
    candidate="$base.$n"
    n=$((n + 1))
  done
  printf '%s' "$candidate"
}

while IFS= read -r pdf; do
  base="$(unique_base "$pdf")"
  text_path="$out_dir/$base.txt"

  pdftotext -layout "$pdf" "$text_path"
  printf '%s\n' "$text_path"

  render_prefix="$out_dir/.readpdf-render-$base"
  rm -f "$render_prefix"-*.jpg
  pdftoppm -jpeg -r 200 "$pdf" "$render_prefix"

  for img in "$render_prefix"-*.jpg; do
    [ -e "$img" ] || continue
    page="${img#$render_prefix-}"
    page="${page%.jpg}"
    out_img="$out_dir/$base.$page.jpg"
    mv "$img" "$out_img"
    printf '%s\n' "$out_img"
  done
done < "$pdf_list"

if [ "$mode" = "read" ]; then
  echo "Read all files above into context: first the .txt files, then inspect every .jpg page image." >&2
fi
