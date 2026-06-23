# Project Memory Context — CLI & Runtime Reference

`@aabadin/project-memory-context` is the PMC CLI and runtime. It builds knowledge graphs from source code, enriches symbols with LLM-generated descriptions, and persists enriched memories to the agent-memory MCP server.

**Package location**: `tools/project-memory-context/`

## CLI Commands

All commands run via `pmc <command> [args]` (globally installed) or `node tools/project-memory-context/cli/<command>.mjs [args]` (source repo).

### Core Workflow

| Command | Purpose | Example |
|---------|---------|---------|
| `session-start` | One-shot session initializer: checks enrichment, launches background processes, reports pending sync ops | `pmc session-start .` |
| `get-context` | Retrieves structural context for a target (file or symbol) at configurable depth | `pmc get-context src/index.ts` |
| `refresh-context` | Incrementally refreshes the knowledge graph by detecting changed files and updating symbol deltas | `pmc refresh-context --enrich` |
| `sync-context` | Syncs pending enrichment data from the local graph into agent memory via MCP | `pmc sync-context` |
| `enrich` | Launches enrichment queue for pending/stale symbols (local model, cloud API, or subagent) | `pmc enrich .` |
| `enrich-status` | Reports current enrichment status: counts of pending/enriched/error entries, queue state | `pmc enrich-status .` |
| `doctor` | Runs health checks on the PMC environment (Node, Python, Ollama, agent-memory) | `pmc doctor .` |

### Project Setup

| Command | Purpose | Example |
|---------|---------|---------|
| `init` | Initializes PMC for an agent type (opencode, claude-code, cursor, generic) by installing templates | `pmc init --agent opencode` |
| `setup` | Interactive setup wizard: runs doctor, installs graphify, bootstraps project, configures agent templates | `pmc setup --opencode` |
| `bootstrap` | Bootstraps a new project: sets up directories, enrichment config, graphify, and initial graph | `pmc bootstrap [target-repo]` |
| `new-project` | Legacy wrapper for full project mapping (superseded by `bootstrap`) | `pmc new-project [target-repo]` |
| `install-pmc` | Installs PMC tooling into a target project by creating directory structure and writing install state | `node install-pmc.mjs` |

### Enrichment Pipeline

| Command | Purpose | Example |
|---------|---------|---------|
| `build-worklist` | Builds enrichment worklist from source files by extracting top-level symbols | `node build-worklist.mjs src/foo.ts` |
| `enrich-queue` | Main enrichment queue processor (internal; use `enrich` as the entry point) | — |
| `enrich-watchdog` | Background watchdog that monitors the enrichment queue and relaunches on stalls (up to 3 relaunches) | — |
| `apply-enrichment-result` | Applies a JSON enrichment result payload to the project graph, index, and worklist | `node apply-enrichment-result.mjs '{...}'` |
| `finalize-enrichment` | Finalizes an enrichment result by persisting to graph, index, and worklist in one step | `node finalize-enrichment.mjs @result.json` |
| `fail-enrichment` | Records an enrichment failure for a symbol, updating the worklist and failures log | `node fail-enrichment.mjs <key> "error"` |
| `retry-errors` | Retries failed enrichment entries from the worklist using configured providers | `pmc retry-errors` |
| `subagent-apply` | Persists enrichment results from an agent subagent into the standard PMC pipeline | `pmc subagent-apply . --entry-id <id> --content-file <path>` |

### Context and Query

| Command | Purpose | Example |
|---------|---------|---------|
| `context` | Retrieves and renders structural context for a target from the knowledge graph | `pmc get-context src/index.ts compact` |
| `query` | Queries PMC project-context and symbol artifacts with a natural language question | `pmc query "how does auth work?"` |
| `project-context` | Detects and materializes project-level context (stack, structure, architecture) into memories | `node project-context.mjs` |

### Utility

