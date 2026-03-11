---
name: dd-orgchart
description: >-
  Generate an org chart for a Datadog manager showing all recursive reports.
  Use when the user asks to see an org chart, team structure, or who reports
  to someone.
---

## Datadog Org Chart

Build a recursive org chart from the Workday data in Snowflake.

### Data Source

Use `REPORTING.GENERAL.DIM_WORKDAY_WORKER_PUBLIC` which contains:

| Column | Description |
|--------|-------------|
| `employee_id` | Unique employee identifier |
| `name` | Full name |
| `business_title` | Job title |
| `manager_id` | Employee ID of direct manager |
| `team` | Team name |
| `cost_center` | Cost center |
| `is_active` | Whether employee is currently active |

### Query

Use the Snowflake MCP `run_snowflake_query` tool.

**Step 1** — Find the root person:

```sql
SELECT employee_id, name, business_title, manager_id, team
FROM REPORTING.GENERAL.DIM_WORKDAY_WORKER_PUBLIC
WHERE name ILIKE '%<name>%' AND is_active = TRUE
```

If multiple matches, ask the user to disambiguate.

**Step 2** — Recursive org chart query (replace `<ID>` with the employee_id):

```sql
WITH RECURSIVE org_tree AS (
    SELECT employee_id, name, business_title, manager_id, team,
           is_active, 0 AS depth, name AS path
    FROM REPORTING.GENERAL.DIM_WORKDAY_WORKER_PUBLIC
    WHERE employee_id = <ID>
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

### Output

Default output is a **radial Graphviz diagram** rendered as PDF. Also supports text tree output if requested.

#### Graphviz Radial Diagram (default)

Generate a `.dot` file and render with `twopi` (Graphviz radial layout engine):

```bash
twopi -Tpdf orgchart.dot -o orgchart.pdf
```

**Structure:**
- Use `graph` (undirected) with `layout=twopi`, `overlap=false`, `ranksep=2.5`
- Global node style: `shape=box, style="filled,rounded", fontname="Helvetica", fontsize=10`
- Root node: larger fontsize (12), thicker border (`penwidth=2`)

**Color by title** — assign a distinct `fillcolor` to each unique `business_title`. Use a palette with good contrast, e.g.:

| Title | Fill | Font |
|-------|------|------|
| Director | `#7B1FA2` | white |
| Senior Staff Engineer | `#1565C0` | white |
| Manager | `#00897B` | white |
| Staff Engineer | `#42A5F5` | white |
| Engineering Lead | `#EF6C00` | white |
| Senior Software Engineer | `#2E7D32` | white |
| Software Engineer | `#66BB6A` | white |
| Software Engineer II | `#9CCC65` | black |
| Intern | `#EC407A` | white |
| Applied Scientist | `#FFA000` | black |

Adapt colors for whatever titles appear in the data.

**Report counts** — for every person who has reports, add the count to their label:
- If they only have direct reports: `(N reports)`
- If they have indirect reports too: `(N direct, M total)`

**Legend** — add a legend node using an HTML table label:

```dot
legend [shape=none, margin=0, label=<
    <TABLE BORDER="0" CELLBORDER="1" CELLSPACING="0" CELLPADDING="6">
        <TR><TD COLSPAN="2" BGCOLOR="white"><B>Legend</B></TD></TR>
        <TR><TD BGCOLOR="#color">  </TD><TD BGCOLOR="white">Title Name</TD></TR>
        ...
    </TABLE>
>];
```

**Total headcount** — note the total number of people in the chart title/heading.

#### Text Tree (if requested)

Render as an indented tree using box-drawing characters (`├──`, `└──`, `│`).
Include name, title, and team. Show a total headcount at the end.
