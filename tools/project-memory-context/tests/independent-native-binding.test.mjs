import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractNativeImports } from '../src/relations/native-imports.mjs';
import { extractNativeImportBindings } from '../src/relations/native-import-bindings.mjs';
import { extractNativeCalls } from '../src/relations/native-calls.mjs';
import { extractSymbolsForFile } from '../src/extractors/tree-sitter/extract.mjs';
import { persistNativeRelations } from '../src/graph-store/native-relations.mjs';
import { createSqliteGraphStore, buildFromGraphJson } from '../src/graph-store/graph-db.mjs';
import { buildFacts } from '../src/cards/facts.mjs';

// Durable public-interface probes from the independent Sol verification.
// All persistence uses isolated in-memory databases, never production state.
const root = fileURLToPath(new URL('../', import.meta.url));
function digest(db) {
  const schema = db.prepare('SELECT * FROM sqlite_master ORDER BY type,name').all();
  const data = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]);
  return createHash('sha256').update(JSON.stringify({ schema, data })).digest('hex');
}
async function setup(files) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE nodes(id TEXT PRIMARY KEY,label TEXT,kind TEXT,source_file TEXT,community INTEGER,degree INTEGER,metadata TEXT); CREATE TABLE edges(source TEXT,target TEXT,relation TEXT);');
  const symbols = (await Promise.all(files.map(file => extractSymbolsForFile({ filePath: file.path, content: file.content })))).flat();
  const graph = { nodes: symbols.map(symbol => ({ id: symbol.symbolKey, label: symbol.name, kind: symbol.kind,
    source_file: symbol.filePath ?? symbol.symbolKey.split('|')[1], metadata: { symbolKey: symbol.symbolKey } })), links: [] };
  buildFromGraphJson(db, graph, 'independent-probe');
  const result = await extractNativeImportBindings({ files });
  persistNativeRelations(db, result);
  return { db, store: createSqliteGraphStore(db), result, graph };
}
function walk(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? walk(resolve(dir, entry.name), `${prefix}${entry.name}/`)
    : /\.(ts|tsx|js)$/.test(entry.name) && !prefix.startsWith('.') ? [prefix + entry.name] : []);
}

test('independent golden questions are exact and facts preserve the full store hash', async () => {
  const fixture = resolve(root, 'tests/fixtures/layered-app');
  const files = walk(fixture).filter(path => !path.startsWith('.'))
    .map(path => ({ path, content: readFileSync(resolve(fixture, path), 'utf8') }));
  const golden = JSON.parse(readFileSync(resolve(fixture, 'expected.json'), 'utf8'));
  const state = await setup(files);
  try {
    persistNativeRelations(state.db, await extractNativeCalls({ files }));
    const before = digest(state.db);
    for (const question of golden.questions) {
      if (['nearest_controller', 'entrypoint'].includes(question.type)) continue;
      const field = question.relationType === 'imports' ? 'imports'
        : ({ callers: 'callers', callees: 'callees', dependents: 'callers', dependencies: 'callees', tests: 'tests' })[question.type];
      const actual = buildFacts(state.store, question.target)[field].map(item => item.symbolKey ?? item.path);
      assert.deepEqual(actual, [...question.expected].sort(), question.id);
    }
    for (const depth of [0, -1, 1.5, null, '2', NaN]) {
      assert.throws(() => buildFacts(state.store, golden.questions[0].target, { depth }),
        { name: 'TypeError', message: `depth must be a positive integer, got ${String(depth)}` });
    }
    assert.equal(digest(state.db), before, 'facts changed rows/schema');
  } finally { state.db.close(); }
});