| Command | Purpose | Example |
|---------|---------|---------|
| `watch` | Watches project files for changes with debounced refresh-context triggers | `pmc watch .` |
| `sanitize` | Rebuilds PMC graph artifacts by re-extracting symbols, re-hashing, and re-syncing | `pmc sanitize` |
| `enrich-status` | Reports current enrichment queue status and subagent queue summary | `pmc enrich-status .` |
| `prepare-semantic-jobs` | Prepares semantic enrichment job definitions from the current worklist for batch processing | `node prepare-semantic-jobs.mjs` |
| `materialize-enrichment-artifacts` | Materializes enrichment job and report into persisted memory files and sync entries | `node materialize-enrichment-artifacts.mjs @job.json @report.json` |
| `save-intake-context` | Saves an intake context (project description + mapping goals) as a JSON artifact | `node save-intake-context.mjs "my app" auth api` |

### Context Depth Levels

Used with `get-context`:

| Depth | Description |
|-------|-------------|
| `compact` | Summary with key relationships (default) |
| `extended` | Includes dependencies and extended metadata |
| `deep` | Full traversal with all available detail |
| `disk` | Raw source code of the target |

### `pmc impact` Output

`pmc impact` is the pre-commit blast-radius report. It does not modify any on-disk state.

| Field | Meaning |
|-------|---------|
| `changedFiles` | Files git sees as changed (modified or untracked), filtered to extensions PMC indexes |
| `changedSymbols` | Symbols whose codeHash drifted from the worklist |
| `unindexedFiles` | Changed files not in the PMC worklist |
| `impact` | Downstream dependents grouped by hop distance (1 = direct caller, 2+ = transitive) |
| `summary.direct` | Count of drifted symbols with at least one downstream dependent |
| `summary.transitive` | Count of dependents at distance >= 2 |

Flags: `--max-depth <N>` (default 3, max 8), `--json` (raw object). Also available as MCP tool `pmc_impact(maxDepth?)`.

## PMC MCP Query Tools

The PMC query server (`pmc-query-server`) exposes these tools:

| Tool | Parameters | Returns | Description |
|------|-----------|---------|-------------|
| `pmc_query_project` | `question` | Query result | Natural-language query against PMC project context and symbol artifacts |
| `pmc_search_symbols` | `query`, `file?` | Symbol matches | Search symbols by semantic summary, optionally filtered by file path |
| `pmc_get_dependents` | `symbol` | Symbol list | List symbols that depend on the given symbol key |
| `pmc_get_dependencies` | `symbol` | Symbol list | List symbols the given symbol key depends on |
| `pmc_get_context` | `target`, `depth?` (`compact`/`extended`/`deep`), `focus?` | Structured context | Structured context for a symbol, file, or query |
| `pmc_trace_paths` | `symbol`, `direction?` (`in`/`out`/`both`), `maxDepth?` (1-8) | Path trace | Trace upstream/downstream symbol paths with bidirectional BFS |
| `pmc_impact` | `maxDepth?` (1-8) | Impact report | Map uncommitted changes to blast radius across the PMC graph |

> **Note**: A unified `pmc` MCP server that composes both query and memory tools is planned but not yet implemented. The composable query module (`mcp/query-tools.mjs`) already exists and exports `registerQueryTools()` for future composition. Currently, query tools are served by `pmc-query-server` and memory tools by `pmc-agent-memory`.

## Enrichment Pipeline

### How It Works

```
Visit → Extract → Enrich → Persist
```

1. **Visit**: `graphifyy` (Python CLI) builds `graph.json` — an AST-level dependency graph
2. **Extract**: Tree-sitter (WASM) extracts symbols from 10+ languages
3. **Enrich**: LLM generates descriptions for each symbol
4. **Persist**: `pmc sync-context` upserts enriched memories to agent-memory via MCP

### Enrichment Providers

Three provider modes, tried in fallback order:

