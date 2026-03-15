## Graphviz Radial Diagram

Generate a `.dot` file and render with `twopi` (Graphviz radial layout engine):

```bash
twopi -Tpdf orgchart.dot -o orgchart.pdf
```

### Structure

- Use `graph` (undirected) with `layout=twopi`, `overlap=false`, `ranksep=2.5`
- Global node style: `shape=box, style="filled,rounded", fontname="Helvetica", fontsize=10`
- Root node: larger fontsize (12), thicker border (`penwidth=2`)

### Color by title

Assign a distinct `fillcolor` to each unique `business_title`. Use a palette with good contrast, e.g.:

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

### Report counts

For every person who has reports, add the count to their label:
- If they only have direct reports: `(N reports)`
- If they have indirect reports too: `(N direct, M total)`

### Legend

Add a legend node using an HTML table label:

```dot
legend [shape=none, margin=0, label=<
    <TABLE BORDER="0" CELLBORDER="1" CELLSPACING="0" CELLPADDING="6">
        <TR><TD COLSPAN="2" BGCOLOR="white"><B>Legend</B></TD></TR>
        <TR><TD BGCOLOR="#color">  </TD><TD BGCOLOR="white">Title Name</TD></TR>
        ...
    </TABLE>
>];
```

### Total headcount

Note the total number of people in the chart title/heading.
