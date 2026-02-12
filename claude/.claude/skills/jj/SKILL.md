---
name: jj
description: Use the jj version control system. Always use it when the user mentions jj.
---

## jj

Jujutsu is a Git-compatible VCS. The working copy is automatically snapshotted
as a commit on every `jj` command — there is no staging area. All changes live
in `@` (the working-copy commit) until you finalize them.

## Key Concepts

- **Change ID** vs **Commit ID** — A change ID is a stable identifier that
  persists across rewrites. A commit ID (hash) changes whenever content is
  modified. Prefer change IDs when referring to revisions.
- **`@`** — The working-copy commit. `@-` is its parent.
- **No staging area** — Files are tracked implicitly. New files are
  auto-tracked; use `.gitignore` to exclude files.
- **Automatic rebase** — Rewriting a commit automatically rebases all its
  descendants.
- **First-class conflicts** — Conflicts are recorded in commits and don't block
  operations. Resolve them later by editing the conflicted commit and squashing
  the fix.
- **Bookmarks** — Named pointers to commits (equivalent to Git branches). They
  move automatically when the target commit is rewritten, but do **not** advance
  when you create new commits.

## Common Commands

### Viewing State

| Command | Purpose |
|---------|---------|
| `jj st` | Show working-copy status |
| `jj log` | Show commit graph (defaults to non-remote commits) |
| `jj log -r ::@` | Show ancestors of working copy |
| `jj log -r 'all()'` | Show all commits |
| `jj diff` | Diff of current revision (`@`) |
| `jj diff -r <rev>` | Diff of a specific revision |
| `jj diff --from A --to B` | Diff between two revisions |
| `jj show <rev>` | Show a revision's changes and metadata |
| `jj evolog` | Show how a change evolved over time |

### Creating & Describing Changes

| Command | Purpose |
|---------|---------|
| `jj new` | Finalize `@` and start a new empty change on top |
| `jj new main` | Start a new change from `main` |
| `jj new A B` | Create a merge commit with parents A and B |
| `jj commit -m "msg"` | Describe `@` and start a new change (= `describe` + `new`) |
| `jj describe -m "msg"` | Set/edit the description of `@` |
| `jj describe <rev> -m "msg"` | Set/edit the description of any revision |

### Squash

Squash moves changes from one commit into another.

| Command | Purpose |
|---------|---------|
| `jj squash` | Move all changes from `@` into its parent (`@-`) |
| `jj squash -i` | Interactively select which changes to move into parent |
| `jj squash <paths>...` | Move only specific files into parent |
| `jj squash --into <rev>` | Move changes from `@` into an arbitrary ancestor |
| `jj squash --from <rev>` | Move changes from `<rev>` into its parent |
| `jj squash --from <rev> --into <rev>` | Move changes between arbitrary revisions |
| `jj squash -i --from X --into Y` | Interactively move selected changes between arbitrary revisions |

Note: `--from` defaults to `@`, `--into` defaults to the parent of `--from`.
The flags `-r` and `--into` cannot be combined.

### Split

Split divides a commit into two or more sequential commits.

| Command | Purpose |
|---------|---------|
| `jj split` | Interactively split `@` — select changes for the first commit; the rest go into a second |
| `jj split -r <rev>` | Split a revision other than `@` |
| `jj split <paths>...` | Split by putting the listed files into the first commit |

After splitting, you'll be prompted for descriptions for each resulting commit.

### Editing History

| Command | Purpose |
|---------|---------|
| `jj edit <change-id>` | Check out a previous change for editing (becomes `@`) |
| `jj edit @-` | Edit the parent of the current change |
| `jj diffedit -r <rev>` | Edit a revision's diff without checking it out |
| `jj abandon` | Discard `@` and rebase its descendants onto `@-` |
| `jj restore <paths>...` | Restore files in `@` from its parent |
| `jj restore --from <rev> <paths>...` | Restore files from a specific revision |
| `jj duplicate <rev>` | Copy a commit to a new change |
| `jj revert -r <rev> -B @` | Create a reverse-patch of a revision before `@` |

### Navigation

