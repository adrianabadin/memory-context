# OpenCode PTY-Aware Command Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the four OpenCode slash-command templates (`enrich`, `enrich-status`, `refresh-context`, `sync-context`) prefer PTY (`pty_spawn`/`pty_read`/`pty_kill`) over blocking Bash when the `opencode-pty` plugin is available, falling back to the existing `{{PMC_BIN}}` + Bash invocation otherwise.

**Architecture:** Each template is a Markdown instruction file consumed by an LLM agent (no executable code, no automated tests). Each gets a "PTY-first execution" section inserted before its existing execution steps, following the exact `HAS_PTY` detection convention already established in `templates/opencode/autostart-snippet.md`. The `allowed-tools` frontmatter is extended with the four PTY tool names. Validation is manual: re-read each file end-to-end and diff its PTY section against the autostart's conventions for consistency.

**Tech Stack:** Markdown (OpenCode command template format with YAML frontmatter), `opencode-pty` plugin tools (`pty_list`, `pty_spawn`, `pty_read`, `pty_kill`).

**Spec:** `docs/superpowers/specs/2026-06-07-opencode-pty-commands-design.md`

---

### Task 1: Add PTY-first execution to `enrich.md`

**Files:**
- Modify: `tools/project-memory-context/templates/opencode/commands/enrich.md`

- [ ] **Step 1: Update `allowed-tools` frontmatter**

Open the file and replace the frontmatter block:

```markdown
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
```

- [ ] **Step 2: Replace "Step 2 — Launch Ollama" with a PTY-first version**

Find this block:

```markdown
## Step 2 — Launch Ollama

Report: "PMC: N symbols pending enrichment — launching…"

\`\`\`bash
{{PMC_BIN}} enrich . --background
\`\`\`

⚠️ `--background` detaches the process cross-platform (Node.js `detached+unref`). Never use `PowerShell Start-Process -WindowStyle Hidden` — crashes silently, leaves stalled queue.
```

Replace it with:

```markdown
## Step 2 — Launch Ollama

Report: "PMC: N symbols pending enrichment — launching…"

**Detect PTY:** Call `pty_list`. Success (even an empty list) → `HAS_PTY = true`. Failure or tool absent → `HAS_PTY = false`.

**With PTY (preferred):**
\`\`\`
pty_spawn:
  command: "{{PMC_BIN}}"
  args: ["enrich", "."]
  title: "PMC Enrichment"
  notifyOnExit: true
  description: "Background PMC enrichment queue"
\`\`\`
This replaces the `--background` flag entirely — PTY already gives a non-blocking, inspectable, crash-recoverable session. Use `pty_read` to check progress and `pty_kill` + a fresh `pty_spawn` to relaunch on crash (see Step 3's relaunch logic, which applies regardless of launch method).

**Without PTY (fallback):**
\`\`\`bash
{{PMC_BIN}} enrich . --background
\`\`\`
⚠️ `--background` detaches the process cross-platform (Node.js `detached+unref`). Never use `PowerShell Start-Process -WindowStyle Hidden` — crashes silently, leaves stalled queue.
```

- [ ] **Step 3: Verify the file reads coherently end-to-end**

Read the full file. Confirm:
- The PTY detection wording matches `templates/opencode/autostart-snippet.md` Step 0 (same `pty_list` → `HAS_PTY` convention).
- Step 3 (the watchdog loop) still makes sense unchanged — it operates on `enrich-status` state regardless of how the process was launched, so no edits needed there.
- No leftover references to `--background` in the PTY branch.

- [ ] **Step 4: Commit**

```bash
git add tools/project-memory-context/templates/opencode/commands/enrich.md
git commit -m "feat(opencode): prefer PTY for enrich command template launch"
```

---

### Task 2: Add PTY-first execution to `enrich-status.md`

**Files:**
- Modify: `tools/project-memory-context/templates/opencode/commands/enrich-status.md`

- [ ] **Step 1: Replace the entire file content**

This file is small; replace its whole body (keep the `<objective>` wrapper, update frontmatter and `<execution>`):

```markdown
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

**With PTY (preferred):**
\`\`\`
pty_spawn:
  command: "{{PMC_BIN}}"
  args: ["enrich-status"]
  title: "PMC Enrich Status"
  notifyOnExit: true
  description: "One-shot enrichment status check"
\`\`\`
Use `pty_read` to capture the worklist summary output, then `pty_kill` to close the session — this is a one-shot check, not a persistent process.

**Without PTY (fallback):**
\`\`\`bash
{{PMC_BIN}} enrich-status
\`\`\`

Either way, the output shows the worklist summary with counts for pending, enriched, stale, and failed symbols.
</execution>
```

