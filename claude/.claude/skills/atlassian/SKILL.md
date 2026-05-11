---
name: atlassian
description: Interact with Atlassian Jira and Confluence via MCP. Use when the user asks about Jira issues, Confluence pages, sprints, boards, or any Atlassian task.
---

# Atlassian

Use the `atlassian` MCP server to interact with Jira and Confluence.

Start by listing the available tools and their schemas, then choose the right tool for the user's request:

```bash
mcporter list atlassian --schema
```

Call tools with:

```bash
mcporter call atlassian.<tool_name> key=value key2=value2
```

Most tools that require a `cloudId` can use the site hostname:

```text
datadoghq.atlassian.net
```

Authentication may require:

```bash
mcporter auth atlassian
```
