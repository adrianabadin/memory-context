# PMC SQLite Graph Store Design

**Date:** 2026-06-02  
**Status:** Approved  
**Replaces:** BFS-over-graph.json in `src/retrieval/query-engine.mjs`

---

## Problem

Every `pmc get-context` invocation:
1. Loads `graph.json` (5.5 MB for this repo) fully into memory.
2. Runs an unindexed BFS that scans **all edges** on every hop:
   `O(frontier × |edges| × maxHops)`. At `deep` depth (maxHops=3) this is
   O(frontier³ × |E|) in the worst case.
3. Rebuilds every in-memory index (`nodeMap`, `nameToSymbolKeys`,
   `filePathToSymbolKeys`) from scratch — even if nothing changed.

As graphs grow (multi-repo, monorepo) this becomes the dominant latency in
the retrieval path. The deep research (NotebookLM, 41 sources, 2026-06-02)
confirmed that the SOTA approach — Codebase-Memory (arXiv 2026), GitNexus —
uses an embedded relational graph store with indexed adjacency and recursive
traversal, achieving sub-ms queries on repos with 75k+ files.

The multi-hop failure the research cited is also a real consequence of the BFS:
without proper edge-type filtering at the query level, results flatten across
unrelated edges and the `focus` parameter is expensive to honour correctly.

---

## Non-Goals

- Migrating the **LanceDB memory store** (`agent-memory-mcp`) — that is a
  separate cycle addressing concurrency blocker 14.5.
- Changing `graph.json` format — it remains the canonical export consumed by
  minimap, graph explorer, and GRAPH_REPORT.
- Storing embeddings in SQLite — vector search stays in LanceDB.
- Delta-incremental sync — v1 rebuilds the DB from scratch when the
  `content_hash` changes (full rebuild is fast enough; delta is a future
  optimisation).

---

## Solution

**`graph.db`** — a `node:sqlite` database located at
`.planning/project-memory-context/graph/graph.db`, derived from `graph.json`.
It acts as a persistent, indexed cache of the graph. It is rebuilt automatically
whenever the hash of `graph.json` changes.

### Why `node:sqlite`

| Aspect | `node:sqlite` (built-in) |
|--------|--------------------------|
| Dependencies | Zero — ships with Node ≥ 22.5 |
| Binaries / node-gyp | None |
| WAL mode | Native, single-statement `PRAGMA` |
| Platform | Identical on Windows / macOS / Linux |
| API | Synchronous (perfect for CLI) |
| Stability | Unflagged since Node 24 |

Minimum Node version for this feature: **≥ 24.0** (stable, no flags).  
Fallback for 22.5–23.x: `node --experimental-sqlite pmc ...` (documented in doctor output).  
Doctor check: `warn` if Node 22.5–23.x, `fail` if < 22.5.

---

## Architecture

```
graphifyy → graph.json  (canonical export — unchanged)
                │  openGraphDb() — lazy build + hash invalidation
                ▼
            graph.db    (derived index, gitignored)
                │  SqliteGraphStore.traverse()
                ▼
        query-engine.mjs (public API — unchanged)
                ▼
        get-context / dependencies / dependents / impact
```

### `GraphStore` interface

```js
// src/graph-store/graph-store.js  (JSDoc interface, not runtime)
/**
 * @typedef {Object} TraversalOptions
 * @property {string[]} nodeIds
 * @property {number}   maxHops
 * @property {string[]} edgeTypes
 * @property {'outbound'|'inbound'|'both'} direction
 *
 * @typedef {Object} TraversalResult
 * @property {GraphNode[]} nodes
 * @property {GraphEdge[]} edges
 * @property {number}      depth_reached
 */

/**
 * Minimal interface implemented by both SqliteGraphStore and InMemoryGraphStore.
 * @interface GraphStore
 */
// Methods:
//   traverse(TraversalOptions): TraversalResult
//   getNode(id: string): GraphNode | null
//   getNodesByFile(filePath: string): GraphNode[]
//   close(): void  — no-op for InMemoryGraphStore
```

### Implementations

**`src/graph-store/graph-db.mjs`** — `SqliteGraphStore`

