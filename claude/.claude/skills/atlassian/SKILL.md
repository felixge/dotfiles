---
name: atlassian
description: Interact with Atlassian Jira and Confluence via MCP. Use when the user asks about Jira issues, Confluence pages, sprints, boards, or any Atlassian task.
---

# Atlassian

Use the `datadog-atlassian` MCP server to interact with Jira and Confluence.

Start by listing the available tools and their schemas, then choose the right tool for the user's request:

```bash
mcporter list datadog-atlassian --schema
```

Call tools with:

```bash
mcporter call datadog-atlassian.<tool_name> key=value key2=value2
```

This server is restricted to the `datadoghq` Atlassian site, with Cloud ID enforced by the server.

Authentication may require:

```bash
mcporter auth datadog-atlassian
```
