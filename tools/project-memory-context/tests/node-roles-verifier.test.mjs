import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createSqliteGraphStore, buildFromGraphJson } from '../src/graph-store/graph-db.mjs';
import { loadProfile } from '../src/roles/classify.mjs';

const path = 'src/worker.ts', key = `ts|${path}|class|exported|WorkerService|0`;
const endpoint = { id: key, symbolKey: key, kind: 'class', path };
const classification = { role: 'service', layer: 'application', confidence: 0.7, evidence: ['Caller supplied suffix evidence'] };
const node = { id: 'raw1', label: 'WorkerService', kind: 'class', source_file: path, metadata: { symbolKey: key, semanticSummary: 'Keep me' } };
const assignment = { endpoint, classification };

function fixture(t, nodes = [node]) {
  const root = mkdtempSync(join(tmpdir(), 'role-probe-'));
  const file = join(root, 'graph.db');
  const db = new DatabaseSync(file);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE nodes(id TEXT PRIMARY KEY,label TEXT,kind TEXT,node_kind TEXT,source_file TEXT,community INTEGER,degree INTEGER,metadata TEXT);
    CREATE TABLE edges(source TEXT,target TEXT,relation TEXT);
    CREATE TABLE community_names(community_id TEXT PRIMARY KEY,name TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE native_edges(source_id TEXT,target_id TEXT,relation TEXT,source_kind TEXT,target_kind TEXT);
    CREATE TABLE native_import_bindings(source_id TEXT,file_id TEXT,evidence TEXT);
    INSERT INTO community_names VALUES (1,'Preserved','old','old');
    INSERT INTO native_edges VALUES ('a','b','calls','class','class');
    INSERT INTO native_import_bindings VALUES ('file|a.ts','file|b.ts','{"imported":"B","local":"B","typeOnly":false}');
  `);
  buildFromGraphJson(db, { nodes, links: [] }, 'first');
  return { db, file, store: createSqliteGraphStore(db) };
}

const rows = (db) => JSON.stringify(db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all().map((row) => [
  row, row.name.startsWith('sqlite_') || !row.sql?.startsWith('CREATE TABLE')
    ? null : db.prepare(`SELECT * FROM "${row.name}" ORDER BY rowid`).all(),
]));
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
function unchanged(fixture, action, message, byteIdentical = true) {
  const before = rows(fixture.db), bytes = hash(fixture.file);
  assert.throws(action, (error) => error.message === message);
  assert.equal(rows(fixture.db), before);
  if (byteIdentical) assert.equal(hash(fixture.file), bytes);
}

test('S5 full DB unchanged after invalid batches; exact errors', (t) => {
  const f = fixture(t);
  for (const [input, message] of [
    [null, 'Role assignments must be an array'],
    [[assignment, { endpoint: { ...endpoint, id: 'raw1' }, classification }], 'Role endpoint identity, path, kind and symbolKey must agree'],
    [[assignment, assignment], 'Duplicate role assignment endpoint'],
    ...[-0.1, 1.1].map((confidence) => [[{ endpoint, classification: { ...classification, confidence } }], 'Invalid role classification shape or confidence/evidence']),
    [[{ endpoint, classification: { ...classification, evidence: [' '] } }], 'Invalid role classification shape or confidence/evidence'],
    [[{ endpoint, classification: { role: null, layer: null, confidence: 0.1, evidence: [] } }], 'Invalid unknown role classification'],
    [[{ endpoint, classification: { ...classification, role: 'invented' } }], 'Role classification must use a declared role/layer with evidence'],
    [[{ endpoint: { ...endpoint, path: '../worker.ts' }, classification }], 'Role endpoint path must be normalized and project-relative'],
    [[{ endpoint: [], classification }], 'Role assignment requires a canonical endpoint'],
  ]) unchanged(f, () => f.store.persistNodeRoles(input), message);
  assert.deepEqual(f.store.persistNodeRoles([]), { updated: 0 });
});

test('S5 metadata, auxiliary tables, repeat-call idempotency and rebuild withholding', (t) => {
  const f = fixture(t);
  const aux = () => JSON.stringify(['native_edges', 'native_import_bindings', 'community_names'].map((name) => f.db.prepare(`SELECT * FROM ${name}`).all()));
  const before = aux();
  assert.deepEqual(f.store.persistNodeRoles([assignment]), { updated: 1 });
  const bytes = hash(f.file);
  assert.deepEqual(f.store.persistNodeRoles([assignment]), { updated: 1 });
  assert.equal(hash(f.file), bytes);
  assert.equal(f.store.getNode('raw1').metadata.semanticSummary, 'Keep me');
  assert.equal(aux(), before);
  buildFromGraphJson(f.db, { nodes: [{ ...node, id: 'raw2' }], links: [] }, 'second');
  assert.deepEqual(f.store.getNode('raw2').metadata.roleClassification, classification);
  assert.equal(aux(), before);
  for (const nodes of [[], [{ ...node, metadata: { symbolKey: key.replace('WorkerService', 'Other') } }], [node, { ...node, id: 'dup' }], [{ ...node, symbolKey: key.replace('WorkerService', 'Other') }]]) {
    buildFromGraphJson(f.db, { nodes, links: [] }, 'next');
    assert.equal(f.store.getNodeRole(key), null);
    for (const current of nodes) assert.equal(f.store.getNode(current.id).metadata.roleClassification, undefined);
  }
  assert.equal(f.db.prepare('SELECT count(*) n FROM node_role_assignments').get().n, 1);
});

test('S5 late SQL trigger abort rolls back DDL, assignments and metadata', (t) => {
  const second = { ...node, id: 'raw2', metadata: { symbolKey: key.replace('WorkerService', 'Second') } };
  const f = fixture(t, [node, second]);
  f.db.exec("CREATE TRIGGER fail_role BEFORE UPDATE OF metadata ON nodes WHEN NEW.id='raw2' BEGIN SELECT RAISE(ABORT,'role storage blocked'); END;");
  unchanged(f, () => f.store.persistNodeRoles([assignment, {
    endpoint: { ...endpoint, id: second.metadata.symbolKey, symbolKey: second.metadata.symbolKey }, classification,
  }]), 'role storage blocked', false);
});

test('S5 custom declaring profile, Csharp7, file unknown, read-only legacy', (t) => {
  const cs = 'csharp|src/worker.cs|App|Worker|method|Run|0';
  const file = { id: 'file|src/worker.ts', kind: 'file', path };
  const f = fixture(t, [{ id: 'csraw', label: 'Run', kind: 'method', source_file: 'src/worker.cs', metadata: { symbolKey: cs } }, { id: 'fileraw', label: path, source_file: path }]);
  const profile = loadProfile('generic');
  profile.roleLayers.custom = 'custom-layer';
  const custom = { ...classification, role: 'custom', layer: 'custom-layer' };
  f.store.persistNodeRoles([{ endpoint: { id: cs, symbolKey: cs, kind: 'method', path: 'src/worker.cs' }, classification: custom }], { profile });
  assert.deepEqual(f.store.getNodeRole(cs), custom);
  const unknown = { role: null, layer: null, confidence: 0, evidence: [] };
  f.store.persistNodeRoles([{ endpoint: file, classification: unknown }]);
  assert.deepEqual(f.store.getNodeRole(file.id), unknown);
  const legacy = fixture(t), bytes = hash(legacy.file);
  const readonly = new DatabaseSync(legacy.file, { readOnly: true });
  try { assert.equal(createSqliteGraphStore(readonly).getNodeRole(key), null); } finally { readonly.close(); }
  assert.equal(hash(legacy.file), bytes);
});

test('S5 explicit unknown storage options must reject without writing', (t) => {
  const f = fixture(t), before = rows(f.db);
  assert.throws(() => f.store.persistNodeRoles([assignment], { profileName: 'node-cli' }), TypeError);
  assert.equal(rows(f.db), before);
});

test('S5 uniquely canonical metadata permits original Graphify null kind', (t) => {
  const f = fixture(t, [{ ...node, kind: null }]);
  assert.deepEqual(f.store.persistNodeRoles([assignment]), { updated: 1 });
});

test('S5 contradictory file symbolKey must not receive role assignment', (t) => {
  const f = fixture(t, [{ id: 'file-raw', label: path, source_file: path, metadata: { symbolKey: 'ts|src/other.ts|class|exported|Other|0' } }]);
  assert.throws(() => f.store.persistNodeRoles([{ endpoint: { id: `file|${path}`, kind: 'file', path }, classification }]), TypeError);
});
