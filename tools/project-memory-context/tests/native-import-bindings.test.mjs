import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { extractNativeImportBindings } from '../src/relations/native-import-bindings.mjs';
import { NATIVE_EDGES_SCHEMA_SQL, persistNativeRelations } from '../src/graph-store/native-relations.mjs';
import { createSqliteGraphStore, buildFromGraphJson } from '../src/graph-store/graph-db.mjs';

async function fixture() {
  return extractNativeImportBindings({ files: [
    { path: 'a.ts', content: 'import Default, { Public as Local, type Shape } from "./b";\nimport * as Namespace from "./b";\nimport "./b";' },
    { path: 'b.ts', content: 'export default class Default {}\nclass Internal {}\nexport { Internal as Public };\nexport interface Shape {}\nexport class Unrelated {}' },
  ] });
}
function dbFixture() {
  const db = new DatabaseSync(':memory:'); db.exec(NATIVE_EDGES_SCHEMA_SQL);
  return db;
}
test('explicit default/named aliases and type-only declarations resolve, namespace and side effects do not invent targets', async () => {
  const result = await fixture();
  const bindings = result.relations.flatMap(fact => fact.bindings);
  assert.deepEqual(bindings.filter(binding => binding.target).map(binding => [binding.local, binding.target.kind]),
    [['Default', 'class'], ['Local', 'class'], ['Shape', 'interface']]);
  assert.equal(bindings.find(binding => binding.local === 'Shape').typeOnly, true);
  assert.equal(bindings.find(binding => binding.local === 'Namespace').target, undefined);
  assert.equal(result.relations.at(-1).bindings.length, 0);
});
test('binding evidence roundtrips through the facade, deduplicates and survives legacy rebuild', async () => {
  const result = await fixture(); const db = dbFixture();
  persistNativeRelations(db, result);
  const store = createSqliteGraphStore(db);
  const first = store.listNativeImportBindings();
  assert.equal(first.length, 4);
  assert.equal(first.filter(binding => binding.target).length, 3);
  assert.equal(first.find(binding => binding.local === 'Shape').typeOnly, true);
  persistNativeRelations(db, result);
  assert.deepEqual(store.listNativeImportBindings(), first);
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE nodes (id TEXT PRIMARY KEY, label TEXT, kind TEXT, source_file TEXT, community INTEGER, degree INTEGER, metadata TEXT); CREATE TABLE edges (source TEXT, target TEXT, relation TEXT);');
  buildFromGraphJson(db, { nodes: [], links: [] }, 'rebuilt');
  assert.deepEqual(store.listNativeImportBindings(), first);
  db.close();
});
test('invalid binding in a mixed batch rejects without changing rows or schema', async () => {
  const result = await fixture(); const db = dbFixture(); persistNativeRelations(db, result);
  const dump = () => JSON.stringify(['native_edges', 'native_import_bindings'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()));
  const before = dump();
  const bad = structuredClone(result); bad.relations.at(-1).bindings = [{ imported: 'Bad', local: 'Bad', typeOnly: false, target: 'raw-id' }];
  assert.throws(() => persistNativeRelations(db, bad), TypeError);
  assert.equal(dump(), before);
  db.close();
});
test('legacy binding-less file edges keep their established readback', () => {
  const db = dbFixture();
  persistNativeRelations(db, { relations: [{ relation: 'imports', source: { id: 'file|a.ts', kind: 'file' }, target: { id: 'file|b.ts', kind: 'file' } }], unresolved: [] });
  const store = createSqliteGraphStore(db);
  assert.deepEqual(store.listNativeImportBindings(), []);
  assert.equal(store.listNativeEdges().length, 1);
  db.close();
});
test('duplicate exports and reexports do not select a symbol endpoint', async () => {
  const result = await extractNativeImportBindings({ files: [
    { path: 'a.ts', content: 'import { Shared, Remote } from "./b";' },
    { path: 'b.ts', content: 'class One {}\nclass Two {}\nexport { One as Shared };\nexport { Two as Shared };\nexport { Remote } from "./other";' },
  ] });
  assert.ok(result.relations.flatMap(fact => fact.bindings).every(binding => !binding.target));
});
