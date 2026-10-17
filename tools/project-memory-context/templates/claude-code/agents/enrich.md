---
name: enrich
description: Run batch semantic enrichment for pending symbols in the PMC worklist. Launches the Ollama CLI and concurrently drains the subagent queue (symbols >=5k tokens or >=80% file coverage) every >=120s. Use when the user asks to enrich, index, analyze, or process pending symbols, or when enrichment is needed on demand.
tools: Bash, Read, Write
---

# Enrichment — Ollama + Subagent Drain

**Strategy:** Launch `{{PMC_BIN}} enrich .` (Ollama). Ollama automatically marks symbols >=5k tokens as `subagent-queued`. The watchdog drains that queue concurrently with 3 parallel subagents (1 symbol each, plain text), running every ≥120s while Ollama works.

---

## Step 1 — Check current state

Run `{{PMC_BIN}} enrich-status` first.

- `.state` is `running` AND `.worklist.pending > 0` → Ollama already active. Skip to **Step 3**.
- `.state` is `finished` AND `.worklist.pending` is 0 AND `.subagentQueue.pending` is 0 → nothing to do. Report and stop.
- `.state` is `finished` AND `.subagentQueue.pending > 0` → skip to **Step 3** (drain only).
- Otherwise → proceed to **Step 2**.

---

## Step 2 — Launch Ollama

Report: "PMC: N symbols pending enrichment — launching…"

```bash
{{PMC_BIN}} enrich . --background
```

⚠️ `--background` detaches the process cross-platform (Node.js `detached+unref`). Never use `PowerShell Start-Process -WindowStyle Hidden` — crashes silently, leaves stalled queue.

---

## Step 3 — Concurrent watchdog + subagent drain

Run every **≥120 seconds**. Track `relaunchCounter` (cap: 3) and `inProgressSubagents` set.

**Each iteration:**

1. **Apply completed subagents**: for each in `inProgressSubagents` that returned, write response to temp file → `{{PMC_BIN}} subagent-apply . --entry-id <id> --content-file <tmp>` → delete temp file → remove from set.

2. **Crash check**: if `.state` is `stalled`/`failed` AND `.worklist.pending > 0` → increment `relaunchCounter`. If ≤ 3: relaunch `{{PMC_BIN}} enrich . --background`. If > 3: stop and report "PMC enrichment crashed 3 times. Run `/pmc-doctor`."

3. **Drain**: if `.subagentQueue.pending > 0` AND `inProgressSubagents` < 3 → read `subagent-queue.json`, collect `status: "pending"` entries, fill slots up to 3. For each, launch a subagent (`subagent_type: general-purpose`):
   ```
   You are enriching a code symbol for a project memory index.
   Return ONLY the structured explanation — no preamble, no markdown fences.

   <entry.prompt>
   ```

4. **Exit** when `.state` is `finished` + `.subagentQueue.pending` is `0` + no in-progress subagents.

---

## Step 4 — Report

```
Enrichment complete:
  - Ollama enriched: N symbols
  - Subagents enriched: M symbols (>=5k tokens)
  - Errors: X (run /retry-errors if > 0)
```

Suggest: "Run `{{PMC_BIN}} sync-context` to persist all new memories to agent-memory."
