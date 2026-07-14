---
name: jj-split
description: Split a jj commit into logical commits by rebuilding them from its parent, verifying the final tree, then abandoning the original commit.
---

# Split a jj commit by reconstruction

Prefer rebuilding commits over `jj split`, especially when logical changes overlap files or hunks.

## Steps

1. Record the source commit and inspect its descendants:
   ```bash
   old=<revision>
   jj log -r "$old::"
   ```
2. Start a fresh change from its parent:
   ```bash
   jj new "$old-"
   ```
3. Recreate each logical change in order and commit it:
   ```bash
   # Apply one logical subset.
   jj diff
   jj commit -m "<conventional commit message>"
   ```
4. For the final change, copying completed files from the source is often simplest:
   ```bash
   jj restore --from "$old" path/to/file...
   jj commit -m "<conventional commit message>"
   ```
5. Verify the rebuilt tip has no tree differences from the source:
   ```bash
   test -z "$(jj diff --from "$old" --to @- --summary)"
   ```
6. Only after verification, abandon the source commit:
   ```bash
   jj abandon "$old"
   jj st
   ```

## Rules

- Split by intent, not file boundaries.
- Keep the source commit until tree equality is proven.
- Do not abandon unrelated descendants; rebase or reconstruct them separately.
- Use [Conventional Commits](../conventional-commits/SKILL.md) for every new description.
