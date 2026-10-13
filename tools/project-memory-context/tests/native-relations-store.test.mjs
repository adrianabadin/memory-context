// tools/project-memory-context/tests/native-relations-store.test.mjs
//
// Unit C (S4–S5): native relation facts persist with relation type and
// canonical resolved endpoints; unresolved/ambiguous cases stay unresolved
// and never become raw-ID edges; native edges survive Graphify rebuilds and
// never disturb the legacy nodes/edges/community surfaces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { buildFromGraphJson, openGraphDb } from '../src/graph-store/graph-db.mjs';
import {
  NATIVE_EDGES_SCHEMA_SQL,
  persistNativeRelations,
  listNativeEdges,
  getNativeEdgesFor,
} from '../src/graph-store/native-relations.mjs';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const GRAPH = {
  nodes: [
    { id: 'a', label: 'A', source_file: 'src/a.ts', kind: 'function', community: 1, degree: 1 },
    { id: 'b', label: 'B', source_file: 'src/b.ts', kind: 'class', community: 1, degree: 1 },
  ],
  links: [{ source: 'a', target: 'b', relation: 'calls' }],
};

const SYMBOL_SRC = { id: 'src/a.ts|fn|main', symbolKey: 'src/a.ts|fn|main', kind: 'function', path: 'src/a.ts' };
const SYMBOL_TGT = { id: 'src/b.ts|fn|helper', symbolKey: 'src/b.ts|fn|helper', kind: 'function', path: 'src/b.ts' };
const FILE_SRC = { id: 'file|src/a.ts', kind: 'file', path: 'src/a.ts' };
const FILE_TGT = { id: 'file|src/b.ts', kind: 'file', path: 'src/b.ts' };

const CALLS_RESULT = {
  relations: [
    { relation: 'calls', source: SYMBOL_SRC, callee: 'helper', range: { startLine: 3, endLine: 3 }, target: SYMBOL_TGT },
  ],
  unresolved: [
    { relation: 'calls', source: SYMBOL_SRC, callee: 'dynamic', range: { startLine: 5, endLine: 5 }, reason: 'unsupported-receiver' },
  ],
};

