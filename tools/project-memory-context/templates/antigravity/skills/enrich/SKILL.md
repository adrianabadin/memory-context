---
name: enrich
description: "Launch batch semantic enrichment for pending symbols in the PMC worklist. Launches the Ollama CLI and concurrently drains the subagent queue (symbols >=5k tokens or >=80% file coverage) every >=120s. Use when the user asks to enrich, index, analyze, or process pending symbols, or when enrichment is needed on demand."
allowed-tools: Bash Read Write Agent
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

### 3a — Apply completed subagents

For each subagent in `inProgressSubagents` that has returned:
```bash
cat > /tmp/enrich-<entry.id>.txt << 'EOF'
<subagent plain text response>
EOF
{{PMC_BIN}} subagent-apply . --entry-id <entry.id> --content-file /tmp/enrich-<entry.id>.txt
rm /tmp/enrich-<entry.id>.txt
```
Remove from `inProgressSubagents`.

### 3b — Crash check

Run `{{PMC_BIN}} enrich-status`. If `.state` is `stalled` or `failed` AND `.worklist.pending > 0`:
- Increment `relaunchCounter`.
- If ≤ 3: relaunch `{{PMC_BIN}} enrich . --background`; report "PMC enrichment crashed — relaunched (N/3)."
- If > 3: stop and report "PMC enrichment crashed 3 times. Run `/pmc-doctor`."

### 3c — Drain subagent queue

If `.subagentQueue.pending > 0` AND `inProgressSubagents` has < 3 in-flight:
- Read `.planning/project-memory-context/enrichment/subagent-queue.json`.
- Collect entries with `status: "pending"`.
- Fill available slots up to 3 total in-flight.
- For each dispatched entry, launch a subagent:
  ```
  You are enriching a code symbol for a project memory index.
  Return ONLY the structured explanation — no preamble, no markdown fences.

  <entry.prompt>
  ```
- Add handle to `inProgressSubagents`.

### 3d — Exit condition

Stop when ALL of:
- `.state` is `finished`
- `.subagentQueue.pending` is `0`
- `inProgressSubagents` is empty

---

## Step 4 — Report success

```
Enrichment complete:
  - Ollama enriched: N symbols
  - Subagents enriched: M symbols (large, >=5k tokens)
  - Errors: X (run /retry-errors if > 0)
```

Suggest: "Run `/sync-context` to persist all new memories to agent-memory."
