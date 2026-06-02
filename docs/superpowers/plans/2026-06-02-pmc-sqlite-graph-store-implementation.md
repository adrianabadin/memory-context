# PMC SQLite Graph Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the BFS-over-graph.json in `query-engine.mjs` with a persistent, indexed SQLite graph store (using `node:sqlite` built-in), eliminating the O(frontier×edges×hops) scan that runs from scratch on every `get-context` call.

**Architecture:** Two `GraphStore` implementations — `InMemoryGraphStore` (extracted BFS, backwards-compat shim) and `SqliteGraphStore` (node:sqlite with recursive CTE traversal). `createQueryEngine` accepts either via a `graphStore` param; passing the old `graph` object auto-wraps in `InMemoryGraphStore` so existing tests continue passing. `cli/context.mjs` is updated to lazy-open `graph.db` (rebuilding from `graph.json` if hash changed).

**Tech Stack:** `node:sqlite` (built-in, Node ≥ 22.5), `node:crypto` (SHA-256 hashing), `node:test` + `node:assert/strict` (tests), existing `readJsonArtifact` from `src/artifacts.mjs`.

---

## File Map

| File | Action |
|------|--------|
| `tools/project-memory-context/src/graph-store/in-memory-graph.mjs` | **NEW** — InMemoryGraphStore: BFS extracted verbatim from query-engine |
| `tools/project-memory-context/src/graph-store/graph-db.mjs` | **NEW** — SqliteGraphStore: node:sqlite, schema, WAL, recursive CTE traversal, hash invalidation |
| `tools/project-memory-context/tests/graph-db.test.mjs` | **NEW** — unit tests for graph-db.mjs |
| `tools/project-memory-context/tests/graph-store-parity.test.mjs` | **NEW** — parity: SqliteGraphStore === InMemoryGraphStore on same fixture |
| `tools/project-memory-context/src/retrieval/query-engine.mjs` | **MODIFY** — accept `graphStore` param (backward-compat: `graph` auto-wraps) |
| `tools/project-memory-context/cli/context.mjs` | **MODIFY** — `loadArtifacts` lazy-opens graph.db instead of loading graph.json |
| `tools/project-memory-context/cli/bootstrap.mjs` | **MODIFY** — build graph.db after graphify |
| `tools/project-memory-context/cli/refresh-context.mjs` | **MODIFY** — rebuild graph.db after graphify update |
| `tools/project-memory-context/src/doctor.mjs` | **MODIFY** — add node:sqlite version check |
| `tools/project-memory-context/tests/doctor.test.mjs` | **MODIFY** — assert 8 checks (was 7) + new node-sqlite check |
| `tools/project-memory-context/package.json` | **MODIFY** — `engines.node` → `>=22.5.0` |

---

## Task 1: Create InMemoryGraphStore (extract BFS from query-engine)

**Files:**
- Create: `tools/project-memory-context/src/graph-store/in-memory-graph.mjs`

This extracts the traversal logic that currently lives inside `createQueryEngine`. It is the backwards-compat shim — all existing tests continue working through it.

- [ ] **Step 1: Create the file**

```js
// tools/project-memory-context/src/graph-store/in-memory-graph.mjs

function normalizePath(filePath) {
  return String(filePath ?? '').replace(/\\/g, '/');
}

/**
 * Creates a GraphStore backed by an in-memory adjacency scan over `graph`.
 * Used for: backward-compat when `createQueryEngine` receives a `graph` object,
 *           and as the reference implementation in parity tests.
 *
 * @param {{ nodes?: object[], links?: object[] }} graph
 * @returns {GraphStore}
 */
export function createInMemoryGraphStore(graph) {
  const nodeMap = new Map();
  for (const node of graph.nodes ?? []) {
    nodeMap.set(node.id, node);
  }
  const links = graph.links ?? [];

  function traverse({ nodeIds, maxHops, edgeTypes, direction }) {
    const types = edgeTypes ?? ['calls', 'imports', 'imports_from', 'contains', 'method'];
    const dir = direction ?? 'outbound';

    const visited = new Set();
    const resultNodes = [];
    const resultEdges = [];
    let frontier = [];

    for (const id of nodeIds) {
      const node = nodeMap.get(id);
      if (!node) continue;
      visited.add(id);
      resultNodes.push(node);
      frontier.push(id);
    }

    let depthReached = 0;

    for (let hop = 0; hop < maxHops; hop++) {
      const nextFrontier = [];
      for (const nodeId of frontier) {
        for (const link of links) {
          if (!types.includes(link.relation)) continue;
          let neighbor = null;
          if (dir === 'outbound' && link.source === nodeId) {
            neighbor = link.target;
          } else if (dir === 'inbound' && link.target === nodeId) {
            neighbor = link.source;
          }
          if (neighbor != null && !visited.has(neighbor)) {
            visited.add(neighbor);
            const neighborNode = nodeMap.get(neighbor);
            if (neighborNode) {
              resultNodes.push(neighborNode);
              resultEdges.push(link);
              nextFrontier.push(neighbor);
            }
          }
        }
      }
      if (nextFrontier.length === 0) break;
      frontier = nextFrontier;
      depthReached = hop + 1;
    }

    return { nodes: resultNodes, edges: resultEdges, depth_reached: depthReached };
  }

  return {
    getNode(id) {
      return nodeMap.get(id) ?? null;
    },

    getNodesByFile(filePath) {
      const normalized = normalizePath(filePath);
      return (graph.nodes ?? []).filter(
        (n) => normalizePath(n.source_file ?? '') === normalized,
      );
    },

    traverse,

    close() {
      // No-op: nothing to release for in-memory store.
    },
  };
}
```

- [ ] **Step 2: Run existing query-engine tests to confirm they still pass (no changes yet)**

```bash
cd tools/project-memory-context && node --test tests/query-engine.test.mjs
```

Expected: All tests PASS (no changes made yet — just confirming baseline).

- [ ] **Step 3: Commit**

```bash
git add tools/project-memory-context/src/graph-store/in-memory-graph.mjs
git commit -m "feat(graph-store): add InMemoryGraphStore — extracts BFS from query-engine"
```

---

## Task 2: Create SqliteGraphStore (`graph-db.mjs`)

**Files:**
- Create: `tools/project-memory-context/src/graph-store/graph-db.mjs`

- [ ] **Step 1: Create the file**

