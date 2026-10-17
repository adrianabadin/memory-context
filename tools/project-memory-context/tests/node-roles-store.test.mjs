import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteGraphStore, buildFromGraphJson } from '../src/graph-store/graph-db.mjs';
import { classifySymbol, loadProfile } from '../src/roles/classify.mjs';

const key = 'ts|src/services/worker.ts|class|exported|WorkerService|0';
const endpoint = { id: key, symbolKey: key, kind: 'class', path: 'src/services/worker.ts' };
const classification = classifySymbol({ name: 'WorkerService', kind: 'class', filePath: endpoint.path }, { profile: loadProfile('generic') });
const node = { id: 'raw-1', label: 'WorkerService', kind: 'class', source_file: endpoint.path, metadata: { symbolKey: key, semanticSummary: 'Keep me' } };

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE nodes(id TEXT PRIMARY KEY,label TEXT,kind TEXT,node_kind TEXT,source_file TEXT,community INTEGER,degree INTEGER,metadata TEXT); CREATE TABLE edges(source TEXT,target TEXT,relation TEXT);');
  buildFromGraphJson(db, { nodes: [node], links: [] }, 'first');
  return { db, store: createSqliteGraphStore(db) };
}

function snapshot(db) {
  return JSON.stringify(db.prepare('SELECT * FROM nodes ORDER BY id').all());
}

test('S5 canonical role assignments persist in node metadata and survive changed raw IDs on rebuild', (t) => {
  const { db, store } = fixture(t);
  assert.equal(typeof store.persistNodeRoles, 'function');
  assert.deepEqual(store.persistNodeRoles([{ endpoint, classification }]), { updated: 1 });
  assert.deepEqual(store.getNode('raw-1').metadata.roleClassification, classification);
  assert.equal(store.getNode('raw-1').metadata.semanticSummary, 'Keep me');
  const updated = { ...node, id: 'raw-2' };
  buildFromGraphJson(db, { nodes: [updated], links: [] }, 'second');
  assert.deepEqual(store.getNode('raw-2').metadata.roleClassification, classification);
  assert.equal(store.getNode('raw-1'), null);
  assert.deepEqual(store.getNodeRole(key), classification);
});

test('S5 rejected batches validate all endpoints and classifications before mutation', (t) => {
  const { db, store } = fixture(t);
  assert.equal(typeof store.persistNodeRoles, 'function');
  const before = snapshot(db);
  for (const bad of [
    { endpoint: { ...endpoint, id: 'raw-1' }, classification },
    { endpoint: { ...endpoint, path: 'other.ts' }, classification },
    { endpoint: { ...endpoint, kind: 'function' }, classification },
    { endpoint: { ...endpoint, id: key.replace('WorkerService', 'Missing'), symbolKey: key.replace('WorkerService', 'Missing') }, classification },
    { endpoint, classification: { ...classification, confidence: NaN } },
    { endpoint, classification: { ...classification, role: null } },
    { endpoint, classification: { ...classification, evidence: [] } },
  ]) {
    assert.throws(() => store.persistNodeRoles([{ endpoint, classification }, bad]), TypeError);
    assert.equal(snapshot(db), before);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='node_role_assignments'").get(), undefined);
  }
});

test('S5 raw-ID reuse and duplicate canonical identities never inherit stale role metadata', (t) => {
  const { db, store } = fixture(t);
  assert.equal(typeof store.persistNodeRoles, 'function');
  store.persistNodeRoles([{ endpoint, classification }]);
  buildFromGraphJson(db, { nodes: [{ ...node, metadata: { symbolKey: key.replace('WorkerService', 'Other') } }], links: [] }, 'other');
  assert.equal(store.getNode('raw-1').metadata.roleClassification, undefined);
  assert.equal(store.getNodeRole(key), null);
  buildFromGraphJson(db, { nodes: [node, { ...node, id: 'duplicate' }], links: [] }, 'duplicate');
  assert.equal(store.getNode('raw-1').metadata.roleClassification, undefined);
  assert.equal(store.getNodeRole(key), null);
  const before = snapshot(db);
  assert.throws(() => store.persistNodeRoles([{ endpoint, classification }]), TypeError);
  assert.equal(snapshot(db), before);
});

test('S5 file assignments and honest unknown classifications are supported', (t) => {
  const { db, store } = fixture(t);
  assert.equal(typeof store.persistNodeRoles, 'function');
  const file = { id: 'file|src/worker.ts', kind: 'file', path: 'src/worker.ts' };
  buildFromGraphJson(db, { nodes: [{ id: file.id, label: file.path, source_file: file.path }], links: [] }, 'file');
  const unknown = { role: null, layer: null, confidence: 0, evidence: [] };
  store.persistNodeRoles([{ endpoint: file, classification: unknown }]);
  assert.deepEqual(store.getNode(file.id).metadata.roleClassification, unknown);
  assert.deepEqual(store.getNodeRole(file.id), unknown);
});
