---
name: enrich
description: "Launch enrichment for all pending symbols. Ollama processes all symbols and automatically marks those >=5k tokens as subagent-queued. The watchdog drains that queue concurrently with 3 parallel subagents every >=120s."
argument-hint: ""
allowed-tools:
  - Bash
  - pty_list
  - pty_spawn
  - pty_read
  - pty_kill
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

**Detect PTY:** Call `pty_list`. Success (even an empty list) → `HAS_PTY = true`. Failure or tool absent → `HAS_PTY = false`.

**With PTY (preferred):** `{{PMC_BIN}}` resolves to a `.ps1`/`.cmd` shim on Windows that
PTY cannot spawn directly ("PTY spawn failed") — host it through a shell:

- **Windows:**
  ```
  pty_spawn:
    command: "cmd"
    args: ["/d", "/s", "/c", "{{PMC_BIN}} enrich ."]
    title: "PMC Enrichment"
    notifyOnExit: true
    description: "Background PMC enrichment queue"
  ```
- **macOS/Linux:**
  ```
  pty_spawn:
    command: "{{PMC_BIN}}"
    args: ["enrich", "."]
    title: "PMC Enrichment"
    notifyOnExit: true
    description: "Background PMC enrichment queue"
  ```

This replaces the `--background` flag entirely — PTY already gives a non-blocking, inspectable, crash-recoverable session. Use `pty_read` to check progress and `pty_kill` + a fresh `pty_spawn` (same platform-specific form) to relaunch on crash (see Step 3's relaunch logic, which applies regardless of launch method).

**Without PTY (fallback):**
```bash
{{PMC_BIN}} enrich . --background
```
⚠️ `--background` detaches the process cross-platform (Node.js `detached+unref`). Never use `PowerShell Start-Process -WindowStyle Hidden` — crashes silently, leaves stalled queue.

---

## Step 3 — Concurrent watchdog + subagent drain

Run every **≥120 seconds**. Track `relaunchCounter` (cap: 3) and `inProgressSubagents` set.

**Each iteration:**

1. **Apply completed subagents**: for each in `inProgressSubagents` that returned, write response to temp file → `{{PMC_BIN}} subagent-apply . --entry-id <id> --content-file <tmp>` → delete temp file → remove from set.

2. **Crash check**: if `.state` is `stalled`/`failed` AND `.worklist.pending > 0` → increment `relaunchCounter`. If ≤ 3: relaunch — with PTY, `pty_kill` the existing session and `pty_spawn` a fresh one with the same platform-specific config as Step 2 (Windows: `command: "cmd", args: ["/d","/s","/c","{{PMC_BIN}} enrich ."]`; POSIX: `command: "{{PMC_BIN}}", args: ["enrich", "."]`); without PTY, relaunch `{{PMC_BIN}} enrich . --background`. If > 3: stop and report.

3. **Drain**: if `.subagentQueue.pending > 0` AND `inProgressSubagents` < 3 → read `subagent-queue.json`, collect `status: "pending"` entries, fill slots up to 3. For each, launch subagent:
   ```
   You are enriching a code symbol for a project memory index.
   Return ONLY the structured explanation — no preamble, no markdown fences.

   <entry.prompt>
   ```

4. **Exit** when `.state` is `finished` + `.subagentQueue.pending` is `0` + no in-progress subagents.

---

## Step 4 — Report

Counts (Ollama enriched, subagents enriched >=5k tokens, errors). Suggest `/sync-context`.
