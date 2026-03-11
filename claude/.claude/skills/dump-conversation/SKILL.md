---
name: dump-conversation
description: >-
  Create a markdown summary of the current conversation. Use when the user asks
  to dump, export, or save the conversation, or invokes /dump-conversation.
---

## Dump Conversation

Create a markdown file summarizing the current conversation.

### Filename

`{YYYY-MM-DD}-{slug}.md` where `{slug}` is a short kebab-case slug derived from
the document title. Save the file in the current working directory.

Example: `2026-03-09-oauth-pkce-debugging.md`

### Document Structure

```markdown
# {Title}

Working directory: `{absolute path where the conversation was started}`

## Conclusion

{A concise summary of what was concluded/accomplished in the conversation.
Include code snippets if they are essential to understanding the conclusion.}

## Prompts

1. {First user prompt, reproduced verbatim}
2. {Second user prompt, reproduced verbatim}
3. ...
```

### Rules

1. The **title** should be a short, descriptive phrase summarizing the
   conversation topic. It is used both as the `# heading` and to derive the
   filename slug.
2. The **Conclusion** section should focus on the final outcome — decisions
   made, solutions found, code written — not a play-by-play of the
   conversation. Include code snippets only when they are necessary to
   understand the conclusion.
3. The **Prompts** section lists every user message from the conversation,
   numbered sequentially. Reproduce each prompt verbatim (you may trim
   excessive whitespace). Do not include system messages or assistant replies.
4. After writing the file, copy its contents to the clipboard by running:
   `cat "{absolute_path}" | pbcopy`
5. Tell the user the filename and that the contents have been copied to their
   clipboard.