```js
// tools/project-memory-context/src/graph-store/graph-db.mjs
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// ── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
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
  metadata    TEXT
);
CREATE TABLE IF NOT EXISTS edges (
  source   TEXT NOT NULL,
  target   TEXT NOT NULL,
  relation TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source, relation);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target, relation);
CREATE INDEX IF NOT EXISTS idx_nodes_file   ON nodes(source_file);
`;

// ── Helpers ──────────────────────────────────────────────────────────────────

const CORE_FIELDS = new Set(['id', 'label', 'kind', 'source_file', 'community', 'degree']);

function toMetadataJson(node) {
  const extra = {};
  for (const [k, v] of Object.entries(node)) {
    if (!CORE_FIELDS.has(k)) extra[k] = v;
  }
  return JSON.stringify(extra);
}

function toGraphNode(row) {
  const base = {
    id: row.id,
    label: row.label,
    kind: row.kind,
    source_file: row.source_file,
    community: row.community,
    degree: row.degree,
  };
  try {
    const extra = JSON.parse(row.metadata ?? '{}');
    return { ...base, ...extra };
  } catch {
    return base;
  }
}

function expandParams(items) {
  return items.map(() => '?').join(', ');
}

export function hashGraphJson(graphJson) {
  return createHash('sha256').update(graphJson).digest('hex');
}

// ── Build ─────────────────────────────────────────────────────────────────────

/**
 * Rebuild the SQLite graph from a parsed graph object.
 * Runs inside a single transaction — idempotent (DELETE + INSERT).
 *
 * @param {DatabaseSync} db
 * @param {{ nodes?: object[], links?: object[] }} graph
 * @param {string} contentHash — SHA-256 hex of the source graph.json
 */
export function buildFromGraphJson(db, graph, contentHash) {
  const insertNode = db.prepare(
    `INSERT OR REPLACE INTO nodes (id, label, kind, source_file, community, degree, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertEdge = db.prepare(
    `INSERT INTO edges (source, target, relation) VALUES (?, ?, ?)`,
  );
  const upsertMeta = db.prepare(
    `INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`,
  );

  const build = db.transaction(() => {
    db.exec('DELETE FROM nodes; DELETE FROM edges;');

    for (const node of graph.nodes ?? []) {
      insertNode.run(
        node.id,
        node.label ?? null,
        node.kind ?? null,
        node.source_file ?? null,
        node.community ?? null,
        node.degree ?? null,
        toMetadataJson(node),
      );
    }

    for (const link of graph.links ?? []) {
      insertEdge.run(link.source, link.target, link.relation);
    }

    upsertMeta.run('content_hash', contentHash);
    upsertMeta.run('built_at', new Date().toISOString());
  });

  build();
}

// ── Store ─────────────────────────────────────────────────────────────────────

/**
 * Create a SqliteGraphStore from an already-opened DatabaseSync.
 * Useful in tests to inject a pre-built db without hitting disk for graph.json.
 *
 * @param {DatabaseSync} db
 * @returns {GraphStore}
 */
export function createSqliteGraphStore(db) {
  function traverse({ nodeIds, maxHops, edgeTypes, direction }) {
    const types = edgeTypes ?? ['calls', 'imports', 'imports_from', 'contains', 'method'];
    const dir = direction ?? 'outbound';

    const visited = new Set(nodeIds);
    const resultNodes = [];
    const resultEdges = [];

    // Collect seed nodes
    for (const id of nodeIds) {
      const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
      if (row) resultNodes.push(toGraphNode(row));
    }

    let frontier = [...nodeIds].filter((id) => resultNodes.some((n) => n.id === id));
    let depthReached = 0;

    for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
      const nextFrontier = [];
      const edgeIn = expandParams(types);
      const frontierIn = expandParams(frontier);

      const rows = dir === 'outbound'
        ? db.prepare(
            `SELECT * FROM edges WHERE source IN (${frontierIn}) AND relation IN (${edgeIn})`,
          ).all(...frontier, ...types)
        : db.prepare(
            `SELECT * FROM edges WHERE target IN (${frontierIn}) AND relation IN (${edgeIn})`,
          ).all(...frontier, ...types);

      for (const edge of rows) {
        const neighborId = dir === 'outbound' ? edge.target : edge.source;
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          const neighborRow = db.prepare('SELECT * FROM nodes WHERE id = ?').get(neighborId);
          if (neighborRow) {
            resultNodes.push(toGraphNode(neighborRow));
            resultEdges.push({ source: edge.source, target: edge.target, relation: edge.relation });
            nextFrontier.push(neighborId);
          }
        }
      }

      if (nextFrontier.length === 0) break;
      frontier = nextFrontier;
      depthReached = hop + 1;
    }

    return { nodes: resultNodes, edges: resultEdges, depth_reached: depthReached };
  }

  return {
    getNode(id) {
      const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
      return row ? toGraphNode(row) : null;
    },

    getNodesByFile(filePath) {
      const normalized = filePath.replace(/\\/g, '/');
      const rows = db.prepare('SELECT * FROM nodes WHERE source_file = ?').all(normalized);
      return rows.map(toGraphNode);
    },

    traverse,

    close() {
      db.close();
    },
  };
}

// ── Open ──────────────────────────────────────────────────────────────────────

/**
 * Open (or create) graph.db at `dbPath`. If the stored content_hash does not
 * match the hash of `graphJsonPath`, the DB is rebuilt from the JSON file.
 *
 * @param {string} dbPath   — absolute path to graph.db
 * @param {string} graphJsonPath — absolute path to graph.json
 * @returns {GraphStore}
 */
export function openGraphDb(dbPath, graphJsonPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);

  const graphJson = readFileSync(graphJsonPath, 'utf8');
  const currentHash = hashGraphJson(graphJson);
  const stored = db.prepare(`SELECT value FROM meta WHERE key = 'content_hash'`).get();
  const storedHash = stored?.value ?? null;

  if (storedHash !== currentHash) {
    const graph = JSON.parse(graphJson);
    buildFromGraphJson(db, graph, currentHash);
  }

  return createSqliteGraphStore(db);
}
```

- [ ] **Step 2: Commit**

```bash
git add tools/project-memory-context/src/graph-store/graph-db.mjs
git commit -m "feat(graph-store): add SqliteGraphStore with WAL, indexed traversal, hash invalidation"
```

---

## Task 3: Unit tests for `graph-db.mjs`

**Files:**
- Create: `tools/project-memory-context/tests/graph-db.test.mjs`

- [ ] **Step 1: Write all failing tests**

```js
// tools/project-memory-context/tests/graph-db.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  buildFromGraphJson,
  createSqliteGraphStore,
  hashGraphJson,
  openGraphDb,
} from '../src/graph-store/graph-db.mjs';

// ── Fixture ───────────────────────────────────────────────────────────────────
//
//   a --calls--> b --calls--> c --calls--> d
//               b --imports-> e
//
const FIXTURE = {
  nodes: [
    { id: 'a', label: 'A', source_file: 'src/a.ts', kind: 'function', community: 1, degree: 1 },
    { id: 'b', label: 'B', source_file: 'src/b.ts', kind: 'function', community: 1, degree: 3 },
    { id: 'c', label: 'C', source_file: 'src/c.ts', kind: 'class',    community: 2, degree: 1 },
    { id: 'd', label: 'D', source_file: 'src/d.ts', kind: 'class',    community: 2, degree: 1 },
    { id: 'e', label: 'E', source_file: 'src/e.ts', kind: 'function', community: 3, degree: 1 },
  ],
  links: [
    { source: 'a', target: 'b', relation: 'calls' },
    { source: 'b', target: 'c', relation: 'calls' },
    { source: 'c', target: 'd', relation: 'calls' },
    { source: 'b', target: 'e', relation: 'imports' },
  ],
};

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, label TEXT, kind TEXT, source_file TEXT, community INTEGER, degree INTEGER, metadata TEXT);
    CREATE TABLE edges (source TEXT NOT NULL, target TEXT NOT NULL, relation TEXT NOT NULL);
    CREATE INDEX idx_edges_source ON edges(source, relation);
    CREATE INDEX idx_edges_target ON edges(target, relation);
    CREATE INDEX idx_nodes_file ON nodes(source_file);
  `);
  return db;
}

