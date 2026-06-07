# AGENTS.md

## Project Memory Context (PMC) Toolkit

This repository hosts the canonical implementation of PMC (Project Memory Context) — a structural-memory toolchain that gives AI agents persistent, queryable knowledge about codebases via knowledge graphs, semantic enrichment, and agent-memory integration.

PMC is **distributed as an npm package** (`@aabadin/project-memory-context`) consumed by other repositories. This is the **development / source** repository.

## Documentation

For contributor and developer documentation, see:
- **CONTRIBUTING.md** — Quick start, common workflows, where things live
- **docs/ARCHITECTURE.md** — How PMC works, key concepts, the 9 base memories
- **docs/DEVELOPMENT.md** — Setup, testing, running enrichment, debugging
- **docs/COMMANDS.md** — All `pmc` subcommands with examples

## Adding new PMC features

When adding new commands or features, follow the **standard PMC workflow**: brainstorm → design spec → implementation plan → test-driven implementation. See `docs/DEVELOPMENT.md` for details.

---

## PTY Plugin Policy (ENFORCED)

PMC background processes (enrichment, file watching, refresh-context) are long-running. Without PTY, they run as **blocking Bash calls** that freeze the agent, or invisible background processes that cannot be monitored, recovered, or inspected.

### Step 0: Detect PTY availability (EVERY session)

At the **very start of every session**, before any other autostart step:

1. Call `pty_list`. If it succeeds (returns a list, even empty), set `HAS_PTY = true`.
2. If `pty_list` fails or the tool does not exist, set `HAS_PTY = false`.

### When PTY is NOT installed

1. **Inform the user immediately:**
   > "The `opencode-pty` plugin is not installed. PMC works best with PTY support — without it, all background processes (enrichment, file watching, refresh-context) block the session or run invisibly with no crash recovery.
   >
   > Do you want me to install it? I'll add `\"opencode-pty\"` to `.opencode/opencode.json` — you'll need to restart OpenCode once."

2. **If the user agrees**, add `"opencode-pty"` to the `plugin` array in `.opencode/opencode.json` (create the file if needed, preserve existing entries):
   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "plugin": ["opencode-pty"]
   }
   ```
   Then: "Plugin added. Please restart OpenCode to activate PTY tools."

3. **If the user declines or PTY remains unavailable**, fall back to Bash for the current session, but:
   - **Every time** a blocking Bash call is about to run a long-running process (`pmc enrich`, `pmc watch`, `pmc refresh-context --enrich`), emit a one-line reminder:
     > "`<command>` running as blocking Bash (PTY unavailable). Install `opencode-pty` for non-blocking execution with crash recovery."
   - Do NOT repeat the full installation pitch — just the one-line reminder each time.

### PTY-first execution rule

When `HAS_PTY = true`, **always prefer PTY** over Bash for any process that:
- Takes longer than ~10 seconds (enrichment, refresh-context, watch)
- Runs in the background (enrichment, file watcher)
- Needs crash recovery or output inspection

Use Bash only for quick synchronous commands (<10s): `pmc get-context`, `pmc enrich-status`, `pmc sync-context`, `pmc status`, etc.

---

<!-- pmc:autostart -->
## Session autostart (MANDATORY)

On EVERY session start, BEFORE responding to the user, execute these steps IN ORDER:

### Step 0: Detect PTY plugin

See **PTY Plugin Policy** above. Determine `HAS_PTY` for the rest of this sequence.

### Step 1: Check enrichment status and launch

Read `.planning/project-memory-context/enrichment/worklist.json`.
Count entries with `status: "pending"` or `status: "stale"`. **Report the count to the user**
(e.g. "PMC: 12 symbols pending enrichment").

If count > 0, launch enrichment:

**With PTY (preferred):**
```
pty_spawn:
  command: "node"
  args: ["tools/project-memory-context/cli/enrich-queue.mjs", "."]
  title: "PMC Enrichment"
  notifyOnExit: true
  description: "Background PMC enrichment queue"
