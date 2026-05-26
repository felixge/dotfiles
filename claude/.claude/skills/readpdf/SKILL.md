---
name: readpdf
description: Extract embedded text and rendered page images from PDFs. Use when the user asks to read, inspect, parse, convert, or extract contents from PDF files without OCR.
---

# Read PDF

Use the bundled `readpdf.sh` script to extract embedded text from PDFs with `pdftotext` and render each page as a JPEG with `pdftoppm`.

This skill does **not** OCR scanned PDFs. It only extracts text already present in the PDF, plus page images for visual inspection.

## Commands

### Extract to a chosen directory

```bash
./readpdf.sh extract -o <output-dir> <pdf-or-dir>...
```

Inputs may be PDF files or directories. Directories are searched recursively for `*.pdf` files.

For each PDF, the script writes:

- `<output-dir>/XXX.txt` — embedded text extracted with `pdftotext -layout`
- `<output-dir>/XXX.N.jpg` — rendered page `N`, at 200 DPI

The script emits every generated file path to stdout.

### Read PDFs into model context

```bash
./readpdf.sh read <pdf-or-dir>...
```

This extracts to a temporary directory, emits all generated paths to stdout, and prints a reminder on stderr.

When using `read`, after running the script you must read the generated `.txt` files and inspect/read every `.jpg` page image into context. Prefer reading `.txt` first, then the images in page order, so both embedded text and visual layout are available.

## Notes

- Requires Poppler tools on `PATH`: `pdftotext` and `pdftoppm`.
- Poppler is installed by Homebrew as `poppler` in `install.bash`.
- If a PDF contains only scanned images, the `.txt` file may be empty; still inspect the rendered page images.
- If multiple PDFs have the same basename, later outputs get numeric suffixes to avoid overwriting.
