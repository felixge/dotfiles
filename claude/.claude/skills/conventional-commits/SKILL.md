---
name: conventional-commits
description: >-
  Format commit messages using the Conventional Commits v1.0.0 specification.
  Use when writing commit descriptions, generating commit messages, or when the
  user asks about commit message format.
---

## Conventional Commits v1.0.0

All commit messages MUST follow this format:

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Types

| Type       | Purpose                                        | SemVer  |
|------------|------------------------------------------------|---------|
| `feat`     | A new feature                                  | MINOR   |
| `fix`      | A bug fix                                      | PATCH   |
| `build`    | Changes to the build system or dependencies    | —       |
| `chore`    | Maintenance tasks, no production code change   | —       |
| `ci`       | CI configuration and scripts                   | —       |
| `docs`     | Documentation only                             | —       |
| `style`    | Formatting, whitespace, semicolons (not CSS)   | —       |
| `refactor` | Code change that neither fixes nor adds        | —       |
| `perf`     | Performance improvement                        | —       |
| `test`     | Adding or correcting tests                     | —       |

### Rules

1. The **type** is required and must be a noun (`feat`, `fix`, etc.).
2. An optional **scope** may follow the type in parentheses: `feat(parser):`.
3. A colon and space (`: `) MUST follow the type/scope prefix.
4. The **description** is a short summary immediately after `: `.
5. An optional **body** provides detail and MUST begin one blank line after the description.
6. An optional **footer** MUST begin one blank line after the body (or description if no body).
7. Footers use the format `token: value` or `token #value` (inspired by git trailers).
8. Footer tokens use `-` in place of spaces (except `BREAKING CHANGE`).
9. A **BREAKING CHANGE** is indicated by either:
   - A **!** immediately before the `:` — e.g. `feat!:` or `feat(api)!:`
   - A footer: `BREAKING CHANGE: <description>`
   - Both may be used together; the footer provides the detailed explanation.
10. `BREAKING CHANGE` MUST be uppercase. `BREAKING-CHANGE` is also allowed.
11. Breaking changes map to a MAJOR SemVer bump.
12. Types other than `feat` and `fix` are permitted (the table above is conventional, not exhaustive).
13. Units of information beyond the spec MUST NOT be treated as different by tooling, except for `BREAKING CHANGE`.

### Examples

Simple feature:
```
feat: add email notifications for new signups
```

Feature with scope:
```
feat(auth): support OAuth2 PKCE flow
```

Fix with body:
```
fix(parser): handle nested brackets in expressions

The regex previously failed on inputs containing consecutive
closing brackets. Switch to a recursive descent approach.
```

Breaking change (bang and footer):
```
feat(api)!: remove deprecated /v1/users endpoint

BREAKING CHANGE: The /v1/users endpoint has been removed.
Clients must migrate to /v2/users.
```

Chore with scope:
```
chore(deps): bump tokio from 1.37 to 1.38
```

Docs:
```
docs: clarify rate-limit behavior in README
```