1. **local-model**: Ollama-based local inference (default). Requires Ollama running with a model pulled.
2. **cloud-api**: Remote API call (configured in enrichment config).
3. **agent-subagent**: Routes to the host agent's LLM. Used for large symbols (>=5k tokens or >=80% file coverage).

### Enrichment State Machine

Symbols in `worklist.json` transition through statuses:

```
pending → enriched (success)
pending → error (failure)
pending → subagent-queued (large symbol routed to agent subagent)
enriched → stale (code changed since last enrich)
stale → enriched (re-enriched)
```

`already_enriched` = pre-existing enrichment from a previous run (not re-enriched).

### Configuration

Enrichment config lives at `.planning/project-memory-context/enrichment/config.json`:

```json
{
  "mode": "local-model",
  "model": "llama3.2",
  "concurrency": 3,
  "subagentThresholdTokens": 5000,
  "localModelBaseUrl": "http://localhost:11434"
}
```

## Refresh / Sync Workflow

### Manual Workflow

```bash
# 1. Detect changes and rebuild graph
pmc refresh-context --enrich

# 2. Wait for enrichment to complete (check with pmc enrich-status .)

# 3. Persist enriched memories to agent-memory
pmc sync-context
```

### Automatic Workflow (with File Watcher)

When the PMC file watcher is running (`pmc watch .`):

1. File changes detected (2-second debounce)
2. `refresh-context --enrich` runs automatically
3. Enrichment queue processes stale/pending symbols
4. You only need to run `pmc sync-context` after enrichment completes

### Incremental Refresh

`pmc refresh-context --enrich` performs incremental updates:
- Detects changed files via XXH3 file hashing
- Extracts symbols only from changed files
- Compares symbol codeHash to detect stale entries
- Queues stale symbols for re-enrichment
- Preserves existing enriched data for unchanged symbols

## File Watcher

```bash
# Start watching
pmc watch .

# Check watcher status
pmc watch . --status

# Stop watcher
pmc watch . --stop
```

The watcher:
- Monitors project files for changes
- Uses a 2-second debounce (waits for 2s of inactivity before triggering)
- Runs `pmc refresh-context --enrich` automatically
- Tracks PID and heartbeat for crash detection

## Sleep Mode

Sleep mode runs PMC maintenance during idle windows without competing with active user work.

> **Status**: Sleep mode is implemented as TypeScript modules in `agent-memory-mcp/src/` (`sleep-run.ts`, `sleep-watch.ts`, `sleep-config.ts`). CLI wrappers in `tools/project-memory-context/cli/` are pending. The modules are usable programmatically but not yet exposed as `pmc` subcommands.

### Commands (Planned)

| Command | Purpose | Example |
|---------|---------|---------|
| `sleep-run` | One-shot maintenance pipeline with checkpointing | `pmc sleep-run` |
| `sleep-watch` | Idle daemon that monitors CPU/idle state and spawns sleep-run when eligible | `pmc sleep-watch` |

### How It Works

1. **Idle detection**: `sleep-watch` monitors CPU usage and user input
2. **Eligibility**: When idle time exceeds `idleMinMinutes` and CPU is below threshold
3. **Keep-awake lease**: Acquires a 30-minute lease (renewed every 10 minutes) to prevent system sleep
4. **Execution**: `sleep-run` iterates registered projects — refresh, enrich, sync
5. **Yielding**: If user activity resumes, the current symbol completes, state is checkpointed, and work pauses
6. **Local-only**: Uses only local-model enrichment (no cloud, no subagent)

### Configuration

Global config at `~/.config/opencode/project-memory-context.json`:

```json
{
  "sleep": {
    "idleMinMinutes": 10,
    "cpuHighPercent": 65,
    "cpuResumeBelowPercent": 45,
    "maxRunHours": 6,
    "keepAwakeLeaseMinutes": 30,
    "onlyWhenPluggedIn": true,
    "pauseAfterCurrentSymbol": true
  }
}
```

