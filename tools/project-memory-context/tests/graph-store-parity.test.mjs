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

function edgeTuples(result) {
  return result.edges
    .map((e) => `${e.source}->${e.target}:${e.relation}`)
    .sort();
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
  test(`parity — ${label}`, async () => {
    const inmem = createQueryEngine({ graph: GRAPH, symbolIndex: {}, worklist: [] });
    const sqlite = createQueryEngine({
      graphStore: makeSqliteStore(GRAPH),
      symbolIndex: {},
      worklist: [],
    });
    const inmemResult = await fn(inmem);
    const sqliteResult = await fn(sqlite);
    assert.deepEqual(
      nodeIds(inmemResult),
      nodeIds(sqliteResult),
      `node sets should match for: ${label}`,
    );
    assert.deepEqual(
      edgeTuples(inmemResult),
      edgeTuples(sqliteResult),
      `edge sets should match for: ${label}`,
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

// queryFileContext returns { symbols, neighbors, edges } — adapt to the nodeIds helper shape
parityTest('queryFileContext src/user.ts', async (e) => {
  const r = await e.queryFileContext({ filePath: 'src/user.ts', depth: 'compact' });
  return { nodes: r.neighbors, edges: r.edges };
});

parityTest('queryFileContext src/post.ts deep', async (e) => {
  const r = await e.queryFileContext({ filePath: 'src/post.ts', depth: 'deep' });
  return { nodes: r.neighbors, edges: r.edges };
});