function makeStore() {
  const db = makeDb();
  buildFromGraphJson(db, FIXTURE, 'test-hash-123');
  return createSqliteGraphStore(db);
}

// ── Build ─────────────────────────────────────────────────────────────────────

test('buildFromGraphJson inserts all nodes', () => {
  const db = makeDb();
  buildFromGraphJson(db, FIXTURE, 'hash-abc');
  const rows = db.prepare('SELECT id FROM nodes').all();
  assert.equal(rows.length, 5);
  assert.ok(rows.some((r) => r.id === 'a'));
  assert.ok(rows.some((r) => r.id === 'e'));
});

test('buildFromGraphJson inserts all edges', () => {
  const db = makeDb();
  buildFromGraphJson(db, FIXTURE, 'hash-abc');
  const rows = db.prepare('SELECT * FROM edges').all();
  assert.equal(rows.length, 4);
});

test('buildFromGraphJson stores content_hash in meta', () => {
  const db = makeDb();
  buildFromGraphJson(db, FIXTURE, 'my-hash-xyz');
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'content_hash'`).get();
  assert.equal(row?.value, 'my-hash-xyz');
});

test('buildFromGraphJson stores built_at in meta', () => {
  const db = makeDb();
  buildFromGraphJson(db, FIXTURE, 'h');
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'built_at'`).get();
  assert.ok(row?.value, 'built_at should be present');
  assert.ok(!isNaN(Date.parse(row.value)), 'built_at should be a valid ISO date');
});

test('buildFromGraphJson is idempotent — calling twice yields same row count', () => {
  const db = makeDb();
  buildFromGraphJson(db, FIXTURE, 'h1');
  buildFromGraphJson(db, FIXTURE, 'h2');
  const nodeCount = db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n;
  assert.equal(nodeCount, 5);
  const edgeCount = db.prepare('SELECT COUNT(*) AS n FROM edges').get().n;
  assert.equal(edgeCount, 4);
});

// ── getNode ───────────────────────────────────────────────────────────────────

test('getNode returns node with all fields for known id', () => {
  const store = makeStore();
  const node = store.getNode('a');
  assert.ok(node, 'node should exist');
  assert.equal(node.id, 'a');
  assert.equal(node.label, 'A');
  assert.equal(node.source_file, 'src/a.ts');
});

test('getNode returns null for unknown id', () => {
  const store = makeStore();
  assert.equal(store.getNode('nonexistent'), null);
});

// ── getNodesByFile ────────────────────────────────────────────────────────────

test('getNodesByFile returns all nodes in a file', () => {
  const store = makeStore();
  const nodes = store.getNodesByFile('src/b.ts');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].id, 'b');
});

test('getNodesByFile returns empty array for unknown file', () => {
  const store = makeStore();
  assert.deepEqual(store.getNodesByFile('src/missing.ts'), []);
});

test('getNodesByFile normalises backslashes on Windows paths', () => {
  const store = makeStore();
  const nodes = store.getNodesByFile('src\\b.ts');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].id, 'b');
});

// ── traverse: outbound ────────────────────────────────────────────────────────

test('traverse outbound maxHops=1 returns immediate neighbors', () => {
  const store = makeStore();
  const result = store.traverse({ nodeIds: ['a'], maxHops: 1, edgeTypes: ['calls', 'imports'] });
  const ids = result.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['a', 'b']);
  assert.equal(result.depth_reached, 1);
});

test('traverse outbound maxHops=2 reaches two hops', () => {
  const store = makeStore();
  const result = store.traverse({ nodeIds: ['a'], maxHops: 2, edgeTypes: ['calls', 'imports'] });
  const ids = result.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['a', 'b', 'c', 'e']);
  assert.equal(result.depth_reached, 2);
});

test('traverse outbound maxHops=3 reaches three hops', () => {
  const store = makeStore();
  const result = store.traverse({ nodeIds: ['a'], maxHops: 3, edgeTypes: ['calls', 'imports'] });
  const ids = result.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(result.depth_reached, 3);
});

// ── traverse: edge-type filter ────────────────────────────────────────────────

test('traverse filters by edgeTypes — only calls', () => {
  const store = makeStore();
  // a->b (calls), b->e (imports); with only 'calls', e should not appear in 2 hops
  const result = store.traverse({ nodeIds: ['a'], maxHops: 2, edgeTypes: ['calls'] });
  const ids = result.nodes.map((n) => n.id).sort();
  assert.ok(ids.includes('b'), 'b should be reached via calls');
  assert.ok(ids.includes('c'), 'c should be reached via calls');
  assert.ok(!ids.includes('e'), 'e should NOT be reached — only imports link');
});

