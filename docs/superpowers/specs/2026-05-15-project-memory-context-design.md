# Project Memory Context Design

**Date:** 2026-05-15

## Goal

Build a resumable workflow for existing codebases that captures project context, generates a graph-based structural map, enriches top-level symbols with local semantic analysis, stores that semantic layer in `agent-memory`, and links each graph node back to the persisted memory via `memory_id`.

## Scope

Version 1 supports:

- Stage A intake for brownfield projects
- ambiguity clarification via `brainstorming`
- structural graph generation via `graphify`
- semantic enrichment for top-level `JavaScript`, `TypeScript`, and `.NET/C#` symbols
- deterministic upsert into `agent-memory`
- graph backfill with `memory_id`, semantic summary, and enrichment metadata
- resumable state under `.planning/project-memory-context/`

Version 1 does not include:

- generic multilang support beyond `JS/TS + .NET`
- automatic deletion of orphaned memories
- deep indexing of nested helpers or local closures
- full cross-symbol global reasoning in a single semantic pass

## Architecture

The workflow is split into two resumable stages.

### Stage A: Intake + Base Map

The command asks for:

- project description
- mapping goals
- optional focus areas

The workflow then invokes `brainstorming` to resolve ambiguity in the intake before any mapping occurs.

After the intake is clarified, the workflow persists the context locally and executes `graphify` against the project to produce the structural graph and graph artifacts.

### Stage B: Semantic Enrichment

The workflow loads the graph artifacts, extracts supported top-level symbols, and builds a deterministic worklist. Each work item is reduced to a single semantic unit and sent to `ia-local` using the configured local coder model.

The semantic result is persisted in `agent-memory` using upsert-by-symbol-key semantics. The workflow then updates the graph node with the returned `memory_id`, semantic summary, code hash, and enrichment status.

## Key Design Decisions

### Structural-first pipeline

`graphify` is the structural source of truth. `agent-memory` is the semantic persistence layer. The workflow never treats semantic memory as the source of graph structure.

### Symbol-level enrichment

The enrichment unit is one supported top-level symbol at a time by default.

Only in tightly coupled cases may the workflow widen the semantic unit to a micro-subgraph, such as:

- a class with an adjacent contract in the same file
- a method that depends on nearby DTOs or constants
- a small `.NET` local contract cluster

### Deterministic upsert

Each supported symbol receives a canonical `symbol_key`. That key is the stable reconciliation key for semantic updates.

If the symbol body changes but the `symbol_key` remains stable, the workflow updates the existing memory.

If the identity changes, the workflow creates a new memory and graph link.

The persistent `symbol-index.json` is the bidirectional lookup table between the graph and `agent-memory`.

## Supported Symbols

### JavaScript / TypeScript

- exported functions
- top-level function declarations
- exported arrow-function bindings
- classes
- interfaces
- relevant type aliases when they act as module contracts

Excluded in v1:

- nested closures
- callbacks
- local helper functions inside another symbol

### .NET / C#

- namespaces
- classes
- records
- interfaces
- public methods and top-level relevant methods

Excluded in v1:

- trivial private methods
- tiny property accessors
- generated members

## Symbol Identity

### JavaScript / TypeScript key

`language | normalized_file_path | symbol_kind | export_scope | symbol_name | arity`

Example:

`ts|src/services/user.ts|function|exported|getUser|2`

### C# key

`language | normalized_file_path | namespace | container_type | symbol_kind | symbol_name | signature`

Example:

`csharp|Services/UserService.cs|MyApp.Services|UserService|method|GetUserAsync|(Guid,CancellationToken)`

## Semantic Payload in agent-memory

Each memory stores compact search-oriented semantic content, not raw code replication.

Minimum payload fields:

- symbol name
- symbol kind
- language
- location (`file + line range`)
- responsibility summary
- primary inputs
- output / return shape
- immediate dependencies
- short module role note

Suggested memory metadata:

- category: `architecture`
- tags:
  - `symbol`
  - language tag (`ts`, `js`, `csharp`)
  - kind tag (`function`, `class`, `interface`, `method`, `record`)
  - `project:<slug>`
  - `file:<normalized-path>`

## Graph Backfill

Each enriched node should include at least:

- `symbol_key`
- `graph_node_id`
- `memory_id`
- `semantic_summary`
- `code_hash`
- `last_enriched_at`
- `enrichment_status`

Allowed statuses in v1:

- `pending`
- `enriched`
- `skipped`
- `stale`
- `error`

## Local Artifacts

Workflow state is stored under:

```text
.planning/project-memory-context/
  intake/
    latest-context.json
    latest-clarifications.md

  graph/
    graph.json
    graph.html
    GRAPH_REPORT.md
    graph.metadata.json

  enrichment/
    symbol-index.json
    worklist.json
    enrichment-report.json
    failures.json

  runs/
    <timestamp>-stage-a.json
    <timestamp>-stage-b.json
```

## Operational Flow

### Stage A

1. Ask for project description and goals
2. Invoke `brainstorming` to clarify ambiguity
3. Persist intake artifacts
4. Execute `graphify`
5. Save graph metadata and Stage A run summary

### Stage B

1. Load graph artifacts
2. Extract supported symbols
3. Compute `symbol_key` and `code_hash`
4. Build enrichment worklist
5. For each pending symbol:
   - build semantic unit
   - call `ia-local`
   - upsert semantic memory in `agent-memory`
   - backfill graph node
   - update `symbol-index.json`
6. Save run report and failures

`symbol-index.json` stores `symbol_key -> memory_id + graph_node_id + code_hash + status` so both `graph -> semantic` and `semantic -> graph` resolution remain deterministic.

## Testing Strategy

Version 1 requires tests for:

- artifact directory creation and persistence
- symbol key generation for `JS/TS` and `C#`
- top-level symbol extraction for `JS/TS` and `C#`
- worklist generation with `code_hash` and prior index state
- graph node backfill preserving existing node data

## Success Criteria

- a project can be described and that intake is persisted locally
- the workflow can generate a structural graph artifact set
- `JS/TS + .NET` top-level symbols can be enumerated deterministically
- each supported symbol can produce a stable `symbol_key`
- semantic memories are upserted by `symbol_key`
- graph nodes are linked to `agent-memory` with `memory_id`
- the workflow can resume without duplicating already indexed symbols
