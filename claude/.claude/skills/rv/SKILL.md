---
name: rv
description: Use when the user asks for rv, a diff view, or to review code in a browser.
---

# rv

Run `rv` in the repository. Use `--working` for uncommitted changes, `--commit <ref>` for one commit, or `--range <from>..<to>` for a commit range. The `--commit` and `--range` arguments only support Git commit references, not Jujutsu revsets such as `@-`; resolve Jujutsu revisions to Git commit IDs first. Run `rv --help` if additional options are needed.
