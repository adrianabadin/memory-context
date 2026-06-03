---
name: enrich
description: "Launch batch semantic enrichment for all pending symbols. Handles both Ollama queue (run by CLI) and subagent queue (symbols >10k tokens, dispatched as Task subagents). Use when the user asks to enrich, index, or process all pending symbols."
allowed-tools: Bash Read Write TaskCreate TaskGet TaskUpdate
---

# Batch Enrichment — `pmc enrich`

Run batch semantic enrichment for all pending/stale symbols.

Enrichment now has two queues:
- **Ollama queue (<10k tokens):** processed sequentially by the CLI in background.
- **Subagent queue (>=10k tokens):** processed by Task subagents dispatched by this skill (up to 5 in parallel).

## Launch

⚠️ Always launch via the **Bash tool with `run_in_background: true`**.

Do NOT use PowerShell `Start-Process -WindowStyle Hidden` — it inherits a restricted PATH,
crashes silently, and leaves a stalled queue-state.

### Step 1 — Check current state

Run `pmc enrich-status` first.
- If `.state` is `running`, enrichment is already active — skip to Step 3 watchdog.
- If `.state` is `finished` and `.worklist.pending` is 0, check if `.subagentQueue.pending > 0`
  and jump directly to Step 4.

### Step 2 — Report pending count and launch

Report to the user: "PMC: N symbols pending enrichment — launching…"

```bash
pmc enrich .
```

### Step 3 — Still-Alive watchdog (automatic relaunch, cap: 3 attempts)

Repeat until `state` is `finished` or the relaunch cap is reached:

1. Run `pmc enrich-status` and read `.state` and `.worklist.pending`.
2. `running` → process is alive; wait ~30 s and check again.
3. `finished` → CLI queue done; report Ollama counts (`enriched` / `errors`) and proceed to Step 4.
4. `stalled` or `failed`, AND `.worklist.pending > 0`:
   - Increment relaunch counter.
   - If counter ≤ 3: relaunch (`pmc enrich .` via Bash `run_in_background: true`);
     report "PMC enrichment crashed — relaunched (attempt N/3)."; resume from step 1.
   - If counter > 3: stop and report:
     "PMC enrichment crashed 3 times. Run `/pmc-doctor` or inspect the terminal for errors."

### Step 4 — Drain the subagent queue (symbols >=10k tokens)

After the CLI finishes, check for subagent-queued symbols:

```bash
pmc enrich-status
```

Read `.subagentQueue.pending`. If `> 0`:

1. Read `enrichment/subagent-queue.json` to get pending entries (entries with `status: "pending"`).
2. Maintain a pool of **up to 5 Task subagents** running in parallel. For each pending entry:
   a. Launch a Task subagent (`subagent_type: general-purpose`) with this prompt:
      ```
      You are enriching a code symbol for a project memory index.
      Return ONLY the structured explanation — no preamble, no markdown fences.

      <prompt from the queue entry>
      ```
   b. When the subagent returns, write its response to a temp file:
      ```bash
      Write content to a temp file, then run:
      pmc subagent-apply . --entry-id <entry.id> --content-file <tmpfile>
      ```
   c. Remove the temp file. Launch the next pending entry.
3. Keep the pool full (5 slots) until the queue is empty.
4. Report: "Subagent queue drained: N done, M errors."

### Step 5 — Success criteria

- `.worklist.pending` = 0
- `.subagentQueue.pending` = 0
- Sync-manifest updated with new entries

Suggest running `pmc sync-context` to persist all new memories to agent-memory.
