---
name: enrich-status
description: Show enrichment progress — pending, enriched, stale, and failed symbols in the worklist.
argument-hint: ""
allowed-tools:
  - Bash
---

<objective>
Display the current enrichment queue status: how many symbols have been enriched, how many are pending, stale, or failed.
</objective>

<execution>
Run:

```bash
{{PMC_BIN}} enrich-status
```

This shows the worklist summary with counts for pending, enriched, stale, and failed symbols.
</execution>
