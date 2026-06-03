---
name: view-context
description: Open the PMC Graph Explorer web UI to visualize the enrichment graph with active context highlighting.
argument-hint: ""
allowed-tools:
  - Bash
---

<objective>
Open the PMC Graph Explorer to visualize the enrichment graph. The server runs on port 3001 and shows nodes consulted via /get-context with a cyan glow.
</objective>

<execution>
Start the graph explorer server using the globally installed PMC CLI:

```bash
pmc view-context
```

Then open http://localhost:3001 in your browser.
</execution>