| Command | Purpose |
|---------|---------|
| `jj next --edit` | Move to the next (child) change |
| `jj prev --edit` | Move to the previous (parent) change |

### Rebasing

| Command | Purpose |
|---------|---------|
| `jj rebase -s <src> -o <onto>` | Rebase `<src>` and descendants onto `<onto>` |
| `jj rebase -b <rev> -o <onto>` | Rebase the branch containing `<rev>` onto `<onto>` |
| `jj rebase -r <rev> -o <onto>` | Rebase only `<rev>` (re-parents descendants) |
| `jj rebase -r <rev> --before <target>` | Insert `<rev>` before `<target>` |
| `jj rebase -r <rev> --after <target>` | Insert `<rev>` after `<target>` |

Note: `-d`/`--destination` is a legacy alias for `-o`/`--onto`.

### Bookmarks (Branches)

| Command | Purpose |
|---------|---------|
| `jj bookmark list` / `jj b l` | List bookmarks |
| `jj bookmark create <name> -r <rev>` / `jj b c <name>` | Create bookmark |
| `jj bookmark move <name> --to <rev>` / `jj b m <name> -t <rev>` | Move bookmark |
| `jj bookmark move <name> --to <rev> --allow-backwards` | Move bookmark backwards |
| `jj bookmark delete <name>` | Delete bookmark |
| `jj bookmark track <name>@<remote>` | Track a remote bookmark |

### Git Integration

| Command | Purpose |
|---------|---------|
| `jj git init` | Initialize jj repo with git backend |
| `jj git clone <url> <dir>` | Clone a git repository |
| `jj git fetch` | Fetch from remote (updates tracked bookmarks) |
| `jj git push` | Push tracked bookmarks to remote |
| `jj git push --bookmark <name>` | Push a specific bookmark |
| `jj git push --change <rev>` | Push a change (auto-creates bookmark) |
| `jj git push --all` | Push all bookmarks |

### Conflict Resolution

Conflicts are stored in commits and don't block operations.

1. `jj new <conflicted-rev>` — create a child to work in
2. Edit files to resolve conflict markers (`<<<<<<<` / `%%%%%%%` / `+++++++` / `>>>>>>>`)
3. `jj squash` — fold the resolution back into the conflicted commit

Or use `jj resolve` to open a merge tool.

### Undo & Operations

| Command | Purpose |
|---------|---------|
| `jj undo` | Undo the last operation |
| `jj op log` | Show operation history |
| `jj op restore <op-id>` | Restore repo to a previous operation state |

## GitHub PR Workflow

```bash
jj new main                        # start from main
# ... make changes ...
jj commit -m "feat: add feature"   # finalize with message
jj git push --change @-            # push with auto-generated bookmark
```

To update a PR after review:
```bash
jj edit <change-id>                # go back to the PR commit
# ... make changes ...
jj new                             # done editing, start fresh change
jj git push --bookmark <name>      # push updated bookmark
```

## Revset Quick Reference

Use `-r` flag on most commands to select revisions.

| Expression | Meaning |
|------------|---------|
| `@` | Working copy |
| `@-` | Parent of working copy |
| `@--` | Grandparent |
| `x-` | Parents of x |
| `x+` | Children of x |
| `::x` | Ancestors of x (inclusive) |
| `x::` | Descendants of x (inclusive) |
| `x..y` | Commits in y but not in x (like git `x..y`) |
| `x \| y` | Union |
| `x & y` | Intersection |
| `~x` | Negation |
| `bookmarks()` | All bookmarked commits |
| `remote_bookmarks()` | All remote-tracked commits |
| `heads(x)` | Commits in x with no descendants in x |
| `roots(x)` | Commits in x with no ancestors in x |
| `description(pattern)` | Commits matching description |
| `author(pattern)` | Commits matching author |
| `empty()` | Empty commits |
| `conflicts()` | Commits with conflicts |
| `files(pattern)` | Commits touching files matching pattern |

String patterns: `exact:`, `glob:` (default), `regex:`, `substring:`. Append
`-i` for case-insensitive (e.g. `glob-i:"fix*"`).

For full revset docs: `jj help -k revsets`
