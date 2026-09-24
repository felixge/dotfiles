---
name: rv
description: Use when the user asks for rv, a diff view, a code review, or to review code in a browser.
---

# rv

For an rv or code review request, use the interactive agent workflow in the repository:

1. Start `rv --agent` as a long-running process and keep it alive. Do not replace it with a one-shot `rv` invocation.
2. Run `rv --wait`. It blocks until the user submits a review, then prints the exact prompt to stdout and exits.
3. Apply the submitted feedback, then run `rv --wait` again for the next review round. Continue until the user ends the review.

The browser UI stays open between rounds. A successful submission clears its comments, and submissions made between wait calls remain queued. Do not discard queued feedback or restart `rv --agent` between rounds.

To choose the initial view, add `--working` for uncommitted changes, `--commit <ref>` for one commit, or `--range <from>..<to>` for a commit range to `rv --agent`. The `--commit` and `--range` arguments only support Git commit references, not Jujutsu revsets such as `@-`; resolve Jujutsu revisions to Git commit IDs first. Run `rv --help` if additional options are needed.
