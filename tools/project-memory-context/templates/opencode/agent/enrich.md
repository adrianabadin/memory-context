---
name: enrich
description: Run batch semantic enrichment for pending symbols using the fallback chain.
argument-hint: "[--concurrency N]"
allowed-tools:
  - Bash
  - Read
  - Write
---

<objective>
Launch the Ollama enrichment CLI and concurrently drain the subagent queue
(symbols >=5k tokens or >=80% file coverage, e.g. EF migrations) while the CLI runs —
polling every >=120 seconds — rather than waiting until after Ollama finishes.
</objective>

<execution>
**Step 1 — Check current state**

Run `{{PMC_BIN}} enrich-status` first.
- If `.state` is `running`, enrichment is already active — skip to Step 3.
- If `.state` is `finished` AND `.worklist.pending` is 0 AND `.subagentQueue.pending` is 0,
  there is nothing to do — tell the user.
- If `.state` is `finished` AND `.subagentQueue.pending > 0`, skip Step 2 and go to Step 3.

**Step 2 — Report pending count and launch**

Report to the user: "PMC: N symbols pending enrichment — launching…"

```bash
{{PMC_BIN}} enrich . --background
```

⚠️ `--background` detaches cross-platform (Node.js `detached+unref`). Never use `PowerShell Start-Process -WindowStyle Hidden` — crashes silently, leaves stalled queue.

**Step 3 — Concurrent watchdog + subagent drain**

Run this loop every **≥120 seconds**. Track `relaunchCounter` (cap: 3) and
`inProgressSubagents` (handles of currently running Task subagents).

Each iteration:

1. Run `{{PMC_BIN}} enrich-status`; read `.state`, `.worklist.pending`, `.subagentQueue.pending`.

2. **Crash check** — if `.state` is `stalled` or `failed` AND `.worklist.pending > 0`:
   - Increment `relaunchCounter`.
   - If `relaunchCounter ≤ 3`: relaunch `{{PMC_BIN}} enrich . --background`;
     report "PMC enrichment crashed — relaunched (attempt N/3)."; continue loop.
   - If `relaunchCounter > 3`: stop and report:
     "PMC enrichment crashed 3 times. Run `/pmc-doctor` or inspect the terminal for errors."

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
- `.worklist.pending` = 0
- `.subagentQueue.pending` = 0
- Sync-manifest updated with new entries
- Suggest running `{{PMC_BIN}} sync-context` to persist all new memories to agent-memory
</success_criteria>