- [ ] **Step 2: Verify the file reads coherently end-to-end**

Read the full file. Confirm the `<objective>`/`<execution>` structure is preserved, the PTY branch correctly notes this is a one-shot check (spawn → read → kill, not a long-lived session), and the Bash fallback matches the original command exactly.

- [ ] **Step 3: Commit**

```bash
git add tools/project-memory-context/templates/opencode/commands/enrich-status.md
git commit -m "feat(opencode): prefer PTY for enrich-status command template"
```

---

### Task 3: Add PTY-first execution to `refresh-context.md`

**Files:**
- Modify: `tools/project-memory-context/templates/opencode/commands/refresh-context.md`

- [ ] **Step 1: Replace the "Command" and "After running" sections**

Find this block:

```markdown
## Command

\`\`\`bash
{{PMC_BIN}} refresh-context
\`\`\`

## Options

\`\`\`
--enrich    Launch background enrichment automatically if there are pending symbols
\`\`\`
```

Replace it with:

```markdown
## Command

**Detect PTY:** Call `pty_list`. Success (even an empty list) → `HAS_PTY = true`. Failure or tool absent → `HAS_PTY = false`.

**With PTY (preferred):**
\`\`\`
pty_spawn:
  command: "{{PMC_BIN}}"
  args: ["refresh-context"]
  title: "PMC Refresh Context"
  notifyOnExit: true
  description: "Incremental graph + worklist refresh"
\`\`\`
Pass `args: ["refresh-context", "--enrich"]` instead when launching enrichment automatically (see Options below). Use `pty_read` to capture the refresh summary, `pty_kill` to close the session once it completes (this is a bounded, one-shot operation, not a persistent watcher).

**Without PTY (fallback):**
\`\`\`bash
{{PMC_BIN}} refresh-context
\`\`\`

## Options

\`\`\`
--enrich    Launch background enrichment automatically if there are pending symbols
\`\`\`
```

- [ ] **Step 2: Replace the "After running" section**

Find this block:

```markdown
## After running

- Without `--enrich`: run `{{PMC_BIN}} enrich . --background` then `{{PMC_BIN}} sync-context`.
- With `--enrich`: enrichment is already running in background; run `{{PMC_BIN}} sync-context` after it finishes.
```

Replace it with:

```markdown
## After running

- Without `--enrich`: launch enrichment (`/enrich` — PTY-first per its own template) then `sync-context` (`/sync-context` — PTY-first per its own template).
- With `--enrich`: enrichment is already running (via the PTY session spawned above, or in background if PTY was unavailable); run `sync-context` (`/sync-context`) after it finishes.
```

- [ ] **Step 3: Verify the file reads coherently end-to-end**

Read the full file. Confirm:
- The "When to run" and "What it does" sections are untouched.
- The PTY branch correctly distinguishes `refresh-context` (bounded, one-shot — spawn/read/kill) from `enrich`/`watch` (persistent, long-running — spawn and leave running), matching how the autostart snippet treats them differently.
- "After running" no longer hardcodes Bash invocations and instead routes through the sibling commands' own PTY-first templates.

- [ ] **Step 4: Commit**

```bash
git add tools/project-memory-context/templates/opencode/commands/refresh-context.md
git commit -m "feat(opencode): prefer PTY for refresh-context command template"
```

---

### Task 4: Add PTY-first execution to `sync-context.md`

**Files:**
- Modify: `tools/project-memory-context/templates/opencode/commands/sync-context.md`

- [ ] **Step 1: Replace the frontmatter and `<execution>` block**

Find this block:

```markdown
---
name: sync-context
description: Upsert enriched memories from the sync-manifest into agent-memory.
argument-hint: ""
allowed-tools:
  - Bash
---

<objective>
Apply pending sync-manifest operations through the PMC framework command.
</objective>

<execution>
Run:

\`\`\`bash
{{PMC_BIN}} sync-context
\`\`\`

This processes `.planning/project-memory-context/enrichment/sync-manifest.json`, applies pending upserts and deletes through PMC's sync flow, and marks completed entries as synced.
</execution>
```

Replace it with:

