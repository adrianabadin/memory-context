import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { buildFileCard } from '../src/cards/file-card.mjs';
import { buildFromGraphJson, createSqliteGraphStore } from '../src/graph-store/graph-db.mjs';
import { extractNativeCalls } from '../src/relations/native-calls.mjs';
import { extractNativeImports } from '../src/relations/native-imports.mjs';

const SERVICE = 'src/services/user.service.ts';
const CLASS = 'ts|src/services/user.service.ts|class|exported|UserService|0';
const METHOD = 'ts|src/services/user.service.ts|method|member|UserService.findById|1';
const CONSTRUCTOR = 'ts|src/services/user.service.ts|method|member|UserService.constructor|1';
const FOREIGN = 'ts|src/controllers/user.controller.ts|class|exported|UserController|0';
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
  buildFromGraphJson(db, { nodes, links: [] }, 'file-rollup-fixture');
  const store = createSqliteGraphStore(db);
  store.persistNativeRelations(await extractNativeImports({ files }));
  const symbolKeys = new Set(nodes.map(node => node.metadata.symbolKey));
  return { db, store, symbolKeys, nodes };
}
const snapshot = db => JSON.stringify(['meta', 'nodes', 'edges', 'native_edges', 'native_import_bindings']
  .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
const narrative = (summary, mentions = []) => ({ summary, behavior: ['Behaves.'], sideEffects: [],
  errors: [], contracts: [], changeNotes: 'Stable.', mentions });
const load = () => import('../src/cards/file-rollup.mjs');

test('S18 deterministic canonical ordering, verbatim summaries and explicit provenance', async () => {
  const { store, symbolKeys } = await setup();
  const { buildFileNarrativeRollup } = await load();
  const summaryClass = 'UserService  gestiona el acceso — verbatim.';
  const summaryMethod = 'Devuelve un usuario por id.';
  const entries = [
    { symbolKey: METHOD, narrative: narrative(summaryMethod) },
    { symbolKey: CLASS, narrative: narrative(summaryClass, [METHOD]) },
  ];
  const rollup = buildFileNarrativeRollup({ graphDb: store, filePath: SERVICE, narratives: entries, symbolKeys });
  assert.deepEqual(rollup, {
    path: SERVICE,
    kind: 'file-narrative-rollup',
    narratives: [
      { symbolKey: CLASS, summary: summaryClass },
      { symbolKey: METHOD, summary: summaryMethod },
    ],
    text: `- ${CLASS}: ${summaryClass}\n- ${METHOD}: ${summaryMethod}`,
    rejected: [],
  });
  // Canonical ascending symbolKey order, independent of input order; byte-stable across calls.
  const shuffled = buildFileNarrativeRollup({ graphDb: store, filePath: SERVICE,
    narratives: [entries[1], entries[0]], symbolKeys });
  assert.equal(JSON.stringify(shuffled), JSON.stringify(rollup));
});

test('S18 rejected data is explicit and never becomes rollup content; inputs stay immutable', async () => {
  const { store, symbolKeys } = await setup();
  const { buildFileNarrativeRollup } = await load();
  const tooLong = `${Array(26).fill('word').join(' ')}`;
  const badMention = narrative('Mentions an unknown key.', ['node_999']);
  const entries = [
    { symbolKey: CLASS, narrative: narrative('Valid class narrative.') },
    { symbolKey: METHOD, narrative: narrative(tooLong) },
    { symbolKey: FOREIGN, narrative: narrative('Foreign but valid narrative.') },
    { symbolKey: 'node_42', narrative: narrative('Raw id narrative.') },
    { symbolKey: CONSTRUCTOR, narrative: badMention },
  ];
  const before = JSON.stringify({ entries, symbolKeys: [...symbolKeys] });
  for (const entry of entries) { Object.freeze(entry.narrative); Object.freeze(entry); }
  Object.freeze(entries);
  const rollup = buildFileNarrativeRollup({ graphDb: store, filePath: SERVICE, narratives: entries, symbolKeys });
  assert.deepEqual(rollup.narratives, [{ symbolKey: CLASS, summary: 'Valid class narrative.' }]);
  assert.equal(rollup.text, `- ${CLASS}: Valid class narrative.`);
  const rejected = new Map(rollup.rejected.map(item => [item.symbolKey, item]));
  assert.equal(rejected.get(METHOD).reason, 'invalid-narrative');
  assert.ok(rejected.get(METHOD).errors.includes('summary must contain at most 25 words'));
  assert.equal(rejected.get(FOREIGN).reason, 'symbol-not-in-file');
  assert.equal(rejected.get('node_42').reason, 'non-canonical-symbol-key');
  assert.equal(rejected.get(CONSTRUCTOR).reason, 'invalid-narrative');
  assert.ok(rejected.get(CONSTRUCTOR).errors
    .includes('Mention does not exist in graph: node_999'));
  assert.equal(rollup.rejected.length, 4);
  assert.equal(JSON.stringify({ entries, symbolKeys: [...symbolKeys] }), before);
});

test('S18 programming-error shapes and duplicate symbol keys fail closed with TypeError', async () => {
  const { store, symbolKeys } = await setup();
  const { buildFileNarrativeRollup } = await load();
  const good = { symbolKey: CLASS, narrative: narrative('Valid.') };
  assert.throws(() => buildFileNarrativeRollup({ graphDb: store, filePath: SERVICE, narratives: 'nope', symbolKeys }), TypeError);
  assert.throws(() => buildFileNarrativeRollup({ graphDb: store, filePath: SERVICE, narratives: [null], symbolKeys }), TypeError);
  assert.throws(() => buildFileNarrativeRollup({ graphDb: store, filePath: SERVICE, narratives: ['nope'], symbolKeys }), TypeError);
  assert.throws(() => buildFileNarrativeRollup({ graphDb: store, filePath: SERVICE, narratives: [{ narrative: narrative('x') }], symbolKeys }), TypeError);
  assert.throws(() => buildFileNarrativeRollup({ graphDb: store, filePath: SERVICE, narratives: [{ symbolKey: CLASS }], symbolKeys }), TypeError);
  assert.throws(() => buildFileNarrativeRollup({ graphDb: store, filePath: SERVICE, narratives: [good, good], symbolKeys }), TypeError);
  assert.throws(() => buildFileNarrativeRollup({ graphDb: store, filePath: SERVICE, narratives: [], symbolKeys: 'x' }), TypeError);
  assert.throws(() => buildFileNarrativeRollup({ graphDb: {}, filePath: SERVICE }), TypeError);
  assert.throws(() => buildFileNarrativeRollup({ graphDb: store, filePath: '' }), TypeError);
});

test('S18 empty and missing-narrative behavior stays honest for known and unknown files', async () => {
  const { store, symbolKeys } = await setup();
  const { buildFileNarrativeRollup } = await load();
  const empty = buildFileNarrativeRollup({ graphDb: store, filePath: SERVICE, symbolKeys });
  assert.deepEqual(empty, { path: SERVICE, kind: 'file-narrative-rollup', narratives: [], text: '', rejected: [] });
  assert.deepEqual(buildFileNarrativeRollup({ graphDb: store, filePath: SERVICE, narratives: [], symbolKeys }), empty);
  const unknown = buildFileNarrativeRollup({ graphDb: store, filePath: 'src/missing.ts',
    narratives: [{ symbolKey: CLASS, narrative: narrative('Valid but elsewhere.') }], symbolKeys });
  assert.deepEqual(unknown, { path: 'src/missing.ts', kind: 'file-narrative-rollup', narratives: [], text: '',
    rejected: [{ symbolKey: CLASS, reason: 'symbol-not-in-file' }] });
});

test('S18 optional rollup preserves previous file-card output and store bytes exactly', async () => {
  const { db, store, symbolKeys } = await setup();
  const { buildFileNarrativeRollup } = await load();
  try {
    const before = snapshot(db);
    const card = buildFileCard(store, SERVICE);
    const expected = structuredClone(card);
    assert.deepEqual(Object.keys(card), ['path', 'kind', 'exports', 'importsFrom', 'importedBy', 'symbolCount', 'members']);
    buildFileNarrativeRollup({ graphDb: store, filePath: SERVICE, symbolKeys });
    buildFileNarrativeRollup({ graphDb: store, filePath: SERVICE,
      narratives: [{ symbolKey: CLASS, narrative: narrative('Opted in.') }], symbolKeys });
    assert.deepEqual(buildFileCard(store, SERVICE), expected);
    assert.equal(snapshot(db), before);
  } finally { db.close(); }
});

test('S18 public surface is a synchronous pure function with no I/O or provider imports', async () => {
  const { buildFileNarrativeRollup } = await load();
  assert.equal(typeof buildFileNarrativeRollup, 'function');
  assert.equal(buildFileNarrativeRollup.constructor.name, 'Function');
  const source = await readFile(new URL('../src/cards/file-rollup.mjs', import.meta.url), 'utf8');
  const specifiers = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1]);
  assert.deepEqual([...new Set(specifiers)].sort(),
    ['./file-card.mjs', './narrative-schema.mjs', './prompt-v2.mjs']);
});