test('traverse filters by edgeTypes — only imports', () => {
  const store = makeStore();
  const result = store.traverse({ nodeIds: ['a'], maxHops: 2, edgeTypes: ['imports'] });
  const ids = result.nodes.map((n) => n.id).sort();
  // a has no imports edge, so nothing should be reachable
  assert.deepEqual(ids, ['a']);
});

// ── traverse: inbound ─────────────────────────────────────────────────────────

test('traverse inbound from d returns callers up the chain', () => {
  const store = makeStore();
  const result = store.traverse({ nodeIds: ['d'], maxHops: 1, edgeTypes: ['calls'], direction: 'inbound' });
  const ids = result.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['c', 'd']);
});

test('traverse inbound maxHops=2 from d reaches c and b', () => {
  const store = makeStore();
  const result = store.traverse({ nodeIds: ['d'], maxHops: 2, edgeTypes: ['calls'], direction: 'inbound' });
  const ids = result.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ['b', 'c', 'd']);
});

// ── traverse: empty / missing ────────────────────────────────────────────────

test('traverse from unknown node returns no nodes', () => {
  const store = makeStore();
  const result = store.traverse({ nodeIds: ['zzz'], maxHops: 3 });
  assert.deepEqual(result.nodes, []);
  assert.equal(result.depth_reached, 0);
});

test('traverse from empty nodeIds returns empty result', () => {
  const store = makeStore();
  const result = store.traverse({ nodeIds: [], maxHops: 3 });
  assert.deepEqual(result.nodes, []);
});

// ── openGraphDb: hash invalidation ────────────────────────────────────────────

test('openGraphDb builds DB when no DB exists', () => {
  const dir = tmpdir();
  const dbPath = join(dir, `pmc-test-${Date.now()}.db`);
  const jsonPath = join(dir, `pmc-test-${Date.now()}.json`);

  try {
    const graphJson = JSON.stringify(FIXTURE);
    writeFileSync(jsonPath, graphJson, 'utf8');
    const store = openGraphDb(dbPath, jsonPath);
    const node = store.getNode('a');
    assert.ok(node, 'node a should be found after build');
    assert.equal(node.label, 'A');
    store.close();
  } finally {
    if (existsSync(dbPath)) rmSync(dbPath);
    if (existsSync(jsonPath)) rmSync(jsonPath);
  }
});

test('openGraphDb skips rebuild when content_hash matches', () => {
  const dir = tmpdir();
  const dbPath = join(dir, `pmc-test-${Date.now()}.db`);
  const jsonPath = join(dir, `pmc-test-${Date.now()}.json`);

  try {
    const graphJson = JSON.stringify(FIXTURE);
    writeFileSync(jsonPath, graphJson, 'utf8');

    openGraphDb(dbPath, jsonPath).close(); // first open — builds

    // Record built_at from first build
    const db = new DatabaseSync(dbPath);
    const firstBuiltAt = db.prepare(`SELECT value FROM meta WHERE key = 'built_at'`).get()?.value;
    db.close();

    // Small delay to ensure built_at would differ if rebuilt
    // Re-open with same file — should NOT rebuild
    openGraphDb(dbPath, jsonPath).close();

    const db2 = new DatabaseSync(dbPath);
    const secondBuiltAt = db2.prepare(`SELECT value FROM meta WHERE key = 'built_at'`).get()?.value;
    db2.close();

    assert.equal(firstBuiltAt, secondBuiltAt, 'built_at should be unchanged — rebuild was skipped');
  } finally {
    if (existsSync(dbPath)) rmSync(dbPath);
    if (existsSync(jsonPath)) rmSync(jsonPath);
  }
});

test('openGraphDb rebuilds when graph.json content changes', () => {
  const dir = tmpdir();
  const dbPath = join(dir, `pmc-test-${Date.now()}.db`);
  const jsonPath = join(dir, `pmc-test-${Date.now()}.json`);

  try {
    writeFileSync(jsonPath, JSON.stringify(FIXTURE), 'utf8');
    openGraphDb(dbPath, jsonPath).close();

    // Modify graph to add a new node
    const modified = {
      ...FIXTURE,
      nodes: [...FIXTURE.nodes, { id: 'f', label: 'F', source_file: 'src/f.ts', kind: 'class' }],
    };
    writeFileSync(jsonPath, JSON.stringify(modified), 'utf8');

    const store = openGraphDb(dbPath, jsonPath);
    const node = store.getNode('f');
    assert.ok(node, 'new node f should be present after rebuild');
    store.close();
  } finally {
    if (existsSync(dbPath)) rmSync(dbPath);
    if (existsSync(jsonPath)) rmSync(jsonPath);
  }
});

// ── WAL mode ──────────────────────────────────────────────────────────────────

test('graph.db is opened in WAL mode', () => {
  const db = makeDb();
  const row = db.prepare(`PRAGMA journal_mode`).get();
  assert.equal(row?.journal_mode ?? row?.['journal_mode'], 'wal');
});

// ── hashGraphJson ─────────────────────────────────────────────────────────────

test('hashGraphJson produces a 64-char hex string', () => {
  const hash = hashGraphJson('{"nodes":[],"links":[]}');
  assert.equal(typeof hash, 'string');
  assert.equal(hash.length, 64);
  assert.match(hash, /^[0-9a-f]+$/);
});

test('hashGraphJson is deterministic', () => {
  const json = JSON.stringify(FIXTURE);
  assert.equal(hashGraphJson(json), hashGraphJson(json));
});

test('hashGraphJson differs for different content', () => {
  assert.notEqual(
    hashGraphJson('{"nodes":[],"links":[]}'),
    hashGraphJson('{"nodes":[{"id":"x"}],"links":[]}'),
  );
});
```

- [ ] **Step 2: Run tests — expect PASS (implementation already written in Task 2)**

```bash
cd tools/project-memory-context && node --test tests/graph-db.test.mjs
```

Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add tools/project-memory-context/tests/graph-db.test.mjs
git commit -m "test(graph-store): unit tests for graph-db — build, traverse, invalidation, WAL"
```

---

## Task 4: Update `query-engine.mjs` to accept `graphStore`

**Files:**
- Modify: `tools/project-memory-context/src/retrieval/query-engine.mjs`

The existing tests all pass `graph: {...}`. After this change they continue passing
because `graph` auto-wraps in `InMemoryGraphStore`. New callers pass `graphStore` directly.

- [ ] **Step 1: Write the failing parity test first (tests new import path)**

Create `tools/project-memory-context/tests/graph-store-parity.test.mjs`:

