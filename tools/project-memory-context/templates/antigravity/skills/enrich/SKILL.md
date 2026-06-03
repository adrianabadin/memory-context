---
name: enrich
description: "Launch batch semantic enrichment for all pending symbols. Handles both Ollama queue (run by CLI) and subagent queue (symbols >=5k tokens or >=80% file coverage, dispatched as Task subagents). Drains subagent queue concurrently with the Ollama CLI — every ≥120s — rather than waiting until after Ollama finishes. Use when the user asks to enrich, index, or process all pending symbols."
allowed-tools: Bash Read Write TaskCreate TaskGet TaskUpdate
---

# Batch Enrichment — `pmc enrich`

Run batch semantic enrichment for all pending/stale symbols.

Enrichment has two queues:
- **Ollama queue (<5k tokens, <80% file coverage):** processed sequentially by the CLI in background.
- **Subagent queue (>=5k tokens or >=80% file coverage, e.g. EF migrations):** processed by Task subagents dispatched by this skill (up to 3 in parallel per drain cycle).

## Launch

⚠️ Always launch via the **Bash tool with `run_in_background: true`**.

Do NOT use PowerShell `Start-Process -WindowStyle Hidden` — it inherits a restricted PATH,
crashes silently, and leaves a stalled queue-state.

### Step 1 — Check current state

Run `{{PMC_BIN}} enrich-status` first.
- If `.state` is `running`, enrichment is already active — skip to Step 3 watchdog+drain loop.
- If `.state` is `finished` and `.worklist.pending` is 0, check if `.subagentQueue.pending > 0`
  and jump directly to Step 3 (subagent drain only).

### Step 2 — Report pending count and launch

Report to the user: "PMC: N symbols pending enrichment — launching…"

```bash
{{PMC_BIN}} enrich .
```

### Step 3 — Concurrent watchdog + subagent drain

Run this loop every **≥120 seconds** until the exit condition is met.
Track `relaunchCounter` (cap: 3) and `inProgressSubagents` (a set of running Task handles).

**Each iteration:**

1. Run `{{PMC_BIN}} enrich-status`; read `.state`, `.worklist.pending`, `.subagentQueue.pending`.

2. **Crash check** — if `.state` is `stalled` or `failed` AND `.worklist.pending > 0`:
   - Increment `relaunchCounter`.
   - If `relaunchCounter ≤ 3`: relaunch (`{{PMC_BIN}} enrich .` via Bash `run_in_background: true`);
     report "PMC enrichment crashed — relaunched (attempt N/3)."; continue loop.
   - If `relaunchCounter > 3`: stop and report:
     "PMC enrichment crashed 3 times. Run `/pmc-doctor` or inspect the terminal for errors."

3. **Subagent drain** — if `.subagentQueue.pending > 0`:
   - Read `.planning/project-memory-context/enrichment/subagent-queue.json`.
   - Collect entries with `status: "pending"`.
   - Fill available slots up to **3 parallel subagents** (accounting for any still in-progress from
     the previous iteration). For each dispatched entry:
     a. Launch a Task subagent (`subagent_type: general-purpose`) with this prompt:
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

4. **Exit condition** — stop the loop when ALL of:
   - `.state` is `finished` (Ollama queue done or nothing was queued for it)
   - `.subagentQueue.pending` is `0`
   - `inProgressSubagents` is empty (all dispatched subagents have returned)

   If `.state` is `finished` but `.subagentQueue.pending > 0` or subagents are still in progress,
   **keep looping** (no more Ollama wait needed — just drain the remaining subagents).

### Step 4 — Success criteria

- `.worklist.pending` = 0
- `.subagentQueue.pending` = 0
- Sync-manifest updated with new entries

Suggest running `{{PMC_BIN}} sync-context` to persist all new memories to agent-memory.