test('independent AST controls preserve original imports and never guess endpoints', async () => {
  const cases = [
    ['named aliases', 'import { Public as Local } from "./target";', 'class Internal {}\nexport { Internal as Public };', ['Internal']],
    ['default declaration', 'import Local from "./target";', 'export default class Original {}', ['Original']],
    ['default local expression', 'import Local from "./target";', 'class Original {}\nexport default Original;', ['Original']],
    ['type-only aliases', 'import type { Shape, Alias as Local } from "./target";', 'export interface Shape {}\ntype Internal = string;\nexport type { Internal as Alias };', ['Internal', 'Shape']],
    ['namespace/side effect', 'import * as NS from "./target";\nimport "./target";', 'export class Visible {}', []],
    ['duplicate exports', 'import { Public } from "./target";', 'class One {}\nclass Two {}\nexport { One as Public };\nexport { Two as Public };', []],
    ['canonical collision', 'import { Same } from "./target";', 'export function Same() {}\nexport function Same() {}', []],
    ['reexports', 'import { Remote } from "./target";', 'export { Remote } from "./other";', [], [{ path: 'other.ts', content: 'export class Remote {}' }]],
    ['anonymous default', 'import Local from "./target";', 'export default class {}', []],
    ['malformed target', 'import { Visible } from "./target";', 'export class Visible {', []],
    ['missing export', 'import { Missing } from "./target";', 'export class Other {}', []],
    ['duplicate canonical file', 'import { Visible } from "./target";', 'export class Visible {}', [], [{ path: './target.ts', content: 'export class Visible {}' }]],
  ];
  for (const [name, source, target, expected, extra = []] of cases) {
    const files = [{ path: 'caller.ts', content: `${source}\nexport class Caller {}` }, { path: 'target.ts', content: target }, ...extra];
    const state = await setup(files);
    try {
      const caller = state.graph.nodes.find(node => node.label === 'Caller').id;
      const got = buildFacts(state.store, caller).imports.map(item => item.symbolKey.split('|')[4]).sort();
      assert.deepEqual(got, [...expected].sort(), name);
      const stripped = { ...state.result, relations: state.result.relations.map(fact => ({ ...fact,
        bindings: fact.bindings.map(({ target, reason, ...binding }) => binding) })) };
      assert.deepEqual(stripped, await extractNativeImports({ files }), 'original import shape changed');
      const before = digest(state.db);
      buildFacts(state.store, caller);
      assert.equal(digest(state.db), before);
    } finally { state.db.close(); }
  }
});

test('independent persistence probes cover late SQL rollback, conflicts and legacy degradation', async () => {
  const state = await setup([
    { path: 'caller.ts', content: 'import { A } from "./target";\nimport { B as Local } from "./target";\nexport class Caller {}' },
    { path: 'target.ts', content: 'export class A {}\nexport class B {}' },
  ]);
  try {
    const first = state.store.listNativeImportBindings();
    assert.equal(first.length, 2);
    persistNativeRelations(state.db, state.result);
    assert.deepEqual(state.store.listNativeImportBindings(), first);
    const caller = state.graph.nodes.find(node => node.label === 'Caller').id;
    assert.deepEqual(buildFacts(state.store, caller).imports.map(item => item.symbolKey.split('|')[4]), ['A', 'B']);
    const rejects = [
      [result => { result.relations[1].bindings[0].target = 'raw-id'; }, 'native relation binding target must be a canonical endpoint object, got string'],
      [result => { result.relations[1].bindings[0].typeOnly = 'true'; }, 'native import bindings require file endpoints and valid syntax metadata'],
      [result => { result.relations[1].bindings[0].target.path = 'wrong.ts'; }, 'native import binding target must identify a symbol in its target file'],
      [result => { result.relations[1].bindings = null; }, 'native import bindings must be an array'],
    ];
    for (const [mutate, message] of rejects) {
      const bad = structuredClone(state.result); mutate(bad);
      const before = digest(state.db);
      assert.throws(() => persistNativeRelations(state.db, bad), { name: 'TypeError', message });
      assert.equal(digest(state.db), before);
    }
    state.db.exec(`CREATE TRIGGER reject_later BEFORE INSERT ON native_import_bindings
      WHEN NEW.evidence LIKE '%"local":"Local"%' BEGIN SELECT RAISE(ABORT, 'probe-later-binding'); END;`);
    const bad = structuredClone(state.result);
    for (const fact of bad.relations) fact.source.id = 'file|fresh.ts';
    const before = digest(state.db);
    assert.throws(() => persistNativeRelations(state.db, bad), { message: 'probe-later-binding' });
    assert.equal(digest(state.db), before, 'late SQL failure left earlier writes');
    state.db.exec('DROP TRIGGER reject_later');
    buildFromGraphJson(state.db, state.graph, 'rebuild');
    assert.deepEqual(state.store.listNativeImportBindings(), first);
    const conflict = structuredClone(state.result);
    conflict.relations = conflict.relations.slice(0, 1);
    conflict.relations[0].bindings[0].target = structuredClone(state.result.relations[1].bindings[0].target);
    persistNativeRelations(state.db, conflict);
    assert.equal(state.db.prepare('SELECT COUNT(*) AS n FROM native_import_bindings').get().n, 3);
    assert.equal(state.store.listNativeImportBindings().find(binding => binding.local === 'A').reason, 'ambiguous-binding-evidence');
    assert.deepEqual(buildFacts(state.store, caller).imports.map(item => item.symbolKey.split('|')[4]), ['B']);
    state.db.exec('DELETE FROM native_import_bindings');
    assert.deepEqual(buildFacts(state.store, caller).imports, []);
  } finally { state.db.close(); }
});