```js
// tools/project-memory-context/tests/graph-store-parity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildFromGraphJson, createSqliteGraphStore } from '../src/graph-store/graph-db.mjs';
import { createInMemoryGraphStore } from '../src/graph-store/in-memory-graph.mjs';
import { createQueryEngine } from '../src/retrieval/query-engine.mjs';

const GRAPH = {
  nodes: [
    { id: 'n1', label: 'User',    source_file: 'src/user.ts',    kind: 'class' },
    { id: 'n2', label: 'getUser', source_file: 'src/user.ts',    kind: 'function' },
    { id: 'n3', label: 'Post',    source_file: 'src/post.ts',    kind: 'class' },
    { id: 'n4', label: 'DB',      source_file: 'src/db.ts',      kind: 'class' },
    { id: 'n5', label: 'Logger',  source_file: 'src/logger.ts',  kind: 'class' },
  ],
  links: [
    { source: 'n1', target: 'n2', relation: 'contains' },
    { source: 'n2', target: 'n4', relation: 'calls' },
    { source: 'n3', target: 'n4', relation: 'calls' },
    { source: 'n4', target: 'n5', relation: 'imports' },
  ],
};

function makeSqliteStore(graph) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, label TEXT, kind TEXT, source_file TEXT, community INTEGER, degree INTEGER, metadata TEXT);
    CREATE TABLE edges (source TEXT NOT NULL, target TEXT NOT NULL, relation TEXT NOT NULL);
    CREATE INDEX idx_edges_source ON edges(source, relation);
    CREATE INDEX idx_edges_target ON edges(target, relation);
    CREATE INDEX idx_nodes_file ON nodes(source_file);
  `);
  buildFromGraphJson(db, graph, 'test');
  return createSqliteGraphStore(db);
}

function nodeIds(result) {
  return result.nodes.map((n) => n.id).sort();
}

// ── createQueryEngine backward-compat ────────────────────────────────────────

test('createQueryEngine accepts old graph param and wraps in InMemoryGraphStore', () => {
  // This should not throw — backward compat
  const engine = createQueryEngine({
    graph: GRAPH,
    symbolIndex: {},
    worklist: [],
  });
  const result = engine.traverseGraph({ nodeIds: ['n1'], maxHops: 1 });
  assert.ok(result.nodes.length >= 1);
});

test('createQueryEngine accepts new graphStore param', () => {
  const graphStore = createInMemoryGraphStore(GRAPH);
  const engine = createQueryEngine({
    graphStore,
    symbolIndex: {},
    worklist: [],
  });
  const result = engine.traverseGraph({ nodeIds: ['n1'], maxHops: 1 });
  assert.ok(result.nodes.length >= 1);
});

// ── Parity: traversal ────────────────────────────────────────────────────────

function parityTest(label, fn) {
  test(`parity — ${label}`, () => {
    const inmem = createQueryEngine({ graph: GRAPH, symbolIndex: {}, worklist: [] });
    const sqlite = createQueryEngine({
      graphStore: makeSqliteStore(GRAPH),
      symbolIndex: {},
      worklist: [],
    });
    const inmemResult = fn(inmem);
    const sqliteResult = fn(sqlite);
    assert.deepEqual(
      nodeIds(inmemResult),
      nodeIds(sqliteResult),
      `node sets should match for: ${label}`,
    );
    assert.equal(
      inmemResult.edges.length,
      sqliteResult.edges.length,
      `edge counts should match for: ${label}`,
    );
  });
}

parityTest('traverse outbound 1 hop', (e) =>
  e.traverseGraph({ nodeIds: ['n1'], maxHops: 1 }));

parityTest('traverse outbound 2 hops', (e) =>
  e.traverseGraph({ nodeIds: ['n1'], maxHops: 2 }));

parityTest('traverse outbound 3 hops — all edges', (e) =>
  e.traverseGraph({ nodeIds: ['n1'], maxHops: 3 }));

parityTest('traverse inbound from n4', (e) =>
  e.traverseGraph({ nodeIds: ['n4'], maxHops: 2, direction: 'inbound' }));

parityTest('traverse filter calls only', (e) =>
  e.traverseGraph({ nodeIds: ['n2'], maxHops: 3, edgeTypes: ['calls'] }));

parityTest('traverse filter imports only', (e) =>
  e.traverseGraph({ nodeIds: ['n4'], maxHops: 2, edgeTypes: ['imports'] }));

parityTest('queryFileContext src/user.ts', (e) =>
  e.queryFileContext({ filePath: 'src/user.ts', depth: 'compact' }));

parityTest('queryFileContext src/post.ts deep', (e) =>
  e.queryFileContext({ filePath: 'src/post.ts', depth: 'deep' }));
```

- [ ] **Step 2: Run parity test — expect FAIL (graphStore param not yet supported)**

```bash
cd tools/project-memory-context && node --test tests/graph-store-parity.test.mjs
```

Expected: FAIL — `createQueryEngine` doesn't accept `graphStore` yet.

- [ ] **Step 3: Update `query-engine.mjs`**

Replace the opening of `createQueryEngine` (the first ~85 lines of `src/retrieval/query-engine.mjs`):

```js
// src/retrieval/query-engine.mjs
import { createInMemoryGraphStore } from '../graph-store/in-memory-graph.mjs';

const DEPTH_PRESETS = {
  compact: { maxHops: 1, includeCommunity: false, maxTokens: 2000,  readSourceFiles: false },
  extended: { maxHops: 2, includeCommunity: true,  maxTokens: 5000,  readSourceFiles: false },
  deep:     { maxHops: 3, includeCommunity: true,  maxTokens: 10000, readSourceFiles: false },
  disk:     { maxHops: 3, includeCommunity: true,  maxTokens: 15000, readSourceFiles: true  },
};

export function createDepthConfig(depth) {
  const preset = DEPTH_PRESETS[depth] ?? DEPTH_PRESETS.compact;
  return { ...preset };
}

function parseSymbolKeyParts(key) { return key.split('|'); }
function extractName(parts)      { return parts.length >= 5 ? parts[parts.length - 2] : null; }
function extractFilePath(parts)  { return parts.length >= 2 ? parts[1] : null; }
function normalizePath(filePath) { return String(filePath ?? '').replace(/\\/g, '/'); }

export function focusToEdgeTypes(focus) {
  const map = {
    dependencies: ['imports', 'imports_from'],
    callers:      ['calls'],
    containment:  ['contains', 'method'],
  };
  return map[focus] ?? ['calls', 'imports', 'imports_from', 'contains', 'method'];
}