```markdown
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
Apply pending sync-manifest operations through the PMC framework command.
</objective>

<execution>
**Detect PTY:** Call `pty_list`. Success (even an empty list) → `HAS_PTY = true`. Failure or tool absent → `HAS_PTY = false`.

**With PTY (preferred):**
\`\`\`
pty_spawn:
  command: "{{PMC_BIN}}"
  args: ["sync-context"]
  title: "PMC Sync Context"
  notifyOnExit: true
  description: "Upsert enriched memories from sync-manifest into agent-memory"
\`\`\`
Use `pty_read` to capture the sync summary, then `pty_kill` to close the session — this is a one-shot operation, not a persistent process.

**Without PTY (fallback):**
\`\`\`bash
{{PMC_BIN}} sync-context
\`\`\`

Either way, this processes `.planning/project-memory-context/enrichment/sync-manifest.json`, applies pending upserts and deletes through PMC's sync flow, and marks completed entries as synced.
</execution>
```

- [ ] **Step 2: Verify the file reads coherently end-to-end**

Read the full file. Confirm the `<objective>`/`<execution>`/`<success_criteria>` structure is preserved (the `<success_criteria>` block at the end of the original file is untouched), and the PTY branch follows the same spawn/read/kill one-shot pattern as `enrich-status.md`.

- [ ] **Step 3: Commit**

```bash
git add tools/project-memory-context/templates/opencode/commands/sync-context.md
git commit -m "feat(opencode): prefer PTY for sync-context command template"
```

---

### Task 5: Cross-template consistency pass

**Files:**
- Read-only review of all four files modified in Tasks 1-4

- [ ] **Step 1: Re-read all four templates back to back**

Open and read, in order:
1. `tools/project-memory-context/templates/opencode/commands/enrich.md`
2. `tools/project-memory-context/templates/opencode/commands/enrich-status.md`
3. `tools/project-memory-context/templates/opencode/commands/refresh-context.md`
4. `tools/project-memory-context/templates/opencode/commands/sync-context.md`

- [ ] **Step 2: Check for consistency issues**

Confirm across all four:
- The `HAS_PTY` detection wording is byte-for-byte identical (copy-paste, not paraphrased) in each file, and matches `templates/opencode/autostart-snippet.md` Step 0.
- `pty_spawn` blocks all use `command: "{{PMC_BIN}}"` (never a hardcoded path or `npx`).
- One-shot commands (`enrich-status`, `refresh-context`, `sync-context`) document spawn → read → kill; the persistent command (`enrich`) documents spawn-and-leave-running with `notifyOnExit: true`, matching the autostart's treatment of `enrich`/`watch` as long-lived.
- `allowed-tools` frontmatter is identical across all four (same four PTY tools + `Bash`).

If any inconsistency is found, fix it directly in the relevant file and amend that file's commit:

```bash
git add tools/project-memory-context/templates/opencode/commands/<file>.md
git commit --amend --no-edit
```

(Only amend the most recent commit for that file — if the inconsistency is in a file from an earlier task/commit, make a new fix-up commit instead of amending an old one.)

- [ ] **Step 3: Final commit confirming the pass (only if fixes were made as new commits)**

If Step 2 required any new fix-up commits (not amendments), this task is done — no separate commit needed. If no issues were found, this task required no commits; just report "Cross-template consistency pass: no issues found."

---

## Manual validation (after all tasks complete)

This is a documentation/template change with no automated test surface (per the spec's Testing section). To validate:

1. In this repo, run `{{PMC_BIN}} init .` (or the equivalent install/refresh-templates flow) to copy the updated templates into `.opencode/command/`.
2. Open each of the four installed command files and confirm the PTY sections rendered correctly (no broken Markdown, frontmatter parses).
3. If `opencode-pty` is installed locally, invoke `/enrich-status` and `/sync-context` and confirm the agent follows the PTY branch (calls `pty_list`, then `pty_spawn`).
4. If `opencode-pty` is not installed, confirm the agent falls back to the Bash branch exactly as before (no regression in current behavior).

## Rollout to consumer repos

Per the spec's Rollout section — this is an operational follow-up for the user, not part of this plan's task list:

1. Bump version and `npm publish` from `tools/project-memory-context/`.
2. In each consumer repo: `npm install -g @aabadin/project-memory-context@latest`.
3. Re-run `pmc init .` (or equivalent) in each consumer repo to force-overwrite `.opencode/command/*.md` with the new templates.
