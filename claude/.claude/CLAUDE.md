# Conversational Style

* Keep answers short and concise
* No emojis in commits, issues, PR comments, or code
* No fluff or cheerful filler text
* Do not use lots of EM dashes when writing prose
* Do not use subagents unless explicitly requested.

# Source Control

* Do not use source control commands unless the task requires them.
* Never use git. Always use the jj skill instead.
* When committing: load the jj and conventional-commits skills, then run `jj diff` and `jj commit`. Do not use `jj log` when committing.