- Opens (or creates) `graph.db` via `node:sqlite`.
- On open, reads `meta` table for stored `content_hash`; if missing or stale,
  calls `buildFromGraphJson(db, graph)` before returning.
- `buildFromGraphJson`: runs inside a single `BEGIN IMMEDIATE` transaction
  (DELETE all + bulk INSERT via prepared statements).
- `traverse()` executes a recursive CTE (see below).
- `close()` calls `db.close()`.

**`src/graph-store/in-memory-graph.mjs`** — `InMemoryGraphStore`

- Wraps the existing BFS logic extracted verbatim from `query-engine.mjs`.
- Used in tests (no file I/O) and as automatic fallback when `node:sqlite`
  is unavailable (Node < 22.5, detected at `openGraphDb` import time).

---

## Schema

```sql
-- DDL (applied once; versioned via user_version PRAGMA)
PRAGMA user_version = 1;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,
  label       TEXT,
  kind        TEXT,
  source_file TEXT,
  community   INTEGER,
  degree      INTEGER,
  metadata    TEXT     -- JSON blob for extra fields (norm_label, color, etc.)
);

CREATE TABLE IF NOT EXISTS edges (
  source   TEXT NOT NULL,
  target   TEXT NOT NULL,
  relation TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source, relation);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target, relation);
CREATE INDEX IF NOT EXISTS idx_nodes_file   ON nodes(source_file);
```

`meta` stores:
- `content_hash` — SHA-256 hex of the `graph.json` buffer used for last build.
- `built_at` — ISO timestamp of last build (for `pmc doctor` diagnostics).

---

## Traversal Query

### Outbound (dependencies)

```sql
WITH RECURSIVE reach(id, hop) AS (
  VALUES (:startId, 0)
  UNION ALL
  SELECT e.target, r.hop + 1
  FROM edges e
  JOIN reach r ON e.source = r.id
  WHERE r.hop < :maxHops
    AND e.relation IN (/* comma-expanded from edgeTypes */)
)
SELECT DISTINCT n.*, reach.hop
FROM reach
JOIN nodes n ON n.id = reach.id
WHERE reach.hop > 0;
```

### Inbound (callers / impact)

Same CTE, swap `e.source = r.id` → `e.target = r.id`, project `e.source`.

### Bidirectional (file context)

Run outbound + inbound, union the node/edge sets (dedup by id).

### Multi-start

Multiple `:startId` params → use `WHERE id IN (...)` as the base case
(SQLite recursive CTEs support `UNION ALL` from a multi-row VALUES clause).

---

## Invalidation Strategy

```
openGraphDb(dbPath, graphJsonPath):
  if dbPath does not exist:
    db = createAndBuild(dbPath, graphJsonPath)
  else:
    db = open(dbPath)
    storedHash = db.prepare("SELECT value FROM meta WHERE key='content_hash'").get()?.value
    currentHash = sha256(readFileSync(graphJsonPath))
    if storedHash !== currentHash:
      buildFromGraphJson(db, parseJson(graphJsonPath), currentHash)
  return db
```

`buildFromGraphJson` is synchronous (`node:sqlite` is sync-only). Full rebuild of
the 432-symbol graph in this repo takes < 50 ms in benchmarks.

---

## Changes to Existing Files

### `src/retrieval/query-engine.mjs`

`createQueryEngine` signature changes from:
```js
createQueryEngine({ graph, symbolIndex, worklist, enrichmentDir, projectSlug })
```
to:
```js
createQueryEngine({ graphStore, symbolIndex, worklist, enrichmentDir, projectSlug })
```

Where `graphStore` is a `GraphStore` instance. The `graph` parameter is removed.

All internal index lookups (`nodeMap`, per-file node scan) are replaced by
`graphStore.getNode(id)` and `graphStore.getNodesByFile(filePath)`.
`traverseGraph()` becomes a thin adapter calling `graphStore.traverse()`.

**Public API exported by `createQueryEngine` is unchanged:**
`querySymbolContext`, `queryFileContext`, `queryImpactScope`, `traverseGraph`,
`findSymbolKeyByName`, `findSymbolKeysByFilePath`, `graphNodeIdToSymbolKey`.

### `cli/context.mjs` — `loadArtifacts()`