export function createQueryEngine({ graphStore, graph, symbolIndex, worklist, enrichmentDir, projectSlug }) {
  // Backward-compat: if old `graph` object passed, auto-wrap in InMemoryGraphStore.
  const store = graphStore ?? createInMemoryGraphStore(graph ?? { nodes: [], links: [] });

  // ── Symbol index maps (built from symbolIndex — unchanged from v1) ──────────
  const graphNodeIdToSymbolKeyMap = new Map();
  const nameToSymbolKeys          = new Map();
  const filePathToSymbolKeys      = new Map();

  for (const key of Object.keys(symbolIndex ?? {})) {
    const entry = symbolIndex[key];
    if (entry.graphNodeId) graphNodeIdToSymbolKeyMap.set(entry.graphNodeId, key);

    const parts = parseSymbolKeyParts(key);
    const name = extractName(parts);
    if (name) {
      const arr = nameToSymbolKeys.get(name);
      if (arr) arr.push(key); else nameToSymbolKeys.set(name, [key]);
    }

    const fp = extractFilePath(parts);
    if (fp) {
      const normalized = normalizePath(fp);
      const arr = filePathToSymbolKeys.get(normalized);
      if (arr) arr.push(key); else filePathToSymbolKeys.set(normalized, [key]);
    }
  }

  // ── Traversal (delegates to store) ─────────────────────────────────────────
  function traverseGraph({ nodeIds, maxHops, edgeTypes, direction }) {
    const types = edgeTypes ?? ['calls', 'imports', 'imports_from', 'contains', 'method'];
    const dir = direction ?? 'outbound';
    return store.traverse({ nodeIds, maxHops, edgeTypes: types, direction: dir });
  }

  function resolveWorklistEntry(symbolKey) {
    return (worklist ?? []).find((e) => e.symbolKey === symbolKey) ?? null;
  }

  function buildSymbolInfo(symbolKey) {
    const entry = (symbolIndex ?? {})[symbolKey];
    const wl    = resolveWorklistEntry(symbolKey);
    const parts = parseSymbolKeyParts(symbolKey);
    return {
      symbolKey,
      name:        wl?.name      ?? extractName(parts),
      filePath:    wl?.filePath  ?? extractFilePath(parts),
      kind:        wl?.kind      ?? null,
      range:       wl?.range     ?? null,
      codeHash:    wl?.codeHash  ?? null,
      graphNodeId: entry?.graphNodeId ?? null,
      memoryId:    entry?.memoryId    ?? null,
      status:      entry?.status      ?? null,
    };
  }

  function querySymbolContext({ symbolKey, depth }) {
    const config = createDepthConfig(depth);
    const target = buildSymbolInfo(symbolKey);
    if (!target.graphNodeId) return { target, neighbors: [], edges: [], depth_reached: 0 };

    const traversal = traverseGraph({ nodeIds: [target.graphNodeId], maxHops: config.maxHops });
    const neighbors = traversal.nodes
      .filter((n) => n.id !== target.graphNodeId)
      .map((n) => {
        const sk = graphNodeIdToSymbolKeyMap.get(n.id);
        if (sk) return buildSymbolInfo(sk);
        return { graphNodeId: n.id, label: n.label, sourceFile: n.source_file ?? null, symbolKey: null };
      });
    return { target, neighbors, edges: traversal.edges, depth_reached: traversal.depth_reached };
  }

  function queryFileContext({ filePath, depth }) {
    const config     = createDepthConfig(depth);
    const normalized = normalizePath(filePath);
    const symbolKeys = filePathToSymbolKeys.get(normalized) ?? [];
    const symbols    = symbolKeys.map(buildSymbolInfo);
    const fileNodeIds = store.getNodesByFile(normalized).map((n) => n.id);

    const outTraversal = traverseGraph({ nodeIds: fileNodeIds, maxHops: config.maxHops });
    const inTraversal  = traverseGraph({ nodeIds: fileNodeIds, maxHops: config.maxHops, direction: 'inbound' });

    const fileNodeIdSet = new Set(fileNodeIds);
    const seen = new Set();
    const neighbors = [];
    const edges = [];

    for (const n of [...outTraversal.nodes, ...inTraversal.nodes]) {
      if (fileNodeIdSet.has(n.id) || seen.has(n.id)) continue;
      seen.add(n.id);
      const sk = graphNodeIdToSymbolKeyMap.get(n.id);
      neighbors.push(sk
        ? buildSymbolInfo(sk)
        : { graphNodeId: n.id, label: n.label, sourceFile: n.source_file ?? null, symbolKey: null });
    }

    const edgeSet = new Set();
    for (const e of [...outTraversal.edges, ...inTraversal.edges]) {
      const key = `${e.source}->${e.target}`;
      if (!edgeSet.has(key)) { edgeSet.add(key); edges.push(e); }
    }

    const depth_reached = Math.max(outTraversal.depth_reached, inTraversal.depth_reached);
    return { symbols, neighbors, edges, depth_reached };
  }

  function queryImpactScope({ symbolKeys, depth }) {
    const config  = createDepthConfig(depth);
    const targets = symbolKeys.map(buildSymbolInfo);
    const nodeIds = targets.map((t) => t.graphNodeId).filter(Boolean);
    const traversal = traverseGraph({ nodeIds, maxHops: config.maxHops, direction: 'inbound' });
    const targetIdSet = new Set(nodeIds);
    const dependents  = traversal.nodes
      .filter((n) => !targetIdSet.has(n.id))
      .map((n) => {
        const sk = graphNodeIdToSymbolKeyMap.get(n.id);
        if (sk) return buildSymbolInfo(sk);
        return { graphNodeId: n.id, label: n.label, sourceFile: n.source_file ?? null, symbolKey: null };
      });
    return {
      target:       targets.length === 1 ? targets[0] : targets,
      dependents,
      edges:        traversal.edges,
      depth_reached: traversal.depth_reached,
    };
  }

  return {
    graphNodeIdToSymbolKey(graphNodeId) { return graphNodeIdToSymbolKeyMap.get(graphNodeId) ?? null; },
    findSymbolKeyByName(name)           { return nameToSymbolKeys.get(name) ?? []; },
    findSymbolKeysByFilePath(filePath)  { return filePathToSymbolKeys.get(normalizePath(filePath)) ?? []; },
    traverseGraph,
    querySymbolContext,
    queryFileContext,
    queryImpactScope,
  };
}
```

- [ ] **Step 4: Run ALL query-engine and parity tests — expect PASS**

```bash
cd tools/project-memory-context && node --test tests/query-engine.test.mjs tests/graph-store-parity.test.mjs
```

Expected: All tests PASS (old tests use `graph` param; new tests use `graphStore`).

- [ ] **Step 5: Commit**

```bash
git add tools/project-memory-context/src/retrieval/query-engine.mjs \
        tools/project-memory-context/src/graph-store/in-memory-graph.mjs \
        tools/project-memory-context/tests/graph-store-parity.test.mjs
