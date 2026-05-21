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

## Session autostart (PMC)

On every session start, if `.planning/project-memory-context/` exists in the current project, do this before responding to the user:

1. Read `.planning/project-memory-context/enrichment/worklist.json`. If any entry has `status: "pending"` or `status: "stale"`, run enrichment in the background (PowerShell, no `&&`):
   ```powershell
   Start-Process -FilePath "pmc" -ArgumentList "enrich","." -WindowStyle Hidden
   ```
   Do not block the user; just launch and continue.
2. Read `.planning/project-memory-context/enrichment/sync-manifest.json`. If `entries` contains any element with `status: "pending"`, surface:
   `"PMC has {N} pending sync operations. Run /sync-context to apply them."`
3. Query agent-memory with the prompt `project context overview` to fetch base context.
4. Remind the user: `"Use /get-context <target> for structural deep-dive before reading files."`

When the user asks whether enrichment is currently running, run `pmc status` and report the top-level `state` and `runtime.heartbeatAt` instead of guessing from `node` processes.
