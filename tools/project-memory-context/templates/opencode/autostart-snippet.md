<!-- pmc:autostart -->
On EVERY session start, BEFORE responding to the user, execute these steps IN ORDER:

1. **Check enrichment status**: Read `.planning/project-memory-context/enrichment/worklist.json`.
   Count entries with `status: "pending"` or `status: "stale"`. **Report the count to the user**
   (e.g. "PMC: 12 symbols pending enrichment").
   If count > 0, launch background enrichment via the **Bash tool with `run_in_background: true`**:

   ```bash
   {{PMC_BIN}} enrich .
   ```

   ⚠️ Do NOT use PowerShell `Start-Process -WindowStyle Hidden` — the hidden process inherits a
   restricted PATH, crashes silently, and leaves a stalled queue-state that blocks restart for ~90 s.

   After launching, run the **Still-Alive watchdog** (cap: 3 auto-relaunches):
   - Periodically run `{{PMC_BIN}} enrich-status` and check `.state`.
   - `running` → alive, keep waiting.
   - `finished` → done, report completion summary.
   - `stalled` or `failed` AND `.worklist.pending > 0` → crashed; relaunch (Bash
     `run_in_background: true`), report "PMC enrichment crashed — relaunched (attempt N/3)".
   - After 3 failed relaunches: tell the user to run `/doctor`.

2. **Check sync-manifest**: Read `.planning/project-memory-context/enrichment/sync-manifest.json`. If `entries` contains any element with `status: "pending"`, surface: "PMC has N pending sync operations. Run `/sync-context` to apply them."

3. **Recall base context**: Call `agent-memory_search` with `query: "project context overview"` and `tags: ["project-context"]`. Present a brief summary (~500 tokens) to establish session context.

4. **Remind**: "Use `/get-context <target>` for structural deep-dive BEFORE reading files."

## Mandatory PMC Workflow (ENFORCED)

- **BEFORE reading any source file**: Run `pmc get-context <file-or-symbol>` FIRST. Do NOT open files with Read/Grep without first checking PMC context.
- **AFTER implementing code changes**: Run `pmc refresh-context --enrich` (refreshes graph incrementally, queues and launches enrichment) then `pmc sync-context` to persist new memories.
- **Default context depth**: Always use `depth=compact`. Use `extended` or `deep` ONLY when explicitly asked.
- **`map-project --all`** is only needed for full reinstall or ground-up graph rebuild. Day-to-day, `refresh-context` keeps everything current.

## Context Retrieval Rules

| Situation | Command | Depth |
|-----------|---------|-------|
| About to read a file | `pmc get-context <file>` | compact |
| Working on a specific symbol | `pmc get-context <symbol>` | compact |
| Need dependency information | `pmc get-context <symbol> extended dependencies` | extended |
| Debugging complex issues | `pmc get-context <symbol> deep all` | deep |
| Need raw source code | `pmc get-context <symbol> disk` | disk |
| Quick project overview | `agent-memory_search "project context overview"` | — |
| After code changes | `pmc refresh-context --enrich` then `pmc sync-context` | — |
<!-- /pmc:autostart -->
