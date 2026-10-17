// tools/project-memory-context/tests/graph-db.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
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

// ── Typed node kinds (Task 1.1): persistence, readback, filtered traversal ─────
//
//   tf (symbol) --calls--> tc (symbol) --contains--> tm (member)
//   tf --contains--> df (doc)
//   tf --contains--> zf (data) --contains--> gz (symbol)   ← only path to gz
//   ff (file) and cf (config) are standalone path-labelled nodes.
//
const TYPED_FIXTURE = {
  nodes: [
    {
      id: 'tf', label: 'buildPipeline', source_file: 'src/pipeline.ts', kind: 'function',
      community: 1, degree: 3,
      metadata: { symbolKey: 'ts|src/pipeline.ts|function|exported|buildPipeline|0' },
    },
    { id: 'tc', label: 'ConfigLoader', source_file: 'src/config.ts', kind: 'class', community: 1, degree: 2 },
    {
      id: 'tm', label: '.load()', source_file: 'src/config.ts', kind: 'method', community: 1, degree: 1,
      metadata: { containerName: 'ConfigLoader' },
    },
    { id: 'ff', label: 'src/util.ts', file_type: 'code', source_file: 'src/util.ts', community: 2, degree: 1 },
    { id: 'df', label: 'docs/README.md', file_type: 'document', source_file: 'docs/README.md', community: 3, degree: 1 },
    { id: 'cf', label: 'package.json', source_file: 'package.json', community: 3, degree: 1 },
    { id: 'zf', label: 'fixtures/seeds.json', source_file: 'fixtures/seeds.json', community: 3, degree: 1 },
    { id: 'gz', label: 'zipUtil', source_file: 'src/zip.ts', kind: 'function', community: 4, degree: 1 },
  ],
  links: [
    { source: 'tf', target: 'tc', relation: 'calls' },
    { source: 'tc', target: 'tm', relation: 'contains' },
    { source: 'tf', target: 'df', relation: 'contains' },
    { source: 'tf', target: 'zf', relation: 'contains' },
    { source: 'zf', target: 'gz', relation: 'contains' },
  ],
};

const CODE_KINDS = ['file', 'symbol', 'member'];

function makeTypedStore() {
  const db = makeDb();
  buildFromGraphJson(db, TYPED_FIXTURE, 'typed-hash-1');
  return createSqliteGraphStore(db);
}

function sortIds(result) {
  return result.nodes.map((n) => n.id).sort();
}

function edgeTuples(result) {
  return result.edges.map((e) => `${e.source}->${e.target}:${e.relation}`).sort();
}

// ── persistence & readback ───────────────────────────────────────────────────

test('buildFromGraphJson persists typed node_kind classification for every taxonomy class', () => {
  const db = makeDb(); // legacy schema: no node_kind column
  buildFromGraphJson(db, TYPED_FIXTURE, 'typed-hash-1');
  const rows = db.prepare('SELECT id, node_kind FROM nodes').all();
  const kinds = Object.fromEntries(rows.map((r) => [r.id, r.node_kind]));
  assert.deepEqual(kinds, {
    tf: 'symbol',
    tc: 'symbol',
    tm: 'member',
    ff: 'file',
    df: 'doc',
    cf: 'config',
    zf: 'data',
    gz: 'symbol',
  });
  db.close();
});

test('getNode exposes node_kind while preserving legacy kind, label and metadata.symbolKey', () => {
  const store = makeTypedStore();
  const node = store.getNode('tf');
  assert.ok(node, 'node tf must exist');
  assert.equal(node.node_kind, 'symbol');
  assert.equal(node.kind, 'function', 'legacy kind column must be preserved');
  assert.equal(node.label, 'buildPipeline');
  assert.equal(node.metadata?.symbolKey, 'ts|src/pipeline.ts|function|exported|buildPipeline|0');
  const member = store.getNode('tm');
  assert.equal(member.node_kind, 'member');
  assert.equal(member.kind, 'method');
});

