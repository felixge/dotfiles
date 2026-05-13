---
name: dd-orgchart
description: >-
  Answer questions about the Datadog org structure using Workday data in
  Snowflake. Use when the user asks about org charts, team structure, who
  reports to someone, headcount, titles, or any people/org question.
allowed_tools:
  - Bash(mcporter *)
---

## Datadog Org Chart

Answer questions about the Datadog org structure using Workday data in Snowflake.

### Data Source

Table: `REPORTING.GENERAL.DIM_WORKDAY_WORKER_PUBLIC`

| Column | Description |
|--------|-------------|
| `employee_id` | Unique employee identifier |
| `name` | Full name |
| `business_title` | Job title |
| `manager_id` | Employee ID of direct manager |
| `team` | Team name |
| `cost_center` | Cost center |
| `is_active` | Whether employee is currently active |

### Running Queries

Use the Snowflake MCP server via `mcporter` for clean JSON output:

```bash
mcporter call snowflake.run_snowflake_query statement="<SQL>" --output json
```

Notes:
- Prefer `key=value` argument style for SQL containing quotes; it is less error-prone than function-call style.
- Wrap string literals inside the SQL with single quotes.
- The MCP server may print startup logs on stderr; the JSON result is on stdout.

### Common Queries

**Recursive org tree** (replace `<name>` with the person's name):

```sql
WITH RECURSIVE org_tree AS (
    SELECT employee_id, name, business_title, manager_id, team,
           is_active, 0 AS depth, name AS path
    FROM REPORTING.GENERAL.DIM_WORKDAY_WORKER_PUBLIC
    WHERE name ILIKE '%<name>%' AND is_active = TRUE
    UNION ALL
    SELECT e.employee_id, e.name, e.business_title, e.manager_id, e.team,
           e.is_active, t.depth + 1, t.path || ' > ' || e.name
    FROM REPORTING.GENERAL.DIM_WORKDAY_WORKER_PUBLIC e
    JOIN org_tree t ON e.manager_id = t.employee_id
    WHERE e.is_active = TRUE AND e.employee_id != e.manager_id
)
SELECT depth, name, business_title, team
FROM org_tree
ORDER BY path
```

If the base case matches multiple people, ask the user to disambiguate.

**Headcount by location** (replace `<name>` with the person's name):

```sql
WITH RECURSIVE org_tree AS (
    SELECT employee_id, name, business_title, manager_id, team,
           is_active, location_id, 0 AS depth
    FROM REPORTING.GENERAL.DIM_WORKDAY_WORKER_PUBLIC
    WHERE name ILIKE '%<name>%' AND is_active = TRUE
    UNION ALL
    SELECT e.employee_id, e.name, e.business_title, e.manager_id, e.team,
           e.is_active, e.location_id, t.depth + 1
    FROM REPORTING.GENERAL.DIM_WORKDAY_WORKER_PUBLIC e
    JOIN org_tree t ON e.manager_id = t.employee_id
    WHERE e.is_active = TRUE AND e.employee_id != e.manager_id
)
SELECT location_id, COUNT(*) AS headcount
FROM org_tree
WHERE depth > 0
GROUP BY location_id
ORDER BY headcount DESC
```

### Output

Adapt output to what the user asked for — a count, a list, a text tree, etc.

If the user asks for a **visual diagram or chart**, read and follow `GRAPHVIZ.md` in this skill directory.

For a **text tree**, render using box-drawing characters (`├──`, `└──`, `│`) with name, title, and team. Show total headcount at the end.