```js
// Before
const graph = await readJsonArtifact(join(pmcRoot, 'graph', 'graph.json'), ...)
// ...
return { graph, symbolIndex, worklist }

// After
const graphStore = await openGraphDb(
  join(pmcRoot, 'graph', 'graph.db'),
  join(pmcRoot, 'graph', 'graph.json'),
)
return { graphStore, symbolIndex, worklist }
```

### `cli/bootstrap.mjs` + `cli/refresh-context.mjs`

After graphify writes `graph.json`, call:
```js
await buildGraphDb(pmcRoot)   // opens + (re)builds graph.db
```

### `src/doctor.mjs`

Add check:
```js
{
  name: 'Node.js ≥ 22.5 (node:sqlite)',
  check: () => {
    const [major, minor] = process.versions.node.split('.').map(Number)
    if (major < 22 || (major === 22 && minor < 5)) return { status: 'fail', message: '...' }
    if (major < 24) return { status: 'warn', message: 'Use --experimental-sqlite flag' }
    return { status: 'ok', message: `Node ${process.versions.node}` }
  }
}
```

### `package.json`

```json
"engines": { "node": ">=22.5.0" }
```

### `.planning/.../graph/graph.db`

Add to `.gitignore` in the PMC template (`.planning/project-memory-context/graph/graph.db`).

---

## File Map

| File | Action |
|------|--------|
| `tools/project-memory-context/src/graph-store/graph-db.mjs` | NEW |
| `tools/project-memory-context/src/graph-store/in-memory-graph.mjs` | NEW |
| `tools/project-memory-context/src/retrieval/query-engine.mjs` | MODIFY |
| `tools/project-memory-context/cli/context.mjs` | MODIFY |
| `tools/project-memory-context/cli/bootstrap.mjs` | MODIFY |
| `tools/project-memory-context/cli/refresh-context.mjs` | MODIFY |
| `tools/project-memory-context/src/incremental-graph.mjs` | MODIFY (if touches graph build) |
| `tools/project-memory-context/src/doctor.mjs` | MODIFY |
| `tools/project-memory-context/package.json` | MODIFY (engines) |
| `tools/project-memory-context/templates/*/gitignore` | MODIFY (add graph.db) |
| `tests/graph-db.test.mjs` | NEW |
| `tests/graph-store-parity.test.mjs` | NEW |

---

## Test Plan

### 1. Unit — `graph-db.test.mjs`

Fixture: small synthetic `graph.json` (10 nodes, 15 edges, 3 relations).

- `buildFromGraphJson` populates nodes + edges + meta correctly.
- `traverse` outbound, 1/2/3 hops, correct node set returned.
- `traverse` inbound, 1/2 hops.
- `traverse` bidirectional (both directions).
- Edge-type filter: only requested relations included.
- Content-hash invalidation: modify graph → re-open → DB rebuilt.
- WAL mode enabled (`PRAGMA journal_mode`).

### 2. Parity — `graph-store-parity.test.mjs`

Load real `graph.json` from this repo's `.planning/`. Run 20 representative
`traverse` calls (varying start, hops, direction, edge-type) against both
`SqliteGraphStore` and `InMemoryGraphStore`. Assert identical node-id sets and
edge sets. This guarantees zero functional regression.

### 3. Integration (manual / CI)

```bash
pmc get-context createQueryEngine
pmc get-context symbol buildFromGraphJson extended dependencies
pmc get-context file src/retrieval/query-engine.mjs deep all
pmc doctor
```

Expected: same neighbours as before; doctor shows Node check OK.

### 4. Performance

```bash
node --prof cli/context.mjs createQueryEngine   # before + after
```

Target: ≥ 5× improvement on `get-context` cold start for graphs > 500 nodes.

---

## Open Questions (resolved during design)

| Question | Decision |
|----------|----------|
| Which SQLite driver? | `node:sqlite` (built-in, no deps) |
| LanceDB memory store in scope? | No — separate cycle |
| Delta-incremental sync? | Not in v1 — full rebuild on hash change |
| Minimum Node version? | ≥ 22.5 (engines field); ≥ 24 recommended (no flag) |
| Fallback if sqlite unavailable? | `InMemoryGraphStore` — auto-selected at import time |