const IMPORTS_RESULT = {
  relations: [
    { relation: 'imports', source: FILE_SRC, specifier: './b.ts', bindings: [], typeOnly: false, range: { startLine: 1, endLine: 1 }, target: FILE_TGT },
  ],
  unresolved: [],
};

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, label TEXT, kind TEXT, source_file TEXT, community INTEGER, degree INTEGER, metadata TEXT);
    CREATE TABLE edges (source TEXT NOT NULL, target TEXT NOT NULL, relation TEXT NOT NULL);
    CREATE INDEX idx_edges_source ON edges(source, relation);
    CREATE INDEX idx_edges_target ON edges(target, relation);
    CREATE INDEX idx_nodes_file ON nodes(source_file);
  `);
  db.exec(NATIVE_EDGES_SCHEMA_SQL);
  return db;
}

// ── Persistence (S4) ──────────────────────────────────────────────────────────

test('persistNativeRelations inserts resolved edges with canonical endpoint IDs', () => {
  const db = makeDb();
  const calls = persistNativeRelations(db, CALLS_RESULT);
  assert.equal(calls.inserted, 1);
  assert.equal(calls.duplicates, 0);
  assert.deepEqual(calls.unresolved, { calls: 1 });

  const imports = persistNativeRelations(db, IMPORTS_RESULT);
  assert.equal(imports.inserted, 1);
  assert.deepEqual(imports.unresolved, {});

  assert.deepEqual(listNativeEdges(db), [
    { source: { id: 'file|src/a.ts', kind: 'file' }, target: { id: 'file|src/b.ts', kind: 'file' }, relation: 'imports' },
    { source: { id: 'src/a.ts|fn|main', kind: 'function' }, target: { id: 'src/b.ts|fn|helper', kind: 'function' }, relation: 'calls' },
  ]);
});

test('persistNativeRelations is idempotent for duplicate triples', () => {
  const db = makeDb();
  persistNativeRelations(db, CALLS_RESULT);
  const again = persistNativeRelations(db, CALLS_RESULT);
  assert.equal(again.inserted, 0);
  assert.equal(again.duplicates, 1);
  assert.equal(listNativeEdges(db).length, 1);
});

test('unresolved facts never become edges and are reported by relation', () => {
  const db = makeDb();
  const onlyUnresolved = { relations: [], unresolved: CALLS_RESULT.unresolved };
  const out = persistNativeRelations(db, onlyUnresolved);
  assert.deepEqual(out.unresolved, { calls: 1 });
  assert.equal(listNativeEdges(db).length, 0);
});

test('a raw string target is rejected and the batch writes nothing', () => {
  const db = makeDb();
  persistNativeRelations(db, CALLS_RESULT);
  const before = JSON.stringify(listNativeEdges(db));
  const batch = {
    relations: [
      { relation: 'calls', source: SYMBOL_SRC, target: 'src/b.ts|fn|helper' },
      { relation: 'imports', source: FILE_SRC, target: FILE_TGT },
    ],
    unresolved: [],
  };
  assert.throws(() => persistNativeRelations(db, batch), TypeError);
  assert.equal(JSON.stringify(listNativeEdges(db)), before);
});

test('an unknown relation is rejected and the batch writes nothing', () => {
  const db = makeDb();
  const batch = {
    relations: [
      { relation: 'contains', source: FILE_SRC, target: SYMBOL_TGT },
      { relation: 'imports', source: FILE_SRC, target: FILE_TGT },
    ],
    unresolved: [],
  };
  assert.throws(() => persistNativeRelations(db, batch), TypeError);
  assert.equal(listNativeEdges(db).length, 0);
});

test('a resolved-list fact without a target is rejected without writing', () => {
  const db = makeDb();
  const batch = { relations: [{ relation: 'calls', source: SYMBOL_SRC }], unresolved: [] };
  assert.throws(() => persistNativeRelations(db, batch), TypeError);
  assert.equal(listNativeEdges(db).length, 0);
});

test('file endpoints must use the file| id prefix', () => {
  const db = makeDb();
  const bad = {
    relations: [{ relation: 'imports', source: { id: 'src/a.ts', kind: 'file', path: 'src/a.ts' }, target: FILE_TGT }],
    unresolved: [],
  };
  assert.throws(() => persistNativeRelations(db, bad), TypeError);
  assert.equal(listNativeEdges(db).length, 0);
});

test('symbol endpoint id must equal its symbolKey', () => {
  const db = makeDb();
  const bad = {
    relations: [{ relation: 'calls', source: { ...SYMBOL_SRC, symbolKey: 'other|key' }, target: SYMBOL_TGT }],
    unresolved: [],
  };
  assert.throws(() => persistNativeRelations(db, bad), TypeError);
  assert.equal(listNativeEdges(db).length, 0);
});

// ── Rebuild survival + legacy preservation (S4/S5) ───────────────────────────

test('native edges survive a Graphify rebuild and legacy tables rebuild untouched', () => {
  const db = makeDb();
  persistNativeRelations(db, CALLS_RESULT);
  const nativeBefore = JSON.stringify(listNativeEdges(db));

  const changed = { nodes: GRAPH.nodes, links: [{ source: 'a', target: 'b', relation: 'imports' }] };
  buildFromGraphJson(db, changed, 'new-hash');

  assert.equal(JSON.stringify(listNativeEdges(db)), nativeBefore);
  const rebuilt = db.prepare('SELECT relation FROM edges').all().map(row => ({ relation: row.relation }));
  assert.deepEqual(rebuilt, [{ relation: 'imports' }]);
});

test('getNativeEdgesFor returns edges touching an endpoint from both directions', () => {
  const db = makeDb();
  persistNativeRelations(db, CALLS_RESULT);
  persistNativeRelations(db, IMPORTS_RESULT);
  const edges = getNativeEdgesFor(db, 'file|src/b.ts');
  assert.equal(edges.length, 1);
  assert.equal(edges[0].relation, 'imports');
  const asTarget = getNativeEdgesFor(db, 'src/b.ts|fn|helper');
  assert.equal(asTarget.length, 1);
  assert.equal(asTarget[0].relation, 'calls');
});

test('openGraphDb exposes native persistence on the store across a rebuild', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-relations-store-'));
  try {
    const dbPath = join(root, 'graph.db');
    const jsonPath = join(root, 'graph.json');
    writeFileSync(jsonPath, JSON.stringify(GRAPH));
    const store = openGraphDb(dbPath, jsonPath);
    const out = store.persistNativeRelations(CALLS_RESULT);
    assert.equal(out.inserted, 1);
    assert.deepEqual(store.listNativeEdges(), [
      { source: { id: 'src/a.ts|fn|main', kind: 'function' }, target: { id: 'src/b.ts|fn|helper', kind: 'function' }, relation: 'calls' },
    ]);
    store.close();

    // Changing graph.json forces a full nodes/edges rebuild on reopen; the
    // native table must survive it with its canonical endpoints intact.
    const changed = { nodes: GRAPH.nodes, links: [] };
    writeFileSync(jsonPath, JSON.stringify(changed));
    const reopened = openGraphDb(dbPath, jsonPath);
    assert.deepEqual(reopened.listNativeEdges(), [
      { source: { id: 'src/a.ts|fn|main', kind: 'function' }, target: { id: 'src/b.ts|fn|helper', kind: 'function' }, relation: 'calls' },
    ]);
    assert.equal(reopened.getNativeEdgesFor('src/a.ts|fn|main').length, 1);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
