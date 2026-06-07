---
name: enrich-status
description: Show enrichment progress — pending, enriched, stale, and failed symbols in the worklist.
argument-hint: ""
allowed-tools:
  - Bash
  - pty_list
  - pty_spawn
  - pty_read
  - pty_kill
---

<objective>
Display the current enrichment queue status: how many symbols have been enriched, how many are pending, stale, or failed.
</objective>

<execution>
**Detect PTY:** Call `pty_list`. Success (even an empty list) → `HAS_PTY = true`. Failure or tool absent → `HAS_PTY = false`.

**With PTY (preferred):** `{{PMC_BIN}}` resolves to a `.ps1`/`.cmd` shim on Windows that
PTY cannot spawn directly ("PTY spawn failed") — host it through a shell:

- **Windows:**
  ```
  pty_spawn:
    command: "cmd"
    args: ["/d", "/s", "/c", "{{PMC_BIN}} enrich-status"]
    title: "PMC Enrich Status"
    notifyOnExit: true
    description: "One-shot enrichment status check"
  ```
- **macOS/Linux:**
  ```
  pty_spawn:
    command: "{{PMC_BIN}}"
    args: ["enrich-status"]
    title: "PMC Enrich Status"
    notifyOnExit: true
    description: "One-shot enrichment status check"
  ```

Use `pty_read` to capture the worklist summary output, then `pty_kill` to close the session — this is a one-shot check, not a persistent process.

**Without PTY (fallback):**
```bash
{{PMC_BIN}} enrich-status
```

Either way, the output shows the worklist summary with counts for pending, enriched, stale, and failed symbols.
</execution>
