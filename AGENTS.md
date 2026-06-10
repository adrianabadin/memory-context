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
## PMC Session Autostart

PMC installs an auto-loaded OpenCode plugin at `.opencode/plugins/pmc.mjs`. On every OpenCode startup the plugin runs a zero-token Node runtime that: launches `refresh-context --enrich` in the background (hash-incremental), launches background enrichment + watchdog if pending symbols exist, ensures a single detached file watcher per project (5-minute per-file quiet debounce → automatic refresh + enrich), and writes the startup snapshot to `.planning/project-memory-context/runs/session-start/latest.json` / `latest.md`. Nothing blocks the session; check `pmc watch . --status` or the snapshot to inspect state.

**If the PMC plugin is not installed or is disabled**, run this once per session:

```bash
pmc session-start .
```

Do not manually recreate startup checks in the chat if the plugin already handled startup.

This command handles everything deterministic in one shot:
- Checks enrichment status; launches background enrich + watchdog if needed
- Reports pending sync operations (run `/sync-context` to apply)
- Loads project context from materialized disk artifacts (no MCP round-trip)
- Reports if LLM subagent drain is needed
- Ensures the file watcher is running (PID + heartbeat tracked; `pmc watch . --status` / `--stop` to manage)

**If the session summary reports `subagentQueue.pending > 0`**, dispatch the `enrich` subagent to drain those entries — that is the only step that requires LLM involvement.

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
