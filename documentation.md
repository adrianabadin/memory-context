# PMC — Project Memory Context

Technical-operative master document for the `memory-context` repository.

**Package:** `@aabadin/project-memory-context@0.2.17`
**License:** GPL-3.0-or-later
**Binary:** `pmc` (global CLI)

---

## Table of Contents

- [1. What PMC Does](#1-what-pmc-does)
- [2. Repository Structure](#2-repository-structure)
- [3. Architecture](#3-architecture)
- [4. Public CLI Contract](#4-public-cli-contract)
- [5. Key Subsystems](#5-key-subsystems)
  - [5.1 Enrichment Pipeline](#51-enrichment-pipeline)
  - [5.2 Retrieval Layer](#52-retrieval-layer)
  - [5.3 Sync Manifest](#53-sync-manifest)
  - [5.4 Project-Context Materialization](#54-project-context-materialization)
  - [5.5 Graph Explorer](#55-graph-explorer)
  - [5.6 Agent Setup & Templates](#56-agent-setup--templates)
- [6. Data Model](#6-data-model)
- [7. Provider Model](#7-provider-model)
- [8. External Dependencies](#8-external-dependencies)
- [9. Embedding Model](#9-embedding-model)
- [10. Testing](#10-testing)
- [11. Environment Variables](#11-environment-variables)
- [12. Current Implementation State](#12-current-implementation-state)
- [13. Key Decisions & Rationale](#13-key-decisions--rationale)
- [14. Roadmap & Recommended Decisions](#14-roadmap--recommended-decisions)
- [15. Known Issues & Follow-ups](#15-known-issues--follow-ups)

---

## 1. What PMC Does

PMC gives AI coding agents (OpenCode, Claude Code, Cursor, etc.) **persistent, searchable knowledge** of a codebase across sessions. It does this through a four-stage pipeline:

| Stage | Tool | Output |
|-------|------|--------|
| **Visit** | graphifyy (Python, AST-level) | `graph.json` — dependency graph of the entire codebase |
| **Extract** | Regex+parser extractors | `worklist.json` — every top-level symbol with location metadata |
| **Enrich** | Local LLM (Ollama) or cloud API | Structured descriptions: responsibility, inputs, outputs, dependencies |
| **Persist** | agent-memory-mcp (LanceDB) | Searchable vector memories with hybrid BM25 + semantic search |

At session start, the agent automatically recalls base context (stack, architecture, structure) and can request targeted context for any symbol, file, or query via `pmc get-context`.

---

## 2. Repository Structure

```
memory-context/                          # This repository (source/dev repo)
├── agent-memory-mcp/                    # Fork of adamrdrew/agent-memory-mcp
│   ├── src/                             # TypeScript MCP server (LanceDB + bge-m3)
│   └── tests/
├── tools/
│   ├── project-memory-context/          # Main PMC package (published to npm)
│   │   ├── bin/
│   │   │   ├── pmc.mjs                  # Entry point: pmc <command>
│   │   │   └── pmc-view-context.mjs     # View-context subcommand
│   │   ├── cli/                         # Command implementations
│   │   │   ├── bootstrap.mjs            # map-project
│   │   │   ├── context.mjs              # get-context
│   │   │   ├── sync.mjs                 # sync-context
│   │   │   ├── status.mjs               # enrich-status
│   │   │   ├── init.mjs                 # init-project
│   │   │   ├── setup.mjs                # setup (interactive)
│   │   │   ├── enrich.mjs               # enrich (queue runner)
│   │   │   ├── sanitize.mjs             # sanitize
│   │   │   ├── doctor.mjs               # doctor
│   │   │   ├── query.mjs                # query (direct query)
│   │   │   ├── retry-errors.mjs         # retry-errors
│   │   │   ├── project-context.mjs      # project-context (9 base memories)
│   │   │   ├── install-pmc.mjs          # install-pmc (internal)
│   │   │   └── enrich-sync.mjs          # Deprecated wrapper
│   │   ├── src/                         # Shared logic
│   │   │   ├── command-dispatch.mjs     # Central dispatcher
│   │   │   ├── setup-bootstrap.mjs      # Agent config generation
│   │   │   ├── template-installer.mjs   # Template rendering & installation
│   │   │   ├── enrichment-driver.mjs    # Enrichment orchestration
│   │   │   ├── enrichment-config.mjs    # Provider config resolution
│   │   │   ├── enrichment-attempts.mjs  # Attempt logging
│   │   │   ├── enrichment-errors.mjs    # Error classification
│   │   │   ├── sync-manifest.mjs        # Pending sync operations
│   │   │   ├── platform.mjs             # OS helpers (spawn, resolve, detect)
│   │   │   ├── materializer.mjs         # Project-context memory generation
│   │   │   ├── markdown-renderer.mjs    # Context → markdown
│   │   │   ├── refresh-state.mjs        # Incremental refresh tracking
│   │   │   ├── invalidation-matrix.mjs  # Detect stale context
│   │   │   ├── graph-node-resolver.mjs  # Graph ↔ symbol index join
│   │   │   ├── symbol-keys.mjs          # Symbol key normalization
│   │   │   ├── symbol-index.mjs         # Memory ↔ graph ID mapping
│   │   │   ├── graph-backfill.mjs       # Graph node enrichment
│   │   │   ├── semantic-unit.mjs        # Code fragment extraction
│   │   │   ├── semantic-report.mjs      # LLM output normalization
│   │   │   ├── memory-payload.mjs       # Memory document builder
│   │   │   ├── result-input.mjs         # Load enrichment inputs
│   │   │   ├── change-detector.mjs      # File change detection
│   │   │   ├── declared-intake.mjs      # User-declared project metadata
│   │   │   ├── doctor.mjs               # Environment diagnostics
│   │   │   ├── providers/
│   │   │   │   ├── local-model-provider.mjs   # Ollama provider
│   │   │   │   └── cloud-api-provider.mjs     # Remote API provider
│   │   │   ├── extractors/
│   │   │   │   ├── stack-extractor.mjs        # Language/framework detection
│   │   │   │   ├── structure-extractor.mjs    # Directory layout detection
│   │   │   │   ├── symbol-extractor.mjs       # Top-level symbol extraction
│   │   │   │   └── regex-extractor.mjs        # Regex-based extraction
│   │   │   ├── query/
│   │   │   │   ├── load-artifacts.mjs         # Load graph/index data
│   │   │   │   └── orchestrator.mjs           # Query orchestration
│   │   │   ├── retrieval/
│   │   │   │   ├── query-engine.mjs           # BFS graph traversal engine
│   │   │   │   ├── target-resolver.mjs        # Resolve target → graph nodes
│   │   │   │   ├── context-renderer.mjs       # Results → structured markdown
│   │   │   │   └── context-renderer-v1.mjs    # Legacy renderer
│   │   │   └── retry-errors-runner.mjs        # Retry failed enrichments
│   │   ├── templates/                   # Agent config templates
│   │   │   ├── opencode/
│   │   │   │   ├── commands/             # Command .md files
│   │   │   │   ├── agents/               # Agent definitions
│   │   │   │   └── autostart-snippet.md  # Session-start snippet
│   │   │   ├── claude-code/
│   │   │   │   └── CLAUDE.md.snippet
│   │   │   ├── cursor/
│   │   │   │   └── .cursorrules.snippet
│   │   │   ├── generic/
│   │   │   │   └── README-SETUP.md
│   │   │   └── pmc-skill/               # Skill template for PMC itself
│   │   ├── mcp/
│   │   │   └── pmc-query-server.mjs     # MCP server for context queries
│   │   ├── plugin/                      # OpenCode plugin config
│   │   ├── tests/                       # 349 tests (Node test runner)
│   │   ├── README.md                    # Package README (~568 lines)
│   │   └── package.json                 # @aabadin/project-memory-context
│   └── pmc-graph-explorer/              # Interactive D3.js graph viewer
│       ├── server.mjs                   # Express API server
│       ├── public/                      # Static HTML/JS/CSS
│       └── package.json
├── target-resolver/                     # Standalone target resolution experiments
├── docs/
│   └── superpowers/
│       ├── specs/                       # Design specs (14 documents)
│       └── plans/                       # Implementation plans (12 documents)
├── .planning/                           # PMC state for THIS repo (dogfooding)
│   └── project-memory-context/
│       ├── enrichment/
│       ├── graph/
│       ├── project-context/
│       └── install.json
├── AGENTS.md                            # PMC autostart for OpenCode
├── documentation.md                     # ← This file
└── opencode.jsonc                       # OpenCode project config
```

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        PMC Package (@aabadin/...)                        │
│                                                                          │
│  CLI Layer (cli/*.mjs)                                                   │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │  setup   map-project   init-project   enrich   enrich-status    │    │
│  │  get-context  sync-context  sanitize  doctor  retry-errors      │    │
│  │  project-context  query  view-context                          │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│       │ dispatch via src/command-dispatch.mjs                            │
│       ▼                                                                  │
│  Source Layer (src/*.mjs)                                                │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │  providers/     extractors/      retrieval/      query/          │    │
│  │  enrichment-*   sync-manifest   query-engine   orchestrator     │    │
│  │  platform       template-*      materializer   load-artifacts   │    │
│  │  semantic-*     symbol-*        graph-*        refresh-state    │    │
│  │  memory-payload markdown-*      invalidation   change-detector  │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│       │                                                                  │
│       ▼                                                                  │
│  ┌────────────────────────────┐  ┌─────────────────────────────────┐    │
│  │  Agent Memory MCP          │  │  Graph Explorer                 │    │
│  │  (LanceDB + bge-m3)        │  │  (Express + D3.js)              │    │
│  │  Hybrid BM25 + vector      │  │  Interactive visualization      │    │
│  └────────────────────────────┘  └─────────────────────────────────┘    │
│                                                                          │
│  ┌────────────────────────────┐  ┌─────────────────────────────────┐    │
│  │  Templates                 │  │  External Dependencies          │    │
│  │  opencode/ claude-code/    │  │  Ollama (local LLM)             │    │
│  │  cursor/ generic/          │  │  graphifyy (Python, AST graph)  │    │
│  └────────────────────────────┘  └─────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘
```

### Consumer Project Model

After `pmc setup` or `pmc map-project`, a consumer project contains **only**:

```
consumer-repo/
├── .planning/project-memory-context/   # State, data, artifacts
├── .mcp.json                           # Universal MCP config
├── .opencode/ or .claude/ or .cursor/  # Agent-specific configs
└── AGENTS.md                           # Autostart snippet (if opencode)
```

No PMC source code is copied into consumer projects. All executable behavior runs from the installed npm package.

---

## 4. Public CLI Contract

### Agent-Facing Commands

These are the commands exposed through agent command templates:

| Command | Internal Module | Purpose |
|---------|----------------|---------|
| `pmc get-context <target> [depth] [focus]` | `cli/context.mjs` | Render structural context for a symbol, file, or query |
| `pmc sync-context` | `cli/sync.mjs` | Apply pending sync-manifest operations to agent-memory |
| `pmc sanitize` | `cli/sanitize.mjs` | Clean up stale artifacts, rebuild worklist |
| `pmc map-project [--all] [--enrich]` | `cli/bootstrap.mjs` | Full pipeline: graphify → extract → enrich |
| `pmc init-project [--agent ...]` | `cli/init.mjs` | Initialize PMC state + agent templates |
| `pmc doctor` | `cli/doctor.mjs` | Environment diagnostics |
| `pmc enrich-status` | `cli/status.mjs` | Show enrichment progress |
| `pmc retry-errors [options]` | `cli/retry-errors.mjs` | Retry failed enrichments |
| `pmc view-context` | `bin/pmc-view-context.mjs` | View current context |

### Operational Commands

These are used for setup and internal operations:

| Command | Internal Module | Purpose |
|---------|----------------|---------|
| `pmc setup [--opencode\|--claude\|--cursor\|--generic]` | `cli/setup.mjs` | Interactive bootstrap with agent detection |
| `pmc enrich [project-dir]` | `cli/enrich.mjs` | Run enrichment queue |
| `pmc project-context [--refresh]` | `cli/project-context.mjs` | Materialize 9 base memories |
| `pmc query` | `cli/query.mjs` | Direct query against PMC data |
| `pmc install-pmc` | `cli/install-pmc.mjs` | Initialize planning state (internal) |

### Legacy Names (Rejected)

These old command names are explicitly rejected by the dispatcher:

- `bootstrap`, `context`, `status`, `sync`, `init`, `new-project`

Invoking any of these returns `Invalid command: <name>` with the usage text.

---

## 5. Key Subsystems

### 5.1 Enrichment Pipeline

The enrichment pipeline takes every extracted symbol and produces a structured description using an LLM.

**Flow per symbol:**

```
Symbol key from worklist.json
  → semantic-unit.mjs: extract code fragment + imports
  → provider (local-model or cloud-api): call LLM with structured prompt
  → semantic-report.mjs: normalize LLM output
  → memory-payload.mjs: build memory document
  → sync-manifest: queue upsert to agent-memory
  → finalize: update graph.json + symbol-index.json + worklist.json
```

**Provider fallback chain:** Configured via `enrichment-config.mjs`. Ordered list of providers tried in sequence. If `local-model` fails, falls back to `cloud-api`. Each attempt is logged to `enrichment-attempts.mjs`.

**Concurrency:** Controlled by `PMC_CONCURRENCY` env var (default: 8 parallel slots).

**Resumability:** The worklist tracks each symbol's status (`pending`, `enriched`, `stale`, `failed`). Interruption is safe — the queue resumes from the last checkpoint.

### 5.2 Retrieval Layer

The retrieval layer lets agents request targeted structural context without reading source files.

**Components:**

| Component | File | Role |
|-----------|------|------|
| Query Engine | `src/retrieval/query-engine.mjs` | BFS graph traversal, joins with enriched data |
| Target Resolver | `src/retrieval/target-resolver.mjs` | Resolve symbol names, file paths, or queries to graph nodes |
| Context Renderer | `src/retrieval/context-renderer.mjs` | Results → structured markdown with token budget |

**Depth levels:**

| Depth | Content | Typical tokens |
|-------|---------|----------------|
| `compact` | Symbol name + one-line summary | ~50 |
| `extended` | Full LLM-generated description | ~200 |
| `deep` | Description + all neighbors (depends on / depended by) | ~500 |
| `disk` | Includes raw source code | ~1000+ |

**Query flow:**

```
Agent → pmc get-context target=embedder.ts depth=compact
  → target-resolver: resolve "embedder.ts" → file node in graph
  → query-engine: BFS from node, join with symbol-index + .memory.json files
  → context-renderer: structured markdown output
  → agent receives context without reading files
```

### 5.3 Sync Manifest

The sync-manifest (`sync-manifest.json`) is a bridge between enrichment and agent-memory persistence.

**Purpose:** Instead of calling `agent-memory store/update` directly during enrichment (which would require a running MCP server), the enrichment pipeline queues operations to the sync-manifest. The `pmc sync-context` command then applies them in batch.

**Operations:**

| Operation | Description |
|-----------|-------------|
| `upsert` | Create or update a memory |
| `delete` | Remove a memory |

**Convergence:** Duplicate entries for the same memory ID are converged (latest wins). Entries marked `synced` are cleaned up.

**Key functions in `sync-manifest.mjs`:**
- `appendSyncEntry()` / `appendSyncEntries()` — queue operations
- `getPendingUpserts()` / `getPendingDeletes()` — retrieve pending
- `markEntriesSynced()` — mark as applied
- `removeSyncedEntries()` — garbage collect completed

### 5.4 Project-Context Materialization

PMC generates 9 "base memories" about the project that give agents high-level context at session start:

| # | Memory Key | Source | Description |
|---|-----------|--------|-------------|
| 1 | `stack-runtime` | `package.json`, `tsconfig.json`, etc. | Language, framework, runtime version |
| 2 | `dependencies-summary` | `package.json` dependencies | Key dependencies and libraries |
| 3 | `integrations-summary` | Source analysis | External services and APIs |
| 4 | `architecture-current` | `src/` structure | Current architecture patterns |
| 5 | `architecture-target` | User-declared | Desired target architecture |
| 6 | `structure-summary` | Directory listing | Root directories, key subtrees |
| 7 | `technical-rules` | Source conventions | Coding standards and rules |
| 8 | `project-requirements` | User-declared | Business and functional requirements |
| 9 | `known-issues-and-fixes` | Enrichment failures | Known issues and workarounds |

**Refresh:** `pmc project-context --refresh` only regenerates memories whose source files have changed, tracked by `refresh-state.mjs` and `invalidation-matrix.mjs`.

### 5.5 Graph Explorer

An interactive web UI for visualizing the PMC knowledge graph.

**Stack:** Express 5 server (`server.mjs`) + vanilla HTML/JS with D3.js v7.

**Features:**
- Force-directed graph layout with zoom/pan/drag
- Nodes colored by community (module clustering from graphifyy)
- Node radius by kind: file (12px), class/interface (8px), function/method (5px)
- Active context highlighting: cyan glow + pulse animation for "in context" symbols
- Collapsible side panel with node detail + relationship lists
- Community filter toggles and stats counters
- Search by node label
- REST API endpoints: `/api/graph`, `/api/communities`, `/api/context`

### 5.6 Agent Setup & Templates

`pmc setup` generates agent-specific configurations from templates:

| Agent | Config Files | MCP Config |
|-------|-------------|------------|
| OpenCode | `.opencode/opencode.json`, `AGENTS.md`, command `.md` files | Via opencode plugin |
| Claude Code | `.claude/project-memory-context.json`, `CLAUDE.md` snippet | `.mcp.json` |
| Cursor | `.cursor/project-memory-context.json`, `.cursorrules` snippet | `.mcp.json` |
| Generic | `README-SETUP.md` | `.mcp.json` |

**MCP servers configured:**
- `agent-memory` — `npx -y @aabadin/agent-memory-mcp` (LanceDB persistence)
- `pmc-query` — `npx -y @aabadin/project-memory-context pmc-query-server` (context queries)

**Template rendering:** Templates use `{{PMC_BIN}}`, `{{PMC_PACKAGE_ROOT}}`, `{{PROJECT_ROOT}}` placeholders resolved by `template-installer.mjs`.

**Autostart:** Agent config includes a session-start snippet that:
1. Checks for pending/stale enrichment work
2. Launches background enrichment if needed
3. Checks sync-manifest for pending sync operations
4. Recalls base project context from agent-memory

---

## 6. Data Model

### Key Files in Consumer Project

| File | Schema | Purpose |
|------|--------|---------|
| `install.json` | `{ projectRoot, memoryDbPath, sourceRoot, version, installedAt }` | PMC install state |
| `worklist.json` | `{ entries: [{ symbolKey, filePath, kind, name, status, memoryId, ... }] }` | All symbols + enrichment status |
| `sync-manifest.json` | `{ entries: [{ id, memoryId, operation, status, memory, ... }] }` | Pending agent-memory syncs |
| `graph.json` | graphifyy output: `{ nodes: [...], edges: [...] }` | Knowledge graph |
| `symbol-index.json` | `{ entries: [{ symbolKey, graphNodeId, memoryId, ... }] }` | Symbol ↔ graph ↔ memory mapping |
| `*.memory.json` | `{ id, content, category, tags, ... }` | Per-symbol enriched memory payloads |
| `semantic-jobs.json` | `{ jobs: [{ symbolKey, prompt, ... }] }` | Prepared LLM enrichment jobs |
| `failures.json` | `{ entries: [{ symbolKey, error, timestamp, ... }] }` | Failed enrichment attempts |
| `queue-state.json` | `{ current, total, startedAt, ... }` | Enrichment queue progress |

### Symbol Key Format

```
{lang}_{file_path}_{kind}_{visibility}_{name}_{arity}
```

Example: `js_src_retrieval_query-engine_mjs_function_exported_createQueryEngine_1`

### Memory Document Schema

```json
{
  "id": "uuid",
  "content": "## SymbolName (kind) — file:line\n\n### Responsibility\n...\n### Primary Inputs\n...\n### Output\n...\n### Immediate Dependencies\n...\n### Role in Module\n...",
  "category": "architecture",
  "tags": ["symbol", "js", "function", "project:slug", "file:path"]
}
```

---

## 7. Provider Model

The enrichment pipeline uses a provider abstraction with ordered fallback:

### Local Model Provider

| Property | Value |
|----------|-------|
| Class | `local-model-provider.mjs` |
| Config | `PMC_LOCAL_MODEL_BASE_URL` (default: `http://localhost:11434`) |
| Model | `PMC_LOCAL_MODEL_NAME` or `OLLAMA_MODEL` |
| Default model | `deepseek-coder-v2:16b-ctx32k` |

### Cloud API Provider

| Property | Value |
|----------|-------|
| Class | `cloud-api-provider.mjs` |
| Config | `PMC_CLOUD_API_KEY`, `PMC_CLOUD_API_BASE_URL` |
| Status | Implemented, requires API key |

### Fallback Configuration

Resolved by `enrichment-config.mjs` in order:
1. Project-level config: `.planning/project-memory-context/enrichment-config.json`
2. Global config: `~/.config/opencode/project-memory-context.json`
3. Environment variable overrides
4. Default: `["local-model", "cloud-api"]`

---

## 8. External Dependencies

| Dependency | Purpose | Required |
|-----------|---------|----------|
| Node.js >= 18 | Runtime | Yes |
| Ollama | Local LLM for enrichment | Recommended |
| Python 3 + graphifyy | AST-level knowledge graph | For `map-project --stage-a` |
| ~2 GB disk | Embedding model cache + LanceDB | Yes |

---

## 9. Embedding Model

| Property | Value |
|----------|-------|
| Model | `Xenova/bge-m3` |
| Dimensions | 1024 |
| Pooling | CLS (first token) |
| Runtime | ONNX via `@huggingface/transformers` |
| Cache | Local ONNX model cache (~1 GB first download) |
| Provider | Runs inside `agent-memory-mcp` process, fully local |

Used for: converting every memory into a dense vector for semantic similarity search. No network calls during normal operation after initial model download.

---

## 10. Testing

**Framework:** Node.js built-in test runner (`node --test`)
**Location:** `tools/project-memory-context/tests/`
**Count:** 349 tests across 35+ test files

### Key Test Files

| Test File | Coverage |
|-----------|----------|
| `command-dispatch.test.mjs` | CLI dispatcher: new names resolve, legacy names rejected |
| `template-command-contract.test.mjs` | Templates use correct `pmc` subcommands, no legacy references |
| `install-pmc.test.mjs` | Install creates state only, no copied runtime |
| `setup-bootstrap.test.mjs` | Bootstrap runs from package, no sync-to-target |
| `init.test.mjs` | Agent template installation |
| `sync-cli.test.mjs` | `pmc sync-context` upsert/delete |
| `sync-manifest.test.mjs` | Manifest operations, convergence |
| `context-cli.test.mjs` | `pmc get-context` rendering |
| `query-engine.test.mjs` | BFS traversal, depth levels |
| `enrichment-driver.test.mjs` | Provider fallback chain |
| `symbol-extractor-multilang.test.mjs` | JS/TS/C# symbol extraction |

### Running Tests

```bash
# All tests
node --test tools/project-memory-context/tests/*.test.mjs

# Focused suite (dispatcher + templates + install + bootstrap)
node --test tools/project-memory-context/tests/command-dispatch.test.mjs \
  tools/project-memory-context/tests/template-command-contract.test.mjs \
  tools/project-memory-context/tests/install-pmc.test.mjs \
  tools/project-memory-context/tests/setup-bootstrap.test.mjs
```

---

## 11. Environment Variables

### PMC Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PMC_CLOUD_API_KEY` | *(none)* | API key for cloud enrichment |
| `PMC_CONCURRENCY` | `8` | Parallel enrichment slots |
| `PMC_GRAPHIFY_PATH` | *(auto-detect)* | Custom graphify executable path |
| `PMC_GRAPHIFY_BIN` | *(auto-detect)* | Alternative graphify path |
| `PMC_GLOBAL_CONFIG` | `~/.config/opencode/project-memory-context.json` | Global config override |
| `PMC_LOCAL_MODEL_BASE_URL` | `http://localhost:11434` | Ollama URL |
| `PMC_LOCAL_MODEL_NAME` | *(from setup)* | Ollama model name |
| `OLLAMA_URL` | `http://localhost:11434` | Alias for PMC_LOCAL_MODEL_BASE_URL |
| `OLLAMA_MODEL` | `deepseek-coder-v2:16b-ctx32k` | Alias for PMC_LOCAL_MODEL_NAME |

### Agent Memory MCP Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEMORY_DB_PATH` | *(required)* | LanceDB database directory |
| `EMBEDDING_MODEL` | `Xenova/bge-m3` | Embedding model |
| `EMBEDDING_DIMENSIONS` | `1024` | Vector dimensions |
| `EMBEDDING_POOLING` | `cls` | Pooling strategy |
| `EMBEDDING_CACHE_PATH` | *(optional)* | Binary embedding cache |
| `MEMORY_DECAY_HALF_LIFE` | `30` days | Decay half-life (0 to disable) |
| `ENABLE_HARDCOPY` | `false` | Enable JSON file backup |
| `HARDCOPY_PATH` | *(if hardcopy)* | Directory for mirror files |

---

## 12. Current Implementation State

### Completed (0.2.17)

| Feature | Status | Notes |
|---------|--------|-------|
| Global CLI dispatcher | Done | All new public names, legacy rejected |
| Template alignment | Done | All agent templates use `pmc <subcommand>` |
| Install without copy | Done | No runtime source in consumer projects |
| Bootstrap from package | Done | Enrichment launched from package path |
| Enrichment pipeline | Done | local-model + cloud-api providers with fallback |
| Retrieval layer | Done | Query engine + target resolver + context renderer |
| Sync-manifest | Done | Real upsert/delete with duplicate convergence |
| Project-context materialization | Done | 9 base memories with incremental refresh |
| Graph Explorer V1 | Done | D3.js force-directed graph with context tracking |
| Auto-retry errors | Done | Retry failed enrichments with backoff |
| Multi-agent setup | Done | `pmc setup --opencode --claude --cursor` |
| MCP servers | Done | agent-memory + pmc-query in `.mcp.json` |
| Autostart autodetection | Done | Source repo vs consumer auto-detection |
| PMC skill | Done | Installed at `~/.agents/skills/project-memory-context/` |
| Package README | Done | ~568 lines, comprehensive CLI reference |
| Test suite | Done | 349 tests passing |
| This dogfood repo | Done | 399 symbols enriched, sync-manifest fully synced |

### Partially Complete

| Feature | Status | Notes |
|---------|--------|-------|
| Tree-sitter extraction | Designed, not started | Design spec exists (`2026-05-19-pmc-tree-sitter-design.md`) |
| Agent-memory concurrency | Designed, not started | Design spec exists (`2026-05-19-agent-memory-concurrency-design.md`) |
| Status runtime state | Designed, not started | Design spec exists (`2026-05-20-pmc-status-runtime-state-design.md`) |

### Not Started

| Feature | Notes |
|---------|-------|
| Automatic migration tooling for legacy `tools/project-memory-context/` copies | Explicitly out of scope |
| Hosted daemon / always-on enrichment | Explicitly non-goal |
| `agent-subagent` provider | Designed but not implemented |
| Graph Explorer V2 | V1 complete, no V2 spec yet |

---

## 13. Key Decisions & Rationale

| Decision | Rationale |
|----------|-----------|
| Only new command names (no legacy aliases) | Clean break prevents confusion; agents use templates, not manual commands |
| Consumer projects keep only `.planning/` + agent config | Package is runtime, not vendored toolchain; single source of truth |
| Sync-manifest as bridge | Decouples enrichment from MCP server availability; batch operations are more reliable |
| Query engine reads filesystem, not agent-memory | Graph traversal is fast (<5ms), zero sync overhead, agent always has filesystem access |
| bge-m3 (1024d) over MiniLM (384d) | Better semantic quality; worth the larger model cache |
| Node test runner over Jest/Vitest | Zero dependencies, native ESM, good enough for this scope |
| Dark theme for Graph Explorer | Reduces visual noise, makes glow effects visible |
| Templates with `{{PMC_BIN}}` placeholders | Resolves to `npx` or `node` depending on install method |

---

## 14. Roadmap & Recommended Decisions

### Near-Term (Next Sprint)

#### 14.1 Commit Pending Changes

The working tree has **many uncommitted changes** from the global CLI redesign and follow-ups. Recommended action:

```bash
# Stage and commit the global CLI redesign
git add tools/project-memory-context/src/command-dispatch.mjs \
  tools/project-memory-context/cli/ \
  tools/project-memory-context/templates/ \
  tools/project-memory-context/tests/ \
  tools/project-memory-context/README.md
git commit -m "feat(pmc): global cli redesign — new public commands, no runtime copy"
```

**Decision needed:** Single monolithic commit or split into the 5 task commits from the implementation plan?

#### 14.2 Graph Explorer Context Tracking Integration

The Graph Explorer has a `context-tracker.json` and `/api/context` endpoint, but the context tracking data is not yet connected to the enrichment status display. Recommended:

- Add enrichment status overlay to Graph Explorer nodes (pending/enriched/failed color coding)
- Connect context-tracker to `pmc get-context` results
- Add right-click → "get context" in the graph UI

#### 14.3 Incremental Re-enrichment on File Change

Currently `pmc sanitize` handles cleanup, but there's no automated re-enrichment when source files change. Recommended:

- Use `change-detector.mjs` to identify stale symbols
- Auto-mark stale symbols in worklist when `pmc map-project --stage-b` runs
- Add `pmc enrich --stale-only` flag

### Mid-Term

#### 14.4 Tree-Sitter Extraction

Design spec exists at `docs/superpowers/specs/2026-05-19-pmc-tree-sitter-design.md`. This would replace/augment the regex-based symbol extractor with proper AST parsing for better accuracy on complex syntax.

**Decision needed:** Priority relative to other features? The regex extractor works for JS/TS/C# but struggles with decorators, complex generics, and some edge cases.

#### 14.5 Agent-Memory Concurrency

Design spec exists at `docs/superpowers/specs/2026-05-19-agent-memory-concurrency-design.md`. LanceDB has concurrency limitations. This would add proper locking and concurrent write safety.

**Decision needed:** Is this blocking any real workflows? The current serial enrichment works but is slower than it could be.

#### 14.6 `agent-subagent` Provider

The enrichment fallback design includes a third provider mode where the opencode agent itself performs enrichment via subagents. This would eliminate the Ollama dependency for users who have a capable coding agent but no local LLM.

**Decision needed:** What's the provider prompt? How to handle rate limits and context window constraints?

#### 14.7 Multi-Project Support

Currently PMC is designed for one project per session. Multi-project support would let an agent work across repositories with shared context.

**Decision needed:** Shared LanceDB with project-scoped tags vs separate databases? How to handle cross-project symbol references?

### Long-Term

#### 14.8 PMC as MCP Server

The `pmc-query-server.mjs` already exists as an MCP server. Recommended evolution:

- Expose all PMC commands as MCP tools (not just query)
- Let agents call `pmc get-context`, `pmc enrich-status`, `pmc sync-context` directly via MCP
- Eliminate the need for command markdown templates entirely

#### 14.9 Graph Explorer V2

Potential features:
- Incremental graph updates (don't re-run full graphifyy)
- Time-travel: show graph at a specific commit
- Impact analysis mode: highlight blast radius of a change
- Integration with git diff to show what changed in the graph

#### 14.10 Language Server Protocol

PMC could expose context as an LSP, providing real-time context in editors (VS Code, Neovim, etc.) alongside the agent experience.

---

## 15. Known Issues & Follow-ups

| Issue | Severity | Notes |
|-------|----------|-------|
| Many uncommitted files in working tree | High | Global CLI redesign + follow-ups not committed |
| `.tgz` artifacts in `tools/project-memory-context/` | Low | 0.1.0, 0.1.1, 0.1.2 tarballs; should be gitignored or removed |
| `graphify-out/` in working tree | Low | Build artifact; should be gitignored |
| `.playwright-mcp/` in working tree | Low | Playwright MCP state; should be gitignored |
| `repository` field in package.json points to wrong repo | Medium | Points to `adamrdrew/agent-memory-mcp` instead of this repo |
| Legacy wrappers still exist | Low | `enrich-sync.mjs`, `enrich-orchestrator.mjs`, `batch-enrich.mjs`, `enrich-batch.mjs` print deprecation messages but are still in the package |
| `--refresh` on `pmc map-project` | Low | Not fully documented in CLI reference |
| `target-resolver/` directory at repo root | Low | Standalone experiment; unclear if still needed |
| `criticas.md`, `problemas.md`, `plancriticas.md` at root | Low | Working notes; should be cleaned up or moved |
| `session-ses_1cd2.md` at root | Low | Session artifact; should be cleaned up |
| Graph Explorer not integrated into `pmc` CLI | Medium | Standalone Express server, not a `pmc` subcommand |
| `agent-subagent` provider not implemented | Low | Designed but not built |

---

## Appendix A: Design Specs Index

| Spec | Date | Status |
|------|------|--------|
| Project Memory Context | 2026-05-15 | Implemented |
| Retrieval Layer | 2026-05-17 | Implemented |
| Enrichment Fallback | 2026-05-17 | Implemented |
| Project Context Persistence | 2026-05-17 | Implemented |
| Portable NPM Package | 2026-05-18 | Implemented |
| Agent-Memory Concurrency | 2026-05-19 | Designed, not started |
| Tree-Sitter Extraction | 2026-05-19 | Designed, not started |
| PMC Query Access | 2026-05-19 | Implemented |
| PMC Autostart Autodetection | 2026-05-21 | Implemented |
| Graph Explorer | 2026-05-21 | Implemented (V1) |
| Auto-Retry Errors | 2026-05-21 | Implemented |
| Status Runtime State | 2026-05-20 | Designed, not started |
| Global CLI Redesign | 2026-05-24 | Implemented |

## Appendix B: Published Package Versions

| Version | Date | Key Changes |
|---------|------|-------------|
| 0.1.0 | 2026-05-15 | Initial publish |
| 0.1.1 | 2026-05-16 | Bug fixes |
| 0.1.2 | 2026-05-17 | Enrichment fallback |
| 0.2.17 | 2026-05-24 | Global CLI redesign, no runtime copy |