test('getNodesByFile readback carries node_kind for every node in the file', () => {
  const store = makeTypedStore();
  const nodes = store.getNodesByFile('src/config.ts');
  assert.equal(nodes.length, 2);
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n.node_kind]));
  assert.deepEqual(byId, { tc: 'symbol', tm: 'member' });
});

test('buildFromGraphJson adds node_kind to a legacy nodes schema without dropping columns', () => {
  const db = makeDb();
  buildFromGraphJson(db, TYPED_FIXTURE, 'typed-hash-1');
  const cols = db.prepare('PRAGMA table_info(nodes)').all().map((c) => c.name);
  assert.ok(cols.includes('node_kind'), `node_kind missing, columns: ${cols.join(',')}`);
  for (const original of ['id', 'label', 'kind', 'source_file', 'community', 'degree', 'metadata']) {
    assert.ok(cols.includes(original), `legacy column ${original} must survive`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n, TYPED_FIXTURE.nodes.length);
  db.close();
});

test('buildFromGraphJson persists hostile-looking ids and labels through bound parameters', () => {
  const db = makeDb();
  const hostile = {
    nodes: [{ id: "x'1", label: "Robert'); DROP TABLE nodes;--", kind: 'function', source_file: "src/weird'.ts" }],
    links: [],
  };
  buildFromGraphJson(db, hostile, 'h-hostile');
  const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get("x'1");
  assert.equal(row?.label, "Robert'); DROP TABLE nodes;--");
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((t) => t.name);
  assert.ok(tables.includes('nodes'), 'nodes table must survive a hostile label');
  db.close();
});

// ── traverse: nodeKinds filter ───────────────────────────────────────────────

test('traverse without nodeKinds is unchanged legacy behaviour', () => {
  const store = makeTypedStore();
  const result = store.traverse({ nodeIds: ['tf'], maxHops: 3 });
  assert.deepEqual(sortIds(result), ['df', 'gz', 'tc', 'tf', 'tm', 'zf']);
  assert.deepEqual(edgeTuples(result), [
    'tc->tm:contains',
    'tf->df:contains',
    'tf->tc:calls',
    'tf->zf:contains',
    'zf->gz:contains',
  ]);
  assert.equal(result.depth_reached, 2);
});

test('traverse nodeKinds restricts results to code and blocks paths through excluded nodes', () => {
  const store = makeTypedStore();
  const result = store.traverse({ nodeIds: ['tf'], maxHops: 3, nodeKinds: CODE_KINDS });
  assert.deepEqual(sortIds(result), ['tc', 'tf', 'tm']);
  assert.ok(!result.nodes.some((n) => n.node_kind === 'doc'), 'doc must be excluded');
  assert.ok(!result.nodes.some((n) => n.node_kind === 'data'), 'data must be excluded');
  assert.ok(!result.nodes.some((n) => n.node_kind === 'config'), 'config must be excluded');
  assert.ok(!result.nodes.some((n) => n.id === 'gz'), 'gz is only reachable through data node zf — must not leak');
  assert.deepEqual(edgeTuples(result), ['tc->tm:contains', 'tf->tc:calls']);
  assert.equal(result.depth_reached, 2, 'depth counts only expansions through allowed nodes');
});

test('traverse nodeKinds applies the same filter to seeds outside the filter', () => {
  const store = makeTypedStore();
  const filtered = store.traverse({ nodeIds: ['df'], maxHops: 2, nodeKinds: CODE_KINDS });
  assert.deepEqual(filtered.nodes, []);
  assert.deepEqual(filtered.edges, []);
  assert.equal(filtered.depth_reached, 0);
  const legacy = store.traverse({ nodeIds: ['df'], maxHops: 2 });
  assert.deepEqual(legacy.nodes.map((n) => n.id), ['df']);
});

test('traverse explicit empty nodeKinds matches nothing while omission stays legacy', () => {
  const store = makeTypedStore();
  const empty = store.traverse({ nodeIds: ['tf'], maxHops: 3, nodeKinds: [] });
  assert.deepEqual(empty.nodes, []);
  assert.deepEqual(empty.edges, []);
  assert.equal(empty.depth_reached, 0);
  const omitted = store.traverse({ nodeIds: ['tf'], maxHops: 3, nodeKinds: undefined });
  assert.deepEqual(sortIds(omitted), ['df', 'gz', 'tc', 'tf', 'tm', 'zf']);
});

test('traverse duplicated valid nodeKinds behave exactly like the deduplicated filter', () => {
  const store = makeTypedStore();
  const unique = store.traverse({ nodeIds: ['tf'], maxHops: 3, nodeKinds: ['file', 'symbol', 'member'] });
  const duplicated = store.traverse({
    nodeIds: ['tf'],
    maxHops: 3,
    nodeKinds: ['symbol', 'file', 'member', 'symbol', 'file'],
  });
  assert.deepEqual(duplicated, unique);
});

test('traverse rejects invalid and injection-shaped nodeKinds fail-closed', () => {
  const store = makeTypedStore();
  const invalidInputs = [
    ['files'],
    ["file') OR 1=1 --"],
    ['file", 1); DROP TABLE nodes;--'],
    ['symbol', 'bogus'],
    [42],
    [null],
    'file',
    null,
    7,
    {},
  ];
  for (const nodeKinds of invalidInputs) {
    assert.throws(
      () => store.traverse({ nodeIds: ['tf'], maxHops: 3, nodeKinds }),
      TypeError,
      `nodeKinds ${JSON.stringify(nodeKinds)} must throw TypeError`,
    );
  }
  // Fail-closed means the store still works and nothing was dropped.
  assert.equal(store.getNode('tf').label, 'buildPipeline');
  assert.ok(store.traverse({ nodeIds: ['tf'], maxHops: 1 }).nodes.length >= 1);
});

test('traverse nodeKinds filter works for inbound direction', () => {
  const store = makeTypedStore();
  const result = store.traverse({ nodeIds: ['tm'], maxHops: 3, direction: 'inbound', nodeKinds: CODE_KINDS });
  assert.deepEqual(sortIds(result), ['tc', 'tf', 'tm']);
  assert.equal(result.depth_reached, 2);
});

// ── openGraphDb: fresh ingest, legacy schema migration, schema version ────────

test('openGraphDb fresh JSON ingest persists node_kind for readback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmc-graphdb-kind-'));
  const dbPath = join(dir, 'graph.db');
  const jsonPath = join(dir, 'graph.json');
  try {
    writeFileSync(jsonPath, JSON.stringify(TYPED_FIXTURE), 'utf8');
    const store = openGraphDb(dbPath, jsonPath);
    assert.equal(store.getNode('df').node_kind, 'doc');
    assert.equal(store.getNode('ff').node_kind, 'file');
    assert.equal(store.getNode('cf').node_kind, 'config');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openGraphDb upgrades a legacy schema DB without dropping tables or losing community data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmc-graphdb-legacy-'));
  const dbPath = join(dir, 'graph.db');
  const jsonPath = join(dir, 'graph.json');
  try {
    writeFileSync(jsonPath, JSON.stringify(TYPED_FIXTURE), 'utf8');
    const contentHash = hashGraphJson(JSON.stringify(TYPED_FIXTURE));

    // Pre-1.1 schema: nodes without node_kind, schema_version absent, hash already current.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE nodes (id TEXT PRIMARY KEY, label TEXT, kind TEXT, source_file TEXT, community INTEGER, degree INTEGER, metadata TEXT);
      CREATE TABLE edges (source TEXT NOT NULL, target TEXT NOT NULL, relation TEXT NOT NULL);
      CREATE TABLE community_names (community_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT, updated_at TEXT);
      CREATE INDEX idx_edges_source ON edges(source, relation);
      CREATE INDEX idx_edges_target ON edges(target, relation);
      CREATE INDEX idx_nodes_file ON nodes(source_file);
    `);
    legacy.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('content_hash', contentHash);
    legacy.prepare(
      'INSERT INTO community_names (community_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('7', 'Kept Name', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    legacy.prepare(
      `INSERT INTO nodes (id, label, kind, source_file, community, degree, metadata)
       VALUES ('stale', 'Stale', 'function', 'src/stale.ts', 9, 1, '{}')`,
    ).run();
    legacy.close();

    const store = openGraphDb(dbPath, jsonPath);
    assert.equal(store.getCommunityName('7'), 'Kept Name', 'community data must survive');
    assert.equal(store.getNode('stale'), null, 'nodes are rebuilt from graph.json');
    assert.equal(store.getNode('tf').node_kind, 'symbol', 'rebuild must populate node_kind');
    store.close();

    const check = new DatabaseSync(dbPath);
    const tables = check.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((t) => t.name);
    for (const table of ['meta', 'nodes', 'edges', 'community_names']) {
      assert.ok(tables.includes(table), `table ${table} must not be dropped`);
    }
    const cols = check.prepare('PRAGMA table_info(nodes)').all().map((c) => c.name);
    assert.ok(cols.includes('node_kind'), 'node_kind column added additively');
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM nodes').get().n, TYPED_FIXTURE.nodes.length);
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM edges').get().n, TYPED_FIXTURE.links.length);
    assert.equal(
      check.prepare(`SELECT value FROM meta WHERE key = 'content_hash'`).get().value,
      contentHash,
    );
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openGraphDb records schema_version, skips rebuild when current, rebuilds when missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pmc-graphdb-version-'));
  const dbPath = join(dir, 'graph.db');
  const jsonPath = join(dir, 'graph.json');
  try {
    writeFileSync(jsonPath, JSON.stringify(TYPED_FIXTURE), 'utf8');
    openGraphDb(dbPath, jsonPath).close(); // initial build

    const probe = new DatabaseSync(dbPath);
    const version = probe.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()?.value;
    assert.ok(version, 'schema_version must be recorded on build');
    // Plant a ghost row: it survives only when no rebuild happens.
    probe.prepare(
      `INSERT INTO nodes (id, label, kind, source_file, community, degree, metadata)
       VALUES ('ghost', 'Ghost', NULL, NULL, NULL, NULL, '{}')`,
    ).run();
    probe.close();

    openGraphDb(dbPath, jsonPath).close(); // hash + schema_version current → no rebuild
    const afterNoop = new DatabaseSync(dbPath);
    assert.ok(afterNoop.prepare(`SELECT id FROM nodes WHERE id = 'ghost'`).get(), 'ghost must survive a no-op reopen');
    afterNoop.prepare(`DELETE FROM meta WHERE key = 'schema_version'`).run();
    afterNoop.prepare('UPDATE nodes SET node_kind = NULL').run();
    afterNoop.close();

    openGraphDb(dbPath, jsonPath).close(); // schema_version missing → rebuild
    const afterRebuild = new DatabaseSync(dbPath);
    assert.equal(
      afterRebuild.prepare(`SELECT id FROM nodes WHERE id = 'ghost'`).get(),
      undefined,
      'schema_version mismatch must trigger a rebuild',
    );
    const tf = afterRebuild.prepare(`SELECT node_kind FROM nodes WHERE id = 'tf'`).get();
    assert.equal(tf?.node_kind, 'symbol', 'rebuild must re-populate node_kind');
    afterRebuild.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── classifyNodeKind: pure typed-taxonomy classifier (Task 1.1) ───────────────

const { classifyNodeKind } = await import('../src/graph-store/graph-db.mjs');

test('classifyNodeKind: code-file labels and paths classify as file (ts/tsx/mjs/cs/go)', () => {
  assert.equal(classifyNodeKind({ label: 'src/app.ts', file_type: 'code' }), 'file');
  assert.equal(classifyNodeKind({ label: 'src/component.tsx' }), 'file');
  assert.equal(classifyNodeKind({ label: 'tools/build.mjs' }), 'file');
  assert.equal(classifyNodeKind({ label: 'src/App.cs' }), 'file');
  assert.equal(classifyNodeKind({ label: 'pkg/service.go' }), 'file');
});

test('classifyNodeKind: markdown and document nodes classify as doc', () => {
  assert.equal(classifyNodeKind({ label: 'docs/README.md', file_type: 'document' }), 'doc');
  assert.equal(classifyNodeKind({ label: 'CHANGELOG.md' }), 'doc');
  assert.equal(classifyNodeKind({ label: 'guide.markdown', source_file: 'docs/guide.markdown' }), 'doc');
  assert.equal(
    classifyNodeKind({ label: 'Getting Started', file_type: 'document', source_file: 'docs/README.md' }),
    'doc',
  );
});

test('classifyNodeKind: JSON/YAML/TOML nodes split config vs data deterministically', () => {
  assert.equal(classifyNodeKind({ label: 'package.json' }), 'config');
  assert.equal(classifyNodeKind({ label: 'tsconfig.json' }), 'config');
  assert.equal(classifyNodeKind({ label: '.eslintrc' }), 'config');
  assert.equal(classifyNodeKind({ label: 'Makefile' }), 'config');
  assert.equal(classifyNodeKind({ label: 'docker-compose.yml' }), 'config');
  assert.equal(classifyNodeKind({ label: 'fixtures/seeds.json' }), 'data');
  assert.equal(classifyNodeKind({ label: 'data/export.yaml' }), 'data');
  assert.equal(classifyNodeKind({ label: 'package-lock.json' }), 'data');
});

test('classifyNodeKind: structured symbol evidence classifies as symbol', () => {
  assert.equal(classifyNodeKind({ label: 'getUser', kind: 'function', source_file: 'src/a.ts' }), 'symbol');
  assert.equal(classifyNodeKind({ label: 'ConfigLoader', kind: 'class' }), 'symbol');
  assert.equal(classifyNodeKind({ label: 'Iface', kind: null, metadata: { kind: 'interface' } }), 'symbol');
  assert.equal(
    classifyNodeKind({ label: 'run', metadata: { symbolKey: 'ts|src/a.ts|function|exported|run|0' } }),
    'symbol',
  );
  assert.equal(classifyNodeKind({ label: 'embedded', file_type: 'code', source_location: 'L10' }), 'symbol');
});

test('classifyNodeKind: structured member evidence classifies as member', () => {
  assert.equal(classifyNodeKind({ label: 'save', kind: 'method', source_file: 'src/a.ts' }), 'member');
  assert.equal(classifyNodeKind({ label: 'count', metadata: { containerName: 'Store' } }), 'member');
  assert.equal(
    classifyNodeKind({ label: 'toString', metadata: { symbolKey: 'ts|src/a.ts|method|member|Store.toString|0' } }),
    'member',
  );
  assert.equal(
    classifyNodeKind({ label: 'Find', metadata: { symbolKey: 'csharp|src/A.cs|Ns|Repo|method|Find|()' } }),
    'member',
  );
});

test('classifyNodeKind: method-shaped labels without container evidence stay symbol until Task 1.2', () => {
  // Graphify labels both functions and methods as ".name()"; without structured
  // container/kind/member-key evidence the classifier must not guess membership.
  assert.equal(classifyNodeKind({ label: '.load()', file_type: 'code', source_location: 'L18' }), 'symbol');
});

test('classifyNodeKind: unknown shapes fail closed to data (no label-only guessing)', () => {
  assert.equal(classifyNodeKind({}), 'data');
  assert.equal(classifyNodeKind(null), 'data');
  assert.equal(classifyNodeKind(undefined), 'data');
  assert.equal(classifyNodeKind('src/a.ts'), 'data');
  assert.equal(classifyNodeKind(42), 'data');
  assert.equal(classifyNodeKind({ label: 'Getting Started' }), 'data');
  assert.equal(classifyNodeKind({ id: 'n1', label: 'mystery' }), 'data');
  assert.equal(classifyNodeKind({ label: 'src/v1.2/README' }), 'data');
});

test('classifyNodeKind: deterministic across structurally identical inputs', () => {
  const left = { label: 'deepModule', kind: 'function', metadata: { symbolKey: 'ts|src/deep/module.ts|function|local|deepModule|0' } };
  const right = JSON.parse(JSON.stringify(left));
  assert.equal(classifyNodeKind(left), classifyNodeKind(right));
  assert.equal(classifyNodeKind(left), 'symbol');
});

test('classifyNodeKind: path-shaped labels win over contradictory symbol hints (file detection comes from labels and paths)', () => {
  const contradictory = {
    label: 'src/deep/module.ts',
    kind: 'function',
    file_type: 'code',
    metadata: { symbolKey: 'ts|src/deep/module.ts|function|local|module|0' },
  };
  assert.equal(classifyNodeKind(contradictory), 'file');
  assert.equal(classifyNodeKind({ ...contradictory, label: 'module' }), 'symbol');
});

// ── node_kind reservation: raw payload must not shadow the canonical column ──
//
//   sk (classified symbol) carries raw node_kind: 'bogus'
//   sv (classified symbol) carries raw but taxonomy-valid node_kind: 'doc'
//   sp (path label → classified file) carries raw node_kind: 'symbol'
//
const SHADOW_FIXTURE = {
  nodes: [
    { id: 'sk', label: 'shadowKey', kind: 'function', source_file: 'src/shadow.ts', node_kind: 'bogus' },
    { id: 'sv', label: 'shadowValid', kind: 'function', source_file: 'src/shadow.ts', node_kind: 'doc' },
    { id: 'sp', label: 'src/other.ts', kind: 'function', node_kind: 'symbol' },
  ],
  links: [{ source: 'sk', target: 'sv', relation: 'calls' }],
};

function makeShadowStore() {
  const db = makeDb();
  buildFromGraphJson(db, SHADOW_FIXTURE, 'shadow-hash-1');
  return { store: createSqliteGraphStore(db), db };
}

test('getNode reports canonical node_kind despite bogus or contradictory raw payload node_kind', () => {
  const { store, db } = makeShadowStore();
  try {
    assert.equal(store.getNode('sk').node_kind, 'symbol', 'raw bogus payload must not shadow the computed column');
    assert.equal(store.getNode('sv').node_kind, 'symbol', 'raw valid-but-wrong category must be ignored');
    assert.equal(store.getNode('sp').node_kind, 'file', 'path-label classification wins over raw symbol payload');
    assert.equal(
      store.getNode('sk').metadata?.node_kind,
      undefined,
      'raw payload node_kind must not be serialized into metadata',
    );
  } finally {
    db.close();
  }
});

test('traversal readback reports canonical node_kind for shadowed payloads (filtered and unfiltered)', () => {
  const { store, db } = makeShadowStore();
  try {
    const unfiltered = store.traverse({ nodeIds: ['sk'], maxHops: 2 });
    const byId = Object.fromEntries(unfiltered.nodes.map((n) => [n.id, n.node_kind]));
    assert.deepEqual(byId, { sk: 'symbol', sv: 'symbol' });

    const codeFiltered = store.traverse({ nodeIds: ['sk'], maxHops: 2, nodeKinds: ['file', 'symbol', 'member'] });
    assert.deepEqual(codeFiltered.nodes.map((n) => n.id).sort(), ['sk', 'sv']);
    assert.ok(
      codeFiltered.nodes.every((n) => n.node_kind === 'symbol'),
      'filtered readback must report the canonical column, not the raw payload',
    );

    const docFiltered = store.traverse({ nodeIds: ['sk'], maxHops: 2, nodeKinds: ['doc'] });
    assert.deepEqual(docFiltered.nodes, [], 'sv is canonically symbol — raw doc payload must not match');

    const fileFiltered = store.traverse({ nodeIds: ['sp'], maxHops: 1, nodeKinds: ['file'] });
    assert.deepEqual(
      fileFiltered.nodes.map((n) => [n.id, n.node_kind]),
      [['sp', 'file']],
    );
  } finally {
    db.close();
  }
});

test('persisted metadata column never contains a raw payload node_kind key', () => {
  const { db } = makeShadowStore();
  try {
    for (const id of ['sk', 'sv', 'sp']) {
      const row = db.prepare('SELECT metadata FROM nodes WHERE id = ?').get(id);
      const meta = JSON.parse(row.metadata ?? '{}');
      assert.ok(
        !Object.prototype.hasOwnProperty.call(meta, 'node_kind'),
        `metadata of ${id} must not carry a node_kind key`,
      );
    }
  } finally {
    db.close();
  }
});