### Checkpoints and Reports

Run directories: `~/.config/opencode/pmc/sleep/runs/<runId>/`

| File | Contents |
|------|----------|
| `checkpoint.json` | `runId`, `status`, `timestamps`, `currentProject`, `currentPath`, `phase`, `currentSymbolKey`, `processed`, `deferred`, `lastSafeBoundary`, `pauseReason` |
| `report.json` | `runId`, `status`, `timestamps`, `perProjectStats`, `memoryMaintenance`, `pauseEvents`, `warnings`, `keepAwakeStatus` |

### Crash Recovery

If sleep-run is interrupted or crashes:
- On restart, it reads the latest checkpoint
- Continues from the last safe boundary
- Does not corrupt state

## Gradual Forgetting Internals

### State Machine

Memories transition through decay states:

```
active → cooling → dimmed → shadow → gist_only → purged
```

| State | Trigger | Behavior |
|-------|---------|----------|
| `active` | Default | Full recall weight, normal search ranking |
| `cooling` | 30 days unused | Reduced recall probability |
| `dimmed` | 90 days unused | Further reduced ranking |
| `shadow` | 180 days unused | Minimal recall weight |
| `gist_only` | 365 days unused | Original text pruned; gist preserved |
| `purged` | After gist-only + retention window | Original removed; gist remains |

Reactivation moves items back toward `active`.

### Gist Preservation

Before pruning, the system creates a compressed gist in `memory_gists`:

| Field | Description |
|-------|-------------|
| `core_fact` | Compressed knowledge |
| `why_it_matters` | Importance context |
| `revive_triggers` | Semantic triggers for recall |
| `non_forgettable` | Default `true` for gists |

The `original_id` is intentionally NOT a strict foreign key — the gist survives the original row's purge.

### Revive Gate

Before pruning an original memory:
1. System checks the gist for value
2. LLM/local model judges: revive, prune, or defer
3. If `confidence < 0.7`: defer (neither revive nor prune)
4. Decision recorded in `memory_revive_reviews`

### Global Promotion

Memories are promoted globally when:
- Seen in 2+ projects, OR
- Seen 2+ times in one project if critical/security/data-loss, OR
- Reused/revived 3+ times

Promotion creates a new global memory and records the decision in `global_promotion_log` (append-only audit trail).

### Tables

| Table | Purpose |
|-------|---------|
| `memory_gists` | Compressed knowledge preserved before prune |
| `memory_decay_log` | Audit trail of state transitions |
| `memory_revive_reviews` | Revive/prune/defer decisions |
| `global_promotion_log` | Immutable audit trail for promotions |

## On-Disk State

All PMC state lives under `.planning/project-memory-context/` in the target project:

| Path | Contents |
|------|----------|
| `graph/graph.json` | Knowledge graph (nodes + edges) |
| `graph/graph.db` | SQLite graph store for queries |
| `enrichment/worklist.json` | Symbol enrichment status + metadata |
| `enrichment/symbol-index.json` | Symbol lookup index |
| `enrichment/queue-state.json` | Queue runtime state + heartbeat |
| `enrichment/sync-manifest.json` | Pending sync entries |
| `enrichment/config.json` | Enrichment configuration |
| `enrichment/*.memory.json` | Enriched symbol memories |
| `context-tracker.json` | Active context tracking |
| `file-hash-store.json` | File change detection hashes |

## Hashing

All symbol `codeHash` uses **XXH3** via `xxhash-wasm`. File-level change detection also uses XXH3. Hash version is `'xxh3-1'` — stored per symbol in `worklist.json`. On algorithm change, `computeSymbolDelta` silently re-hashes without marking stale.

## Graph Explorer

Express server (port 3001) serving a D3 force-directed graph visualization of the PMC knowledge graph. Reads `graph.json`, `worklist.json`, `context-tracker.json`. Frontend in `public/` uses ES modules with no bundler.
