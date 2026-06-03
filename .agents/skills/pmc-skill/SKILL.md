---
name: pmc-skill
description: "PMC-Aware Workflow — query PMC for structural context before reading files. Provides available commands, MCP tools, and enrichment launch rules."
---

# PMC-Aware Workflow

PMC first, files second.

Before reading more than 3 files, query PMC for structural context first. Use PMC to understand symbols, dependencies, and callers before falling back to raw file reads.

## Rule of thumb

- Query PMC before reading more than 3 files.
- Prefer PMC summaries for architecture, dependencies, and symbol lookup.
- Read source files after PMC when you need exact implementation details.

## Available commands

- `/map-project`
- `/get-context`
- `/enrich` — launch batch enrichment via `pmc enrich .` (CLI)
- `/enrich-ondemand` — enrich a specific symbol on the fly using the agent's LLM
- `/enrich-status`
- `/pmc-doctor`
- `/init-project`
- `/sync-context`
- `/sanitize`

- `/get-context <target> [depth] [focus]`—resolve a symbol, file, or query and return structural context

## Available MCP tools

- `pmc_query_project`
- `pmc_search_symbols`
- `pmc_get_dependents`
- `pmc_get_dependencies`

## Why this saves tokens

PMC returns focused structural context, so the agent can avoid loading many full files into context. Querying graph-backed summaries first usually costs fewer tokens than broad file reads and helps reserve file inspection for the exact places that matter.

## Running enrichment (`pmc enrich`) — launch rules

### ✅ Correct: Bash tool with `run_in_background: true`

```bash
pmc enrich .
```

Launch via the **Bash tool with `run_in_background: true`**. This runs inside the full user
shell session, where `node` and all dependencies are on the PATH.

### ❌ Wrong: PowerShell `Start-Process -WindowStyle Hidden`

```powershell
# DO NOT DO THIS
Start-Process -FilePath "npx" -ArgumentList "--yes","--package","@aabadin/project-memory-context","pmc","enrich","." -WindowStyle Hidden
```

The hidden child process inherits a **restricted environment** (no full user PATH). It
starts, prints its header, then crashes silently when it can't resolve `node` or PMC
dependencies. It leaves `queue-state.json` with `status: "running"` and a stale
`heartbeatAt`, so `pmc enrich-status` reports `stalled`, blocking any clean restart for
~90 seconds until the heartbeat expires.

### Still-Alive watchdog (applies every time `pmc enrich` is launched)

Whenever `pmc enrich .` is started — whether at session autostart or via `/enrich` — run
this watchdog loop (cap: 3 automatic relaunches):

1. Run `pmc enrich-status` and read `.state` and `.worklist.pending`.
2. `running` → alive; wait ~30 s and loop.
3. `finished` → done; report completion summary and stop.
4. `stalled` or `failed`, AND `.worklist.pending > 0` → process crashed:
   - Increment relaunch counter.
   - If counter ≤ 3: relaunch via Bash `run_in_background: true`; report "PMC enrichment
     crashed — relaunched (attempt N/3)"; resume from step 1.
   - If counter > 3: stop and tell the user: "PMC enrichment crashed 3 times. Run
     `/pmc-doctor` or check the terminal for errors."