```
For consumer projects (no `tools/` dir): `command: "pmc"`, `args: ["enrich", "."]` — use the **globally-installed** `pmc` binary (resolved via PATH), NOT `npx`. `npx` downloads the package into a temp cache and tries to delete it on exit; since `enrich` is a long-running process that keeps native modules (e.g. `tree-sitter-cli`) open, Windows locks those files and npx's cleanup fails with `EBUSY`/`EPERM` errors. If `pmc` is not found in PATH, tell the user to run `npm install -g @aabadin/project-memory-context` rather than falling back to `npx` for this long-running launch.

After spawning, start the **PTY-based watchdog** (Step 1a).

**Without PTY (fallback):**
```bash
pmc enrich . --background
```
Emit the blocking-Bash reminder. Do NOT use PowerShell `Start-Process -WindowStyle Hidden` — it inherits a restricted PATH, crashes silently, and stalls for ~90s.

### Step 1a: PTY-based watchdog (when HAS_PTY = true)

Run a **concurrent watchdog + subagent drain** loop after spawning enrichment.
Cap: 3 auto-relaunches. Poll every **>=120 seconds**:

1. `pty_read` on the enrichment session — scan for errors or progress.
2. Run `pmc enrich-status` (Bash, quick); read `.state`, `.worklist.pending`, `.subagentQueue.pending`.
3. State handling:
   - `running` → alive. Check subagent queue (see below). Wait >=120s.
   - `finished` AND `.subagentQueue.pending` = 0 → **done**. Report completion summary, stop watchdog.
   - `finished` AND `.subagentQueue.pending > 0` → keep looping to drain remaining subagents.
   - `stalled` or `failed` AND `.worklist.pending > 0` → **crashed**:
     - `pty_kill` the dead session (with `cleanup: true`).
     - `pty_spawn` a new enrichment session.
     - Report: "PMC enrichment crashed — relaunched (attempt N/3)".
   - After 3 failed relaunches: tell the user to run `/pmc-doctor`.
4. On `<pty_exited>` notification with non-zero exit code → treat as crash, apply step 3 crash logic.

**Without PTY (fallback watchdog):**
Poll `pmc enrich-status` every >=120s via Bash. On `stalled`/`failed`, relaunch via Bash.

**Concurrent subagent drain** — on every poll iteration, if `.subagentQueue.pending > 0`:
- Read `enrichment/subagent-queue.json`; take up to 3 entries with `status: "pending"`.
- For each: dispatch a Task subagent with `entry.prompt` → write response to temp file →
  run `pmc subagent-apply . --entry-id <id> --content-file <tmpfile>` → delete temp file.
- This runs **concurrently** with the Ollama CLI — do not wait for Ollama to finish first.

### Step 2: Launch file watcher via PTY (when HAS_PTY = true)

Spawn the file watcher as a persistent background PTY session:

```
pty_spawn:
  command: "node"
  args: ["tools/project-memory-context/cli/watch.mjs", "."]
  title: "PMC File Watcher"
  notifyOnExit: true
  description: "Watches files, debounced refresh-context --enrich"
