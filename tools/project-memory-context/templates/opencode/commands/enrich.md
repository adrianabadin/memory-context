---
name: enrich
description: Launch pmc enrich manually and monitor for crashes with a concurrent Still-Alive watchdog + subagent drain.
argument-hint: ""
allowed-tools:
  - Bash
---

<objective>
Start batch semantic enrichment for all pending/stale symbols, then run a fused watchdog that
concurrently monitors the Ollama CLI and drains the subagent queue every >=120 seconds.
</objective>

<launch-note>
⚠️ **IMPORTANT — how to launch**

Always launch `{{PMC_BIN}} enrich .` via the **Bash tool with `run_in_background: true`**.

Do NOT use PowerShell `Start-Process -WindowStyle Hidden`:
- The hidden child process inherits a restricted shell environment (no full user PATH).
- It crashes silently when it can't resolve `node` or its dependencies.
- It leaves `queue-state.json` with `status: "running"` but a stale `heartbeatAt`, so
  PMC reports `stalled` and blocks a clean restart for ~90 seconds.
</launch-note>

<execution>
**Step 1 — Check current state**

Run `{{PMC_BIN}} enrich-status` first.
- If `.state` is `running`, enrichment is already active — skip to the watchdog in Step 3.
- If `.state` is `finished` AND `.worklist.pending` is 0 AND `.subagentQueue.pending` is 0,
  there is nothing to do — tell the user.
- If `.state` is `finished` AND `.subagentQueue.pending > 0`, skip Step 2 and go to Step 3.

**Step 2 — Report pending count and launch**

Report to the user: "PMC: N symbols pending enrichment — launching…"

Then launch via the Bash tool with `run_in_background: true`:

```bash
{{PMC_BIN}} enrich .
```

**Step 3 — Concurrent watchdog + subagent drain** (automatic relaunch, cap: 3 attempts)

Run this loop every **≥120 seconds**. Track `relaunchCounter` (cap: 3) and
`inProgressSubagents` (handles of currently running Task subagents).

Each iteration:

1. Run `{{PMC_BIN}} enrich-status`; read `.state`, `.worklist.pending`, `.subagentQueue.pending`.

2. **Crash check** — if `.state` is `stalled` or `failed` AND `.worklist.pending > 0`:
   - Increment `relaunchCounter`.
   - If `relaunchCounter ≤ 3`: relaunch (`{{PMC_BIN}} enrich .` via Bash `run_in_background: true`);
     report "PMC enrichment crashed — relaunched (attempt N/3)."; continue loop.
   - If `relaunchCounter > 3`: stop and report:
     "PMC enrichment crashed 3 times and could not be auto-recovered.
      Run `/pmc-doctor` or inspect the terminal for errors."

3. **Subagent drain** — if `.subagentQueue.pending > 0`:
   - Read `.planning/project-memory-context/enrichment/subagent-queue.json`.
   - Collect entries with `status: "pending"`.
   - Fill available slots up to **3 parallel subagents** (accounting for any still in-progress).
   - For each dispatched entry:
     a. Launch a Task subagent with this prompt:
        ```
        You are enriching a code symbol for a project memory index.
        Return ONLY the structured explanation — no preamble, no markdown fences.

        <entry.prompt>
        ```
     b. When the subagent returns, write its response to a temp file, then run:
        ```bash
        {{PMC_BIN}} subagent-apply . --entry-id <entry.id> --content-file <tmpfile>
        ```
     c. Delete the temp file.

4. **Exit condition** — stop when ALL of:
   - `.state` is `finished`
   - `.subagentQueue.pending` is `0`
   - `inProgressSubagents` is empty

   If `.state` is `finished` but subagents are still pending or in-progress, keep looping.
</execution>

<success_criteria>
- All pending/stale symbols processed (enriched or marked as error)
- `.subagentQueue.pending` = 0
- Sync-manifest updated with new entries
</success_criteria>