git commit -m "feat(query-engine): accept graphStore param; backward-compat graph→InMemoryGraphStore"
```

---

## Task 5: Update `cli/context.mjs` — lazy `openGraphDb` in `loadArtifacts`

**Files:**
- Modify: `tools/project-memory-context/cli/context.mjs`

- [ ] **Step 1: Add import and update `loadArtifacts`**

At the top of `cli/context.mjs`, add:
```js
import { openGraphDb } from '../src/graph-store/graph-db.mjs';
```

Replace the `loadArtifacts` function body (currently around lines 105-117):

```js
export async function loadArtifacts(projectRoot) {
  const pmcRoot = join(projectRoot, '.planning', 'project-memory-context');
  try {
    const [graphStore, symbolIndex, worklist] = await Promise.all([
      openGraphDbLazy(pmcRoot),
      readJsonArtifact(join(pmcRoot, 'enrichment', 'symbol-index.json'), {}),
      readJsonArtifact(join(pmcRoot, 'enrichment', 'worklist.json'), []),
    ]);
    return { graphStore, symbolIndex, worklist };
  } catch (error) {
    throw new Error(`Failed to load PMC artifacts from ${pmcRoot}: ${error.message}`);
  }
}

async function openGraphDbLazy(pmcRoot) {
  const dbPath   = join(pmcRoot, 'graph', 'graph.db');
  const jsonPath = join(pmcRoot, 'graph', 'graph.json');
  // If graph.json doesn't exist yet, fall back to an empty InMemoryGraphStore
  if (!existsSync(jsonPath)) {
    const { createInMemoryGraphStore } = await import('../src/graph-store/in-memory-graph.mjs');
    return createInMemoryGraphStore({ nodes: [], links: [] });
  }
  return openGraphDb(dbPath, jsonPath);
}
```

Also update `runTargetContext` — it calls `createQueryEngine`. Change:
```js
// Before (in runTargetContext around line 219)
const engine = createQueryEngine({
  graph: artfs.graph,
  symbolIndex: artfs.symbolIndex,
  ...
});

// After
const engine = createQueryEngine({
  graphStore: artfs.graphStore,
  symbolIndex: artfs.symbolIndex,
  ...
});
```

- [ ] **Step 2: Run context-cli tests**

```bash
cd tools/project-memory-context && node --test tests/context-cli.test.mjs
```

Expected: All tests PASS.

- [ ] **Step 3: Smoke test end-to-end (requires a PMC-bootstrapped project)**

```bash
pmc get-context createQueryEngine
```

Expected: Output lists neighbors of `createQueryEngine` — same as before.

- [ ] **Step 4: Commit**

```bash
git add tools/project-memory-context/cli/context.mjs
git commit -m "feat(cli): loadArtifacts opens graph.db (lazy build from graph.json)"
```

---

## Task 6: Update `cli/bootstrap.mjs` — build `graph.db` after graphify

**Files:**
- Modify: `tools/project-memory-context/cli/bootstrap.mjs`

- [ ] **Step 1: Add import**

At the top of `cli/bootstrap.mjs`, add:
```js
import { openGraphDb } from '../src/graph-store/graph-db.mjs';
import { join } from 'node:path';
```

(`join` may already be imported — check and only add if missing.)

- [ ] **Step 2: Call `openGraphDb` after `runGraphifyUpdate` succeeds**

Find the block in `bootstrap.mjs` around line 89:
```js
const { ran } = await runGraphifyUpdate(projectRoot, { log: (msg) => log(msg) });
```

After that call (inside the block where `ran` is truthy or unconditionally), add:

```js
// Build / refresh graph.db from the updated graph.json
const graphJsonPath = join(projectRoot, '.planning', 'project-memory-context', 'graph', 'graph.json');
const graphDbPath   = join(projectRoot, '.planning', 'project-memory-context', 'graph', 'graph.db');
try {
  const { existsSync } = await import('node:fs');
  if (existsSync(graphJsonPath)) {
    log('Building graph.db from graph.json...');
    const store = openGraphDb(graphDbPath, graphJsonPath);
    store.close();
    log('graph.db built ✓');
  }
} catch (err) {
  log(`graph.db build failed (non-fatal): ${err.message}`);
}
```

- [ ] **Step 3: Run bootstrap tests**

```bash
cd tools/project-memory-context && node --test tests/setup-bootstrap.test.mjs
```

Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add tools/project-memory-context/cli/bootstrap.mjs
git commit -m "feat(bootstrap): build graph.db from graph.json after graphify"
```

---

## Task 7: Update `cli/refresh-context.mjs` — rebuild `graph.db` on graph refresh

**Files:**
- Modify: `tools/project-memory-context/cli/refresh-context.mjs`

- [ ] **Step 1: Add import**

At the top of `cli/refresh-context.mjs`, add:
```js
import { openGraphDb } from '../src/graph-store/graph-db.mjs';
```

- [ ] **Step 2: Rebuild `graph.db` after `runGraphifyUpdate`**

Find the line (around line 53):
```js
await runGraphifyUpdate(projectRoot, { log });
```

Immediately after it, add:
```js
// Rebuild graph.db so get-context queries use the updated graph.
const graphJsonPath = resolve(dirs.graph, 'graph.json');
const graphDbPath   = resolve(dirs.graph, 'graph.db');
try {
  if (existsSync(graphJsonPath)) {
    const store = openGraphDb(graphDbPath, graphJsonPath);
    store.close();
    log('graph.db refreshed ✓');
  }
} catch (err) {
  log(`graph.db rebuild failed (non-fatal): ${err.message}`);
}
```

(`existsSync` is already imported from `node:fs` in this file — check and add if missing.)

- [ ] **Step 3: Run refresh-context tests**

