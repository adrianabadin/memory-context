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

1. **Check enrichment status**: Read `.planning/project-memory-context/enrichment/worklist.json`. Count entries with `status: "pending"` or `status: "stale"`. If count > 0, launch background enrichment. Use autodetection to find the CLI:
   ```powershell
   if (Test-Path "tools/project-memory-context/cli/enrich-queue.mjs") {
     Start-Process -FilePath "node" -ArgumentList "tools/project-memory-context/cli/enrich-queue.mjs" -WindowStyle Hidden
   } else {
     Start-Process -FilePath "npx" -ArgumentList "--yes","--package","@aabadin/project-memory-context","pmc","enrich","." -WindowStyle Hidden
   }
   ```
   Do NOT block the user — launch and continue immediately.

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
