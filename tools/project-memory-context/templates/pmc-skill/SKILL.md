---
name: pmc-skill
description: "PMC-Aware Workflow — query PMC for structural context before reading files. Provides available commands, MCP tools, enrichment launch rules, and graph.db fallback for unenriched symbols."
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
- `/enrich` — launch batch enrichment via `pmc enrich . --background` (CLI)
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

### ✅ Correct: use `--background` flag (cross-platform)

```bash
pmc enrich . --background
```

`--background` uses Node.js `detached+unref` internally — works on Windows, macOS, and Linux
without relying on shell `&` or agent-specific `run_in_background` flags.

### ❌ Wrong: PowerShell `Start-Process -WindowStyle Hidden`

```powershell
# DO NOT DO THIS
Start-Process -FilePath "npx" -ArgumentList "--yes","--package","@aabadin/project-memory-context","pmc","enrich","." -WindowStyle Hidden
```

The hidden child process inherits a **restricted environment** (no full user PATH). It
crashes silently and leaves `queue-state.json` stalled.

### Still-Alive watchdog (applies every time `pmc enrich` is launched)

Whenever `pmc enrich . --background` is started — whether at session autostart or via `/enrich` — run
this watchdog loop (cap: 3 automatic relaunches):

1. Run `pmc enrich-status` and read `.state` and `.worklist.pending`.
2. `running` → alive; wait ~30 s and loop.
3. `finished` → done; report completion summary and stop.
4. `stalled` or `failed`, AND `.worklist.pending > 0` → process crashed:
   - Increment relaunch counter.
   - If counter ≤ 3: relaunch `pmc enrich . --background`; report "PMC enrichment
     crashed — relaunched (attempt N/3)"; resume from step 1.
   - If counter > 3: stop and tell the user: "PMC enrichment crashed 3 times. Run
     `/pmc-doctor` or check the terminal for errors."

---

## Working with unenriched symbols — graph.db structural fallback

When a symbol has no semantic enrichment (status is `pending` or `stale`), the graph still
contains full structural information. Use it to keep working without waiting for enrichment.

### What the graph provides without enrichment

| Available | Not available (requires enrichment) |
|-----------|-------------------------------------|
| Symbol name, kind, language | Responsibility / purpose description |
| File path and line range | Input/output semantics |
| Direct dependencies (imports) | Role in module |
| Direct dependents (who uses it) | Cross-symbol semantic relationships |
| Call graph edges | Natural language summaries |

### How to get structural context for an unenriched symbol

```bash
# Structural context only (works without enrichment)
pmc get-context <symbol> compact

# With dependency graph
pmc get-context <symbol> extended dependencies

# See all callers
pmc get-context <symbol> extended callers

# See full impact (who would break if this changes)
pmc get-context <symbol> extended impact
```

### Reading graph.db directly (advanced)

The graph lives at `.planning/project-memory-context/graph/graph.db` (SQLite).
Use MCP tools or `pmc get-context` — do not query graph.db directly unless the CLI is unavailable.

If you must query directly:
```bash
# All outgoing dependencies of a symbol
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('.planning/project-memory-context/graph/graph.db');
const rows=db.prepare('SELECT target_key, edge_type FROM edges WHERE source_key=?').all('<symbolKey>');
console.log(rows);
"

# All symbols in a file
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('.planning/project-memory-context/graph/graph.db');
const rows=db.prepare('SELECT symbol_key,name,kind FROM nodes WHERE file_path=?').all('<relativeFilePath>');
console.log(rows);
"
```

### Strategy when enrichment is absent

1. **`pmc get-context <symbol> extended dependencies`** — get the dependency graph first.
2. Read the source file for the specific symbol (not the whole file).
3. Trace callers via `pmc get-context <symbol> extended callers` to understand usage.
4. After making changes, run `pmc refresh-context --enrich` to queue the symbol for enrichment.

This gives 80% of the value of enrichment (structure + exact code) without waiting for LLM processing.
