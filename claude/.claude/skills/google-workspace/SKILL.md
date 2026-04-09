---
name: google-workspace
description: Interact with Google Drive, Docs, Sheets, and Slides via MCP. Use when the user asks about Google Docs, Sheets, Drive files, or any Google Workspace task.
---

# Google Workspace

Use the `google-workspace` MCP server to interact with Google Drive, Docs, and Sheets.

## Reading a Google Doc

**Always use `get_file_content`** — it exports the doc as plain text directly:

```bash
mcporter call 'google-workspace.get_file_content(file_id: "DOCUMENT_ID")'
```

The document ID is the long string in the URL between `/d/` and `/edit`:
`https://docs.google.com/document/d/<DOCUMENT_ID>/edit`

**Do NOT use `read_document`** for reading docs. It returns the raw Google Docs API JSON with all formatting/styling metadata, which is enormous and requires manual parsing to extract text.

## Available Tools

### Google Drive

| Tool | Purpose |
|------|---------|
| `search_files` | Search Drive by name, type, or full-text query (uses Google Drive query syntax) |
| `get_file_metadata` | Get detailed metadata for a file |
| `get_file_content` | **Best way to read files.** Exports Workspace files (Docs, Sheets, Slides) as text. Other files return a download link. |
| `list_folder_contents` | List files in a folder (default: root) |
| `create_file` | Create a new file with content |

### Google Docs

| Tool | Purpose |
|------|---------|
| `read_document` | Raw Google Docs API JSON — **avoid for reading content**, use `get_file_content` instead. Only use if you need structural/formatting metadata. |
| `create_document` | Create a new doc with optional initial text |
| `append_text` | Append text to end of a doc |
| `replace_text` | Find and replace text (all occurrences) |
| `insert_text` | Insert text at a specific character index (1-based) |
| `delete_range` | Delete content between two character positions |

### Google Sheets

| Tool | Purpose |
|------|---------|
| `read_sheet` | Read a cell range (A1 notation, e.g. `Sheet1!A1:D10`) |
| `write_sheet` | Write values to a cell range |
| `append_rows` | Append rows after last row with data |
| `create_spreadsheet` | Create a new spreadsheet |
| `get_spreadsheet_metadata` | Get sheet names and properties |

### Utility

| Tool | Purpose |
|------|---------|
| `ping` | Health check — verify server is reachable and authenticated |

## Examples

```bash
# Read a Google Doc (the right way)
mcporter call 'google-workspace.get_file_content(file_id: "1aBcDeFgHiJkLmNoPqRsTuVwXyZ")'

# Search Drive
mcporter call 'google-workspace.search_files(query: "name contains '\''quarterly report'\''", max_results: 10)'

# List root folder
mcporter call 'google-workspace.list_folder_contents()'

# Read a sheet range
mcporter call 'google-workspace.read_sheet(spreadsheet_id: "1aBcDeFg", range: "Sheet1!A1:D10")'

# Create a new doc
mcporter call 'google-workspace.create_document(title: "Meeting Notes", body: "# Agenda\n\n- Item 1\n- Item 2")'

# Find and replace in a doc
mcporter call 'google-workspace.replace_text(document_id: "1aBcDeFg", find_text: "old text", replace_with: "new text")'

# Append to a doc
mcporter call 'google-workspace.append_text(document_id: "1aBcDeFg", text: "\n\nNew section content here")'
```

## Gotchas

- **Use `get_file_content` to read docs**, not `read_document`. The latter returns raw API JSON with all formatting metadata (hundreds of KB for a simple doc).
- **Document ID extraction**: Given `https://docs.google.com/document/d/198U1idr1pKY.../edit`, the ID is `198U1idr1pKY...`.
- **Spreadsheet ID extraction**: Same pattern — between `/d/` and `/edit` in the Sheets URL.
- **`insert_text` / `delete_range` indices are 1-based** — use `read_document` first to determine correct positions (this is the one valid use case for `read_document`).
- **`replace_text` replaces ALL occurrences** — include enough surrounding context in `find_text` to target a single match.
- Authentication may require `mcporter auth google-workspace` on first use. If the server returns "Session not found" errors, re-auth and retry.
