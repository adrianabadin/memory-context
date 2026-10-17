import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildFileCard } from '../src/cards/file-card.mjs';
import { buildFromGraphJson, createSqliteGraphStore } from '../src/graph-store/graph-db.mjs';
import { extractNativeCalls } from '../src/relations/native-calls.mjs';
import { extractNativeImports } from '../src/relations/native-imports.mjs';

const SERVICE = 'src/services/user.service.ts';
const CLASS = 'ts|src/services/user.service.ts|class|exported|UserService|0';
const METHOD = 'ts|src/services/user.service.ts|method|member|UserService.findById|1';
const CONSTRUCTOR = 'ts|src/services/user.service.ts|method|member|UserService.constructor|1';
const paths = ['src/controllers/user.controller.ts', SERVICE, 'src/repositories/user.repository.ts',
  'src/models/user.model.ts', 'src/utils/format.ts', 'tests/user.service.test.ts'];

async function setup() {
  const files = await Promise.all(paths.map(async path => ({ path,
    content: await readFile(new URL(`./fixtures/layered-app/${path}`, import.meta.url), 'utf8') })));
  const calls = await extractNativeCalls({ files });
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE nodes(id TEXT PRIMARY KEY,label TEXT,kind TEXT,source_file TEXT,community INTEGER,degree INTEGER,metadata TEXT); CREATE TABLE edges(source TEXT,target TEXT,relation TEXT);');
  const nodes = calls.symbols.map(symbol => ({ id: symbol.id, label: symbol.id.split('|')[4],
    kind: symbol.kind, source_file: symbol.path, metadata: { symbolKey: symbol.symbolKey } }));
  buildFromGraphJson(db, { nodes, links: [] }, 'file-card-fixture');
  const store = createSqliteGraphStore(db);
  store.persistNativeRelations(await extractNativeImports({ files }));
  return { db, store, nodes };
}
const snapshot = db => createHash('sha256').update(JSON.stringify(['meta', 'nodes', 'edges', 'native_edges', 'native_import_bindings']
  .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()))).digest('hex');

test('service file card links exact exports, members and file dependencies', async () => {
  const { db, store, nodes } = await setup();
  try {
    const before = snapshot(db);
    const card = buildFileCard(store, SERVICE);
    assert.deepEqual(Object.keys(card), ['path', 'kind', 'exports', 'importsFrom', 'importedBy', 'symbolCount', 'members']);
    assert.equal(card.path, SERVICE); assert.equal(card.kind, 'file');
    assert.deepEqual(card.exports, [{ id: CLASS, symbolKey: CLASS, kind: 'class' }]);
    assert.deepEqual(card.members, [CONSTRUCTOR, METHOD].sort().map(symbolKey => ({ id: symbolKey, symbolKey, kind: 'method' })));
    assert.deepEqual(card.importsFrom, ['src/models/user.model.ts', 'src/repositories/user.repository.ts', 'src/utils/format.ts']
      .map(path => ({ id: `file|${path}`, path, kind: 'file' })));
    assert.deepEqual(card.importedBy, ['src/controllers/user.controller.ts', 'tests/user.service.test.ts']
      .map(path => ({ id: `file|${path}`, path, kind: 'file' })));
    assert.equal(card.symbolCount, nodes.filter(node => node.source_file === SERVICE).length);
    for (const item of [...card.exports, ...card.members]) assert.ok(store.getNode(item.id));
    assert.deepEqual(buildFileCard(store, SERVICE.replaceAll('/', '\\')), card);
    assert.equal(snapshot(db), before);
  } finally { db.close(); }
});

test('unknown files return honest empty cards without mutating the store', async () => {
  const { db, store } = await setup();
  try {
    const before = snapshot(db);
    assert.deepEqual(buildFileCard(store, 'src/missing.ts'), { path: 'src/missing.ts', kind: 'file',
      exports: [], importsFrom: [], importedBy: [], symbolCount: 0, members: [] });
    assert.equal(snapshot(db), before);
  } finally { db.close(); }
});

test('invalid file paths and read surfaces reject without mutation', async () => {
  const { db, store } = await setup();
  try {
    const before = snapshot(db);
    for (const path of ['', '.', '..', '../outside.ts', '/absolute.ts', 'C:\\outside.ts', 'file|src/a.ts', 'src/a\u0000.ts', null]) {
      assert.throws(() => buildFileCard(store, path), TypeError);
    }
    assert.throws(() => buildFileCard({}, SERVICE), TypeError);
    assert.equal(snapshot(db), before);
  } finally { db.close(); }
});
