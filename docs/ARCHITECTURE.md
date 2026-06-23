# PMC Architecture

## Overview

PMC (Project Memory Context) gives AI agents persistent, queryable knowledge about codebases via knowledge graphs, semantic enrichment, and agent-memory integration. Distributed as the npm package `@aabadin/project-memory-context`.

## Two-Package Structure

| Package | Location | Published as |
|---------|----------|--------------|
| PMC CLI | `tools/project-memory-context/` | `@aabadin/project-memory-context` |
| Agent Memory MCP | `agent-memory-mcp/` (git submodule) | `@aabadin/agent-memory-mcp` |

The `tools/pmc-graph-explorer/` directory contains a local Express server for visualizing the knowledge graph (not published).

## PMC Pipeline (4 stages)

```
Visit -> Extract -> Enrich -> Persist
```

1. **Visit**: `graphifyy` (Python CLI) builds `graph.json` — an AST-level dependency graph with nodes (symbols: classes, functions, methods) and edges (relationships: imports, calls, contains, inherits).

2. **Extract**: `src/extractors/tree-sitter/` — symbol extractor using **web-tree-sitter** (WASM) for 10+ languages. S-expression queries defined per language in `queries/*.scm`. `regex-extractor.mjs` retained as fallback for Kotlin/Swift only. Dispatch via `src/symbol-extractor.mjs`.

3. **Enrich**: `cli/enrich-queue.mjs` — sends each symbol to an LLM provider. Three modes:
   - `local-model`: Ollama-based local inference
   - `cloud-api`: remote API call
   - `agent-subagent`: routes large symbols to an agent's LLM subagent

   The queue manages concurrency slots, checkpoint saves (crash recovery), and a watchdog process for reliability.

4. **Persist**: `pmc sync-context` upserts enriched symbol memories to agent-memory-mcp via MCP tools.

## Key PMC Modules

| File | Role |
|------|------|
| `src/extractors/tree-sitter/extract.mjs` | Generic tree-sitter extraction engine |
| `src/extractors/tree-sitter/runtime.mjs` | web-tree-sitter singleton + grammar cache |
| `src/extractors/tree-sitter/queries/*.scm` | S-expression queries per language |
| `src/symbol-delta.mjs` | Detects stale symbols by codeHash comparison |
| `src/file-hash-store.mjs` | File-level hashing for refresh-context |
| `src/hash.mjs` | Unified XXH3 hasher (hashSymbol + hashFile) |
| `src/artifacts.mjs` | Atomic JSON read/write utilities (temp+rename) |
| `src/worklist-merge.mjs` | Merge-on-save for worklist and symbol-index |
| `src/sync-manifest.mjs` | Tracks pending sync entries with in-process locking |
| `src/enrichment-driver.mjs` | Provider fallback chain |
| `src/symbol-extractor.mjs` | Public dispatch: `extractTopLevelSymbols()` |
| `src/graph-store/graph-db.mjs` | SQLite-based graph storage with query support |
| `src/platform.mjs` | Platform utilities including `resolveProjectRoot()` |
| `cli/enrich-queue.mjs` | Enrichment worker queue with watchdog |
| `cli/refresh-context.mjs` | Incremental graph rebuild + stale detection |
| `cli/context.mjs` | `get-context` structural query CLI |
| `cli/session-start.mjs` | Session initialization and autostart |
| `cli/sync.mjs` | Persist enriched memories to agent-memory |

## Hashing

All symbol `codeHash` uses **XXH3** via `xxhash-wasm` (`src/hash.mjs`). File-level change detection also uses XXH3 (`src/file-hash-store.mjs`). Hash version is `'xxh3-1'` — stored per symbol in `worklist.json`. On algorithm change, `computeSymbolDelta` silently re-hashes without marking stale.

## Enrichment State Machine

Symbols in `worklist.json` transition through statuses:

```
pending --> enriched (success)
pending --> error (failure)
pending --> subagent-queued (large symbol routed to agent subagent)
enriched --> stale (code changed since last enrich)
stale --> enriched (re-enriched)
```

`already_enriched` = pre-existing enrichment from a previous run (not re-enriched).

`pmc enrich --stale-only` processes only `stale` symbols.

## Agent Memory MCP

SQLite-backed MCP server (WAL mode) with hybrid FTS5 BM25 + cosine vector search.

Composition chain:
```
Embedder -> SqliteMemoryStore -> [HardcopyMemoryStore] -> MCP tools -> stdio
```

**SqliteMemoryStore** (`src/sqlite-store.ts`): Split-table layout (`memories` for metadata/FTS, `memory_embeddings` for vectors). Stores vectors as BLOB Float32 arrays. Hybrid search via Reciprocal Rank Fusion (RRF k=60). Temporal decay applied on-read. Optimistic concurrency via `version` column.