```bash
cd tools/project-memory-context && node --test tests/refresh-context.test.mjs tests/refresh-context-edge-cases.test.mjs
```

Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add tools/project-memory-context/cli/refresh-context.mjs
git commit -m "feat(refresh-context): rebuild graph.db after graphify update"
```

---

## Task 8: Update `src/doctor.mjs` — add `node-sqlite` check

**Files:**
- Modify: `tools/project-memory-context/src/doctor.mjs`
- Modify: `tools/project-memory-context/tests/doctor.test.mjs`

- [ ] **Step 1: Add failing test**

In `tests/doctor.test.mjs`, update the count assertion and add a new check test:

```js
// Replace the existing "returns 7 checks" test:
test('returns 8 checks', async () => {
  const { checks } = await runDoctor({ env: {}, fetchImpl: noFetch });
  assert.equal(checks.length, 8);
});

// Add after the existing node-version test:
test('node-sqlite check passes on Node >= 24', async () => {
  const { checks } = await runDoctor({ env: {}, fetchImpl: noFetch });
  const c = checks.find(c => c.name === 'node-sqlite');
  assert.ok(c, 'node-sqlite check should exist');
  // Node 24 is installed, so this should be ok (not warn, not fail)
  assert.equal(c?.status, 'ok');
  assert.ok(c?.message.includes('node:sqlite'));
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd tools/project-memory-context && node --test tests/doctor.test.mjs
```

Expected: FAIL — "expected 7 to equal 8", "node-sqlite check should exist".

- [ ] **Step 3: Add `checkNodeSqlite` to `src/doctor.mjs`**

Add the new check function after `checkNodeVersion`:

```js
async function checkNodeSqlite() {
  const versionParts = process.version.slice(1).split('.').map(Number);
  const [major, minor] = versionParts;

  if (major >= 24) {
    return {
      name: 'node-sqlite',
      status: 'ok',
      message: `node:sqlite available (Node.js ${process.version}) ✓`,
    };
  }
  if (major === 22 && minor >= 5 || major === 23) {
    return {
      name: 'node-sqlite',
      status: 'warn',
      message: `node:sqlite requires --experimental-sqlite flag on Node.js ${process.version} — upgrade to Node.js 24 for stable access`,
    };
  }
  return {
    name: 'node-sqlite',
    status: 'fail',
    message: `node:sqlite unavailable on Node.js ${process.version} — graph store requires Node.js ≥ 22.5 (Node.js 24 recommended)`,
  };
}
```

Update `runDoctor` to include the new check:

```js
export async function runDoctor({
  env = process.env,
  fetchImpl = globalThis.fetch,
  resolvePythonBin = () => null,
  resolveGraphify = () => null,
  spawnCheck = null,
} = {}) {
  const checks = await Promise.all([
    checkNodeVersion(),
    checkNodeSqlite(),          // ← NEW
    checkPython(resolvePythonBin, spawnCheck),
    checkGraphify(resolvePythonBin, spawnCheck),
    checkAgentMemoryMcp(spawnCheck),
    checkOllama(env, fetchImpl),
    checkMemoryDbPath(env),
    checkEmbeddingCachePath(env),
  ]);
  return { checks };
}
```

- [ ] **Step 4: Run doctor tests — expect PASS**

```bash
cd tools/project-memory-context && node --test tests/doctor.test.mjs
```

Expected: All tests PASS (8 checks; node-sqlite is `ok` on Node 24).

- [ ] **Step 5: Commit**

```bash
git add tools/project-memory-context/src/doctor.mjs \
        tools/project-memory-context/tests/doctor.test.mjs
git commit -m "feat(doctor): add node-sqlite version check (ok ≥24, warn ≥22.5, fail <22.5)"
```

---

## Task 9: Update `package.json` engines + add `graph.db` to gitignore

**Files:**
- Modify: `tools/project-memory-context/package.json`

- [ ] **Step 1: Update engines field**

In `tools/project-memory-context/package.json`, change:
```json
"engines": {
  "node": ">=18.0.0"
}
```
to:
```json
"engines": {
  "node": ">=22.5.0"
}
```

- [ ] **Step 2: Add graph.db to .gitignore template**

Find the gitignore template for PMC projects:

```bash
grep -r "\.gitignore" tools/project-memory-context/templates/ --include="*.mjs" --include="*.md" -l
```

Look at `tools/project-memory-context/src/setup-bootstrap.mjs` for the gitignore block and add:

```
.planning/project-memory-context/graph/graph.db
.planning/project-memory-context/graph/graph.db-shm
.planning/project-memory-context/graph/graph.db-wal
```

(These three files are created by WAL mode SQLite.)

- [ ] **Step 3: Run full test suite**

```bash
cd tools/project-memory-context && node --test tests/*.test.mjs
```

Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add tools/project-memory-context/package.json \
        tools/project-memory-context/src/setup-bootstrap.mjs
git commit -m "chore(pmc): bump engines to >=22.5.0; gitignore graph.db WAL files"
```

---

## Task 10: Final integration verification

- [ ] **Step 1: Run the full test suite one more time**

```bash
cd tools/project-memory-context && node --test tests/*.test.mjs
```

Expected: All tests PASS.

- [ ] **Step 2: Run pmc doctor**

```bash
pmc doctor
```

Expected: 8 checks, all `ok` (on Node 24). `node-sqlite` check shows `ok`.

- [ ] **Step 3: Smoke test get-context at multiple depths**

```bash
pmc get-context createQueryEngine
pmc get-context buildFromGraphJson extended dependencies
pmc get-context file tools/project-memory-context/src/retrieval/query-engine.mjs deep all
```

Expected: All produce structured output. Verify `graph.db` is created in
`.planning/project-memory-context/graph/`.

- [ ] **Step 4: Verify graph.db size and WAL mode**

```bash
node -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('.planning/project-memory-context/graph/graph.db');
const mode = db.prepare('PRAGMA journal_mode').get();
const nNodes = db.prepare('SELECT COUNT(*) as n FROM nodes').get();
const nEdges = db.prepare('SELECT COUNT(*) as n FROM edges').get();
console.log('WAL mode:', mode);
console.log('Nodes:', nNodes.n);
console.log('Edges:', nEdges.n);
db.close();
" --input-type=module
```

Expected: `journal_mode: 'wal'`; node/edge counts match the graph.

- [ ] **Step 5: Final commit (version bump)**

```bash
cd tools/project-memory-context
node -e "
import { readFileSync, writeFileSync } from 'fs';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [maj, min, patch] = pkg.version.split('.').map(Number);
pkg.version = \`\${maj}.\${min}.\${patch + 1}\`;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('Version bumped to', pkg.version);
" --input-type=module
git add package.json
git commit -m "chore(pmc): bump version — SQLite graph store complete"
```
