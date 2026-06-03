---
name: sanitize
description: Re-run graphify, diff symbols, mark stale entries, and optionally start background enrichment.
argument-hint: ""
allowed-tools:
  - Bash
---

<objective>
Sanitize the PMC enrichment state. Re-runs graphify, diffs the symbol graph, marks stale or removed entries, and optionally starts background enrichment.
</objective>

<execution>
Run:

```bash
pmc sanitize
```

This will re-run graphify, compare symbols against the existing worklist, mark stale entries, and delete orphaned enrichments. If pending items remain, background enrichment is launched automatically.
</execution>
