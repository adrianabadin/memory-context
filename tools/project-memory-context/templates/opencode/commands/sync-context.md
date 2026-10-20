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
Apply pending sync-manifest operations through the PMC framework command. Note: background sync auto-spawns by default after `refresh-context` / `enrich`; this command is only needed as a manual override or to force a sync. Pass `--detach` to run the manual sync in a nonblocking background process.
</objective>

<execution>
**Detect PTY:** Call `pty_list`. Success (even an empty list) → `HAS_PTY = true`. Failure or tool absent → `HAS_PTY = false`.

**With PTY (preferred):** To run manually in the background (nonblocking), append `--detach`. `{{PMC_BIN}}` resolves to a `.ps1`/`.cmd` shim on Windows that PTY cannot spawn directly — host it through a shell:

- **Windows:**
  ```
  pty_spawn:
    command: "cmd"
    args: ["/d", "/s", "/c", "{{PMC_BIN}} sync-context --detach"]
    title: "PMC Sync Context"
    notifyOnExit: true
    description: "Upsert enriched memories from sync-manifest into agent-memory in background"
  ```
- **macOS/Linux:**
  ```
  pty_spawn:
    command: "{{PMC_BIN}}"
    args: ["sync-context", "--detach"]
    title: "PMC Sync Context"
    notifyOnExit: true
    description: "Upsert enriched memories from sync-manifest into agent-memory in background"
  ```

If running without `--detach`, use `pty_read` to capture the sync summary, then `pty_kill` to close the session. If running with `--detach`, the process starts a background worker and exits immediately.

**Without PTY (fallback):**
```bash
{{PMC_BIN}} sync-context --detach
```

Either way, this processes `.planning/project-memory-context/enrichment/sync-manifest.json`, applies pending upserts and deletes through PMC's sync flow, and marks completed entries as synced.
</execution>

<success_criteria>
- All pending entries in sync-manifest processed through `{{PMC_BIN}} sync-context`
- No orphaned memories remaining
</success_criteria>
