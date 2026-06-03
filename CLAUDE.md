# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Structure

This is the **development source repo** for two publishable npm packages:

| Package | Location | Published as |
|---------|----------|--------------|
| PMC CLI | `tools/project-memory-context/` | `@aabadin/project-memory-context` |
| Agent Memory MCP | `agent-memory-mcp/` (git submodule) | `@aabadin/agent-memory-mcp` |

The `tools/pmc-graph-explorer/` directory contains a local Express server for visualizing the knowledge graph (not published).

## Commands

### PMC CLI (`tools/project-memory-context/`)
```bash
cd tools/project-memory-context
node --test tests/*.test.mjs            # run all tests (node:test runner)
node --test tests/foo.test.mjs          # run single test file
node --test tests/*.test.mjs --watch    # watch mode
```
Engine requirement: **Node ≥22.5.0**. Tests use `node:test` + `node:assert/strict` — no extra test framework.

### Agent Memory MCP (`agent-memory-mcp/`)
```bash
cd agent-memory-mcp
npm test                                # vitest run
npx vitest run tests/tools.test.ts      # single file
npx vitest run -t "store tool"          # single test by name
npm run build                           # tsc → dist/
npm run dev                             # tsx src/index.ts (no build)
```

### PMC CLI (from repo root, using installed package)
```bash
pmc enrich .                            # launch enrichment
pmc enrich-status                       # check enrichment state
pmc get-context <symbol|file|query>     # structural context
pmc refresh-context --enrich            # refresh graph + queue enrichment
pmc sync-context                        # persist enriched memories to agent-memory
pmc doctor                              # validate environment (Node, Python, Ollama, etc.)
```

## Architecture

### PMC Pipeline (4 stages)

```
Visit → Extract → Enrich → Persist
```

1. **Visit**: `graphifyy` (Python) builds `graph.json` — AST-level dependency graph
2. **Extract**: `src/extractors/` — symbol extractor using **Tree-Sitter WASM** (`web-tree-sitter`) for 10 languages; `regex-extractor.mjs` retained as fallback for Kotlin/Swift only. Dispatch in `src/symbol-extractor.mjs`.
3. **Enrich**: `cli/enrich-queue.mjs` — sends each symbol to an LLM (Ollama / cloud API / agent-subagent). Three modes: `local-model`, `cloud-api`, `agent-subagent`.
4. **Persist**: `pmc sync-context` upserts enriched symbols to `agent-memory-mcp` via MCP tools.

### Hashing

All symbol codeHash uses **XXH3** via `xxhash-wasm` (`src/hash.mjs`). File-level change detection also uses XXH3 (`src/file-hash-store.mjs`). Hash version is `'xxh3-1'` — stored per symbol in `worklist.json` as `hashVersion`. On algorithm change, `computeSymbolDelta` silently re-hashes without marking stale (see `src/symbol-delta.mjs`).

### Key PMC source files

| File | Role |
|------|------|
| `src/extractors/tree-sitter/extract.mjs` | Generic tree-sitter extraction engine |
| `src/extractors/tree-sitter/runtime.mjs` | web-tree-sitter singleton + grammar cache |
| `src/extractors/tree-sitter/queries/*.scm` | S-expression queries per language |
| `src/symbol-delta.mjs` | Detects stale symbols by codeHash comparison |
| `src/file-hash-store.mjs` | File-level hashing for `refresh-context` |
| `src/hash.mjs` | Unified XXH3 hasher (hashSymbol + hashFile) |
| `src/symbol-extractor.mjs` | Public dispatch: `extractTopLevelSymbols()` |
| `src/enrichment-driver.mjs` | Provider fallback chain |
| `src/sync-manifest.mjs` | Tracks pending sync entries |
| `cli/enrich-queue.mjs` | Enrichment worker queue with watchdog |
| `cli/refresh-context.mjs` | Graph rebuild + stale detection |

### Agent Memory MCP (`agent-memory-mcp/`)

MCP server backed by **LanceDB** (being migrated to SQLite in FASE 2.2). Composition:

```
Embedder → LanceMemoryStore → [HardcopyMemoryStore] → MCP tools → stdio
```

- `src/memory-store.ts`: hybrid BM25 FTS + cosine vector search via RRF(k=60). Temporal decay computed on-read from `updated_at` (no stored `decay_factor` column). `update()` uses OCC (optimistic concurrency control) with `version` column.
- `src/hardcopy-store.ts`: decorator that mirrors writes to `{id}.json` files atomically (temp-rename). Errors are swallowed.
- `src/tools.ts`: 8 MCP tools — `store`, `store_batch`, `search`, `recall`, `find_related`, `list_recent`, `update`, `stats`, `delete`, `prune`.
- `tests/mocks.ts`: `MockEmbedder` (hash-based deterministic vectors), `MockMemoryStore` (in-memory).

### Graph Explorer (`tools/pmc-graph-explorer/`)

Express server (port 3001) serving a D3 force-directed graph of the PMC knowledge graph. Reads `graph.json`, `worklist.json`, `context-tracker.json`. Frontend in `public/` uses ES modules (no bundler).

## PMC Enrichment State Machine

Symbols in `worklist.json` have status: `pending` → `enriched` (or `error`, `stale`, `already_enriched`, `subagent-queued`). `stale` = codeHash changed since last enrich. `pmc enrich --stale-only` processes only `stale` symbols.

## Session Autostart (from AGENTS.md)

On every session start, before anything else:
1. Read `worklist.json` — count `pending`/`stale`. If > 0, launch `pmc enrich .` via Bash `run_in_background: true`. ⚠️ Never use PowerShell `Start-Process -WindowStyle Hidden`.
2. Read `sync-manifest.json` — surface pending sync operations.
3. Search agent-memory for project context overview.

## PMC Workflow (ENFORCED)

- **Before reading any source file**: `pmc get-context <file-or-symbol>` first
- **After code changes**: `pmc refresh-context --enrich` then `pmc sync-context`
- **Default depth**: `compact` — use `extended`/`deep` only when explicitly asked

## Testing Patterns

**PMC (node:test):** Each test creates a temp dir via `mkdtemp`, sets up fixtures, runs assertions, cleans up in `after`. Fixture language samples in `tests/fixtures/`. New extractor tests go in `tests/extractors/`.

**agent-memory-mcp (vitest):** `beforeEach` creates temp dir + `new LanceMemoryStore(path, new MockEmbedder())` + `await store.initialize()`. `afterEach` removes temp dir.

## Active Roadmap (FASE 2.2 in progress)

**Current task:** Migrate `agent-memory-mcp` from LanceDB → SQLite (`node:sqlite` built-in). Plan at `~/.claude/plans/ok-resuelve-fase-0-concurrent-whisper.md`. Key files to create: `agent-memory-mcp/src/sqlite-store.ts`, `src/store-factory.ts`, `src/migrate.ts`. SQLite schema uses FTS5 for BM25, BLOB Float32 for embeddings, WAL mode for concurrency.
