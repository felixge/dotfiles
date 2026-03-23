---
name: atlassian
description: Interact with Atlassian Jira and Confluence via MCP. Use when the user asks about Jira issues, Confluence pages, sprints, boards, or any Atlassian task.
---

# Atlassian

Use the `atlassian` MCP server to interact with Jira and Confluence.

## Default Behavior

When this skill is invoked, **always perform a search immediately** using `searchAtlassian` with the user's query — don't just explain how to search or ask for clarification. The user expects results, not instructions.

## Recommended Workflow

1. **Search** with `searchAtlassian` (searches both Jira and Confluence, no cloudId needed) — **do this by default**
2. **Fetch details** with `fetchAtlassian` using the ARI (`id` field) from search results
3. For **JQL-specific** queries, use `searchJiraIssuesUsingJql` (requires cloudId)
4. For **CQL-specific** queries, use `searchConfluenceUsingCql` (requires cloudId)

## CloudId

Most tools require a `cloudId` parameter. Use the site hostname: `datadoghq.atlassian.net`

## Listing available tools

```bash
mcporter list atlassian --schema
```

## Calling a tool

```bash
mcporter call atlassian.<tool_name> key=value key2=value2
```

## Examples

```bash
# General search (both Jira and Confluence, no cloudId needed)
mcporter call atlassian.searchAtlassian query="full host profiler"

# Fetch full content using ARI from search results
mcporter call atlassian.fetchAtlassian id="ari:cloud:confluence:66c05bee-f5ff-4718-b6fc-81351e5ef659:page/3834216651"
mcporter call atlassian.fetchAtlassian id="ari:cloud:jira:66c05bee-f5ff-4718-b6fc-81351e5ef659:issue/1072997"

# Search Jira with JQL
mcporter call atlassian.searchJiraIssuesUsingJql cloudId=datadoghq.atlassian.net jql="project = PROJ AND status = Open"

# Get a specific Jira issue
mcporter call atlassian.getJiraIssue cloudId=datadoghq.atlassian.net issueIdOrKey=PROJ-123

# Search Confluence with CQL
mcporter call atlassian.searchConfluenceUsingCql cloudId=datadoghq.atlassian.net cql='title ~ "meeting notes" AND type = page'
```

## Gotchas

- **Prefer `fetchAtlassian` over `getConfluencePage`**: The `getConfluencePage` tool requires `pageId` as a string type, but mcporter parses numeric values as numbers, causing type errors. Using `fetchAtlassian` with ARIs from search results avoids this problem entirely.
- **`searchAtlassian`** is the best starting point — it doesn't need a cloudId and covers both Jira and Confluence via Rovo Search.
- **Content format**: Many tools accept `contentFormat=markdown` or `responseContentFormat=markdown` for readable output instead of ADF (Atlassian Document Format).
- Authentication may require `mcporter auth atlassian` on first use.
