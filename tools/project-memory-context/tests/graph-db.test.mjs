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
  // Verify meta was updated to the second hash (DELETE+INSERT was complete)
  const hashRow = db.prepare(`SELECT value FROM meta WHERE key = 'content_hash'`).get();
  assert.equal(hashRow?.value, 'h2', 'content_hash should be updated to second build hash');
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

test('openGraphDb opens graph.db in WAL mode on disk', () => {
  const dir = tmpdir();
  const dbPath = join(dir, `pmc-wal-test-${Date.now()}.db`);
  const jsonPath = join(dir, `pmc-wal-test-${Date.now()}.json`);

  try {
    writeFileSync(jsonPath, JSON.stringify(FIXTURE), 'utf8');
    const store = openGraphDb(dbPath, jsonPath);
    store.close();

    // Re-open the file directly to check journal_mode
    const db = new DatabaseSync(dbPath);
    const row = db.prepare(`PRAGMA journal_mode`).get();
    db.close();

    const mode = row?.journal_mode ?? row?.['journal_mode'] ?? '';
    assert.equal(mode, 'wal', `Expected WAL mode on disk DB, got: ${mode}`);
  } finally {
    if (existsSync(dbPath)) rmSync(dbPath);
    if (existsSync(jsonPath)) rmSync(jsonPath);
    // Also clean up WAL sidecar files if present
    const shmPath = dbPath + '-shm';
    const walPath = dbPath + '-wal';
    if (existsSync(shmPath)) rmSync(shmPath);
    if (existsSync(walPath)) rmSync(walPath);
  }
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