```
For consumer projects: `command: "pmc"`, `args: ["watch", "."]` — use the **globally-installed** `pmc` binary (resolved via PATH), NOT `npx`. Same reasoning as the enrich launch above: `watch` is a persistent process holding native modules open, and `npx`'s post-run cache cleanup fails with `EBUSY`/`EPERM` on Windows when those files are still locked. If `pmc` is not found in PATH, tell the user to run `npm install -g @aabadin/project-memory-context` rather than falling back to `npx`.

This process uses a built-in 2-second debounce: when source files change (`.ts`, `.tsx`, `.mjs`, `.js`, `.jsx`, `.cs`), it waits 2 seconds of inactivity, then runs `pmc refresh-context --enrich` automatically. The agent does **not** need to manually trigger refresh-context after edits — the watcher handles it.

**Crash recovery:** If the watcher PTY exits (`<pty_exited>` notification), **restart it immediately** with a new `pty_spawn`. No relaunch cap — the watcher is lightweight and should always be running.

**Without PTY:** The opencode-refresh-hook plugin handles this automatically via the `tool.execute.after` hook with a 5-minute debounce. No agent action needed, but the agent loses visibility into when refreshes happen and has no crash recovery.

### Step 3: Check sync-manifest

Read `.planning/project-memory-context/enrichment/sync-manifest.json`. If `entries` contains any element with `status: "pending"`, surface: "PMC has N pending sync operations. Run `/sync-context` to apply them."

### Step 4: Recall base context

Call `agent-memory_search` with `query: "project context overview"` and `tags: ["project-context"]`. Present a brief summary (~500 tokens) to establish session context.

### Step 5: Remind

"Use `/get-context <target>` for structural deep-dive BEFORE reading files."

### Step 6: Load PMC workflow rules

Read and apply the `pmc-skill` skill instructions (`.agents/skills/pmc-skill/SKILL.md`). These rules govern how you interact with PMC throughout the session — query PMC before reading files, available commands, MCP tools, and enrichment launch rules.

<!-- /pmc:autostart -->

---

## Mandatory PMC Workflow (ENFORCED)

- **BEFORE reading any source file**: Run `pmc get-context <file-or-symbol>` FIRST. Do NOT open files without first checking PMC context.
- **AFTER implementing code changes**:
  - **If the PTY file watcher is running** (Step 2): no manual action needed — the watcher detects file changes, debounces, and runs `pmc refresh-context --enrich` automatically. Run `pmc sync-context` after the watcher's refresh completes (check via `pty_read` on the watcher session).
  - **If the PTY file watcher is NOT running**: Run `pmc refresh-context --enrich` via PTY (if available) or Bash, then `pmc sync-context`.
    - **With PTY:** `pty_spawn` with `command: "node"`, `args: ["tools/project-memory-context/cli/refresh-context.mjs", ".", "--enrich"]`, `title: "PMC Refresh"`, `notifyOnExit: true`. Wait for `<pty_exited>`, then run `pmc sync-context` via Bash.
    - **Without PTY:** Run via Bash (blocking). Emit the blocking-Bash reminder.
- **Default context depth**: Always use `depth=compact`. Use `extended` or `deep` ONLY when explicitly asked.
- **`map-project --all`** is only needed for full reinstall or ground-up graph rebuild. Day-to-day, `refresh-context` keeps everything current.

## Checking enrichment status

When the user asks whether enrichment is currently running:
- **With PTY**: Check `pty_list` for the "PMC Enrichment" session. If found, `pty_read` its latest output and report status.
- **Without PTY**: Run `node tools/project-memory-context/cli/status.mjs .` (source repo) or `pmc enrich-status .` via the globally-installed binary (consumer — note: there is no `pmc-status` binary, the subcommand is `enrich-status`) and report the top-level `state` and `runtime.heartbeatAt`.

## CLI resolution

To resolve the PMC CLI for any command:
- **Source repo** (this repo): `node tools/project-memory-context/cli/<command>.mjs <args>`
- **Consumer projects**: prefer the **globally-installed** `pmc` binary — `pmc <command> <args>` (resolved via PATH; there is no `pmc-<command>` binary, subcommands are passed as the first argument, e.g. `pmc enrich .`, `pmc enrich-status .`). Only fall back to `npx --yes --package @aabadin/project-memory-context pmc <command> <args>` for quick one-shot commands when `pmc` is not installed globally — never use `npx` to launch long-running/persistent processes (`enrich`, `watch`): npx's post-run cache cleanup collides with files those processes keep open, producing `EBUSY`/`EPERM` errors on Windows.
- Detect by checking if `tools/project-memory-context/cli/` exists in the project root.

## Context Retrieval Rules

| Situation | Command | Depth |
|-----------|---------|-------|
| About to read a file | `pmc get-context <file>` | compact |
| Working on a specific symbol | `pmc get-context <symbol>` | compact |
| Need dependency information | `pmc get-context <symbol> extended dependencies` | extended |
| Debugging complex issues | `pmc get-context <symbol> deep all` | deep |
| Need raw source code | `pmc get-context <symbol> disk` | disk |
| Quick project overview | `agent-memory_search "project context overview"` | -- |
| After code changes (no watcher) | `pmc refresh-context --enrich` then `pmc sync-context` | -- |
| After code changes (watcher active) | Automatic — just run `pmc sync-context` after | -- |
