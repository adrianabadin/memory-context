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

## Session autostart (MANDATORY)

On EVERY session start, BEFORE responding to the user, execute these steps IN ORDER:

1. **Check enrichment status**: Read `.planning/project-memory-context/enrichment/worklist.json`.
   Count entries with `status: "pending"` or `status: "stale"`. **Report the count to the user**
   (e.g. "PMC: 12 symbols pending enrichment").
   If count > 0, launch via the **Bash tool with `run_in_background: true`**:
   ```bash
   pmc enrich .
   ```
   ⚠️ Do NOT use `Start-Process -WindowStyle Hidden` — the hidden process inherits a restricted PATH,
   crashes silently, and leaves a stalled queue-state that blocks restart for ~90 s.
   After launching, run the Still-Alive watchdog: see the `pmc:autostart` block below.

2. **Check sync-manifest**: Read `.planning/project-memory-context/enrichment/sync-manifest.json`. If `entries` contains any element with `status: "pending"`, surface: "PMC has N pending sync operations. Run `/sync-context` to apply them."

3. **Recall base context**: Call `agent-memory_search` with `query: "project context overview"` and `tags: ["project-context"]`. Present a brief summary (~500 tokens) to establish session context.

4. **Remind**: "Use `/get-context <target>` for structural deep-dive BEFORE reading files."

## Mandatory PMC Workflow (ENFORCED)

- **BEFORE reading any source file**: Run `/get-context <file-or-symbol>` FIRST. Do NOT open files with Read/Grep without first checking PMC context.
- **AFTER implementing code changes**: Run `pmc refresh-context` to detect changes, update graph, and queue re-enrichment.
- **AFTER refresh-context completes**: Run `pmc sync-context` to persist new/updated memories.
- **Default context depth**: Always use `depth=compact`. Use `extended` or `deep` ONLY when explicitly asked.

When the user asks whether enrichment is currently running, run `node tools/project-memory-context/cli/status.mjs .` (source repo) or `npx --yes --package @aabadin/project-memory-context pmc-status .` (consumer) and report the top-level `state` and `runtime.heartbeatAt` instead of guessing from `node` processes.

To resolve the PMC CLI for any command, use this pattern:
- **Source repo** (this repo): `node tools/project-memory-context/cli/<command>.mjs <args>`
- **Consumer projects**: `npx --yes --package @aabadin/project-memory-context pmc-<command> <args>`
- Detect by checking if `tools/project-memory-context/cli/` exists in the project root.

<!-- pmc:autostart -->
On EVERY session start, BEFORE responding to the user, execute these steps IN ORDER:

1. **Check enrichment status**: Read `.planning/project-memory-context/enrichment/worklist.json`.
   Count entries with `status: "pending"` or `status: "stale"`. **Report the count to the user**
   (e.g. "PMC: 12 symbols pending enrichment").
   If count > 0, launch background enrichment via the **Bash tool with `run_in_background: true`**:

   ```bash
   pmc enrich .
   ```

   ⚠️ Do NOT use PowerShell `Start-Process -WindowStyle Hidden` — the hidden process inherits a
   restricted PATH, crashes silently, and leaves a stalled queue-state that blocks restart for ~90 s.

   After launching, run the **concurrent Still-Alive watchdog + subagent drain** (cap: 3 auto-relaunches).
   Poll every **≥120 seconds**:
   - Run `pmc enrich-status`; read `.state`, `.worklist.pending`, `.subagentQueue.pending`.
   - `running` → alive; also check `.subagentQueue.pending` (see below) then wait ≥120s.
   - `finished` AND `.subagentQueue.pending` = 0 → done, report completion summary and stop.
   - `finished` AND `.subagentQueue.pending > 0` → keep looping to drain remaining subagents.
   - `stalled` or `failed` AND `.worklist.pending > 0` → crashed; relaunch (Bash
     `run_in_background: true`), report "PMC enrichment crashed — relaunched (attempt N/3)".
   - After 3 failed relaunches: tell the user to run `/pmc-doctor`.

   **Concurrent subagent drain** — on every poll iteration, if `.subagentQueue.pending > 0`:
   - Read `enrichment/subagent-queue.json`; take up to 3 entries with `status: "pending"`.
   - For each: dispatch a Task subagent with `entry.prompt` → write response to temp file →
     run `pmc subagent-apply . --entry-id <id> --content-file <tmpfile>` → delete temp file.
   - This runs **concurrently** with the Ollama CLI — do not wait for Ollama to finish first.

2. **Check sync-manifest**: Read `.planning/project-memory-context/enrichment/sync-manifest.json`. If `entries` contains any element with `status: "pending"`, surface: "PMC has N pending sync operations. Run `/sync-context` to apply them."

3. **Recall base context**: Call `agent-memory_search` with `query: "project context overview"` and `tags: ["project-context"]`. Present a brief summary (~500 tokens) to establish session context.

4. **Remind**: "Use `/get-context <target>` for structural deep-dive BEFORE reading files."

## Mandatory PMC Workflow (ENFORCED)

- **BEFORE reading any source file**: Run `pmc get-context <file-or-symbol>` FIRST. Do NOT open files without first checking PMC context.
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

5. **Load PMC workflow rules**: Read and apply the `pmc-skill` skill instructions (`.agents/skills/pmc-skill/SKILL.md`). These rules govern how you interact with PMC throughout the session — query PMC before reading files, available commands, MCP tools, and enrichment launch rules.
<!-- /pmc:autostart -->