**LanceMemoryStore** (`src/memory-store.ts`): Read-only migration source for importing legacy LanceDB databases. Not used for active writes.

**HardcopyMemoryStore** (`src/hardcopy-store.ts`): Decorator pattern — mirrors writes to `{id}.json` files atomically (temp-rename). Errors logged but never propagated.

### MCP Servers

Current MCP servers (in `tools/project-memory-context/mcp/`):

| Server | File | Purpose |
|--------|------|---------|
| `pmc-query-server` | `pmc-query-server.mjs` | PMC query tools (symbol search, context, dependencies, impact) |
| `local-model-server` | `local-model-server.mjs` | Local model enrichment server |

**Planned**: A unified `pmc` MCP server (`pmc-mcp-server.mjs`) that composes both query and memory tools into one process. The composable foundation already exists as `query-tools.mjs` (exports `registerQueryTools()`), ready to be composed alongside agent-memory tools when the unified server is implemented. Described in the `unified-pmc-mcp-background-actions` proposal.

### Agent Memory MCP Tools

The agent-memory-mcp package exposes these tools (registered on the `pmc-agent-memory` server):

**Storage**: `store`, `store_batch`
**Search**: `search`, `recall`, `find_related`, `list_recent`
**Management**: `update`, `delete`, `stats`, `prune`
**Lifecycle**: `update_memory_status`
**Topics**: `upsert_topic_alias`, `resolve_topic`, `suggest_topic_key`
**Session Context**: `set_session_context`, `get_session_context`
**Session Ledger**: `store_session_prompt`, `store_session_response`, `store_session_tool_call`, `store_session_summary`, `get_session`, `list_sessions`, `link_prompt_to_memory`
**Session Forget/Purge**: `forget_session_item`, `purge_session_item`
**Global Context**: `register_project`, `sync_project_metadata`, `record_error`, `search_global_errors`, `merge_projects`

### PMC Query Tools

The PMC query server exposes:

| Tool | Description |
|------|-------------|
| `pmc_query_project` | Natural-language query against project context |
| `pmc_search_symbols` | Search symbols by semantic summary |
| `pmc_get_dependents` | List symbols that depend on a given symbol |
| `pmc_get_dependencies` | List symbols a given symbol depends on |
| `pmc_get_context` | Structured context for a symbol, file, or query |
| `pmc_trace_paths` | Trace upstream/downstream symbol paths |

## Schema Migrations

The agent-memory-mcp database uses incremental schema migrations via `PRAGMA user_version`:

| Version | Changes |
|---------|---------|
| v1 | Initial schema: `memories`, `memory_embeddings`, FTS5 virtual tables |
| v2 | `status`/`review_reason`/`reviewed_at` on `memories`; 6 new tables (`session_prompts`, `session_responses`, `session_tool_calls`, `session_summaries`, `session_memory_links`, `memory_topics`); 5 indexes |
| v3 | `updated_at`/`access_count`/`last_accessed_at`/`status` on all 4 session tables |
| v4 | `memory_gists`, `memory_decay_log` tables; `activation_score`/`memory_state`/`last_reinforced_at` on `memories` |
| v5 | `memory_revive_reviews`, `global_promotion_log` tables; `non_forgettable` on `memories` |
| v6 | `gist_id`/`confidence` on `memory_revive_reviews` |

All migrations use `addColumnIfMissing` and `CREATE TABLE IF NOT EXISTS` — idempotent and backward-compatible.

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

## Sleep Mode

Sleep mode runs PMC maintenance during idle windows. See [SLEEP-MODE.md](SLEEP-MODE.md) for details.

Key components:
- `sleep-watch.ts`: Idle daemon monitoring CPU/idle state
- `sleep-run.ts`: One-shot maintenance pipeline with checkpointing
- `sleep-config.ts`: Configuration loading and validation

## Gradual Forgetting

PMC implements staged memory decay with gist preservation. See [GRADUAL-FORGETTING.md](GRADUAL-FORGETTING.md) for details.

Key tables:
- `memory_gists`: Compressed knowledge preserved before prune
- `memory_decay_log`: Audit trail of state transitions
- `memory_revive_reviews`: Revive/prune/defer decisions
- `global_promotion_log`: Immutable audit trail for promotions

## Graph Explorer

Express server (port 3001) serving a D3 force-directed graph visualization of the PMC knowledge graph. Reads `graph.json`, `worklist.json`, `context-tracker.json`. Frontend in `public/` uses ES modules with no bundler.

## Session Autostart

`pmc session-start .` runs at session start to:
1. Check enrichment status and launch background enrich + watchdog if needed
2. Report pending sync operations
3. Load project context from materialized disk artifacts
4. Report if LLM subagent drain is needed
5. Ensure file watcher is running
