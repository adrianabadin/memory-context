---
name: sync-context
description: Upsert enriched memories from the sync-manifest into agent-memory.
argument-hint: ""
allowed-tools:
  - Bash
---

<objective>
Apply pending sync-manifest operations through the PMC framework command.
</objective>

<execution>
Run:

```bash
{{PMC_BIN}} sync-context
```

This processes `.planning/project-memory-context/enrichment/sync-manifest.json`, applies pending upserts and deletes through PMC's sync flow, and marks completed entries as synced.
</execution>

<success_criteria>
- All pending entries in sync-manifest processed through `{{PMC_BIN}} sync-context`
- No orphaned memories remaining
</success_criteria>
