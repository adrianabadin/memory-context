---
name: sync-context
description: Upsert enriched memories from the sync-manifest into agent-memory.
argument-hint: ""
allowed-tools:
  - Bash
  - pty_list
  - pty_spawn
  - pty_read
  - pty_kill
---

<objective>
Apply pending sync-manifest operations through the PMC framework command.
</objective>

<execution>
**Detect PTY:** Call `pty_list`. Success (even an empty list) → `HAS_PTY = true`. Failure or tool absent → `HAS_PTY = false`.

**With PTY (preferred):**
```
pty_spawn:
  command: "{{PMC_BIN}}"
  args: ["sync-context"]
  title: "PMC Sync Context"
  notifyOnExit: true
  description: "Upsert enriched memories from sync-manifest into agent-memory"
```
Use `pty_read` to capture the sync summary, then `pty_kill` to close the session — this is a one-shot operation, not a persistent process.

**Without PTY (fallback):**
```bash
{{PMC_BIN}} sync-context
```

Either way, this processes `.planning/project-memory-context/enrichment/sync-manifest.json`, applies pending upserts and deletes through PMC's sync flow, and marks completed entries as synced.
</execution>

<success_criteria>
- All pending entries in sync-manifest processed through `{{PMC_BIN}} sync-context`
- No orphaned memories remaining
</success_criteria>
