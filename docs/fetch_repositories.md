# `fetch_repositories` troubleshooting

`fetch_repositories` is a bash function in [`install.bash`](../install.bash) that runs `jj git fetch` in parallel across every jj repo under `~/go/src/*/*/*` (source it and invoke manually: `source ~/dotfiles/install.bash && fetch_repositories`). It reports per-repo failures as `failed: <path>` followed by indented git/jj output. The recipes below cover the failure modes seen so far.

## `cannot lock ref … File exists` on macOS

APFS is case-insensitive, so two refs differing only in case (e.g. `origin/foo/parallel` and `origin/foo/PARALLEL`) collide as the same lock file when git tries to prune them. Symptom:

```
cannot lock ref 'refs/remotes/origin/.../X': Unable to create '.../X.lock': File exists
```

First check for actual stale locks (`find .git -name '*.lock'`). If none, it's the case-collision variant. Detect:

```bash
awk '/^[0-9a-f]/ {print tolower($2)}' .git/packed-refs | sort | uniq -d
```

Any output means colliding pairs. Confirm they're gone upstream (`git ls-remote origin <full ref>` for each variant), then drop them from `.git/packed-refs`:

```bash
cp .git/packed-refs .git/packed-refs.bak
grep -ivE '<full-ref-regex>$' .git/packed-refs.bak > .git/packed-refs
jj --ignore-working-copy git fetch
```

## `'refs/tags/X' exists; cannot create 'refs/tags/X/...'`

A D/F (directory/file) conflict: a tag `X` exists and blocks any `X/subpath` tag (common in monorepos that later adopted `<module>/<version>` tagging, e.g. a legacy `test` tag blocking `test/otel/v…`). Confirm upstream removed the blocker with `git ls-remote origin refs/tags/X`; if gone, `git tag -d X` and refetch.

## `Revision \`master@origin\` doesn't exist` after fetch

Upstream renamed default branch (usually `master` → `main`). Update the per-repo `trunk()` alias in `~/.config/jj/repos/<hash>/config.toml` (path: `jj config path --repo`):

```toml
[revset-aliases]
"trunk()" = "main@origin"
```
