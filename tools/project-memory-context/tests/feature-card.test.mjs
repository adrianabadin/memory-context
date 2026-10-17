import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { buildFileCard } from '../src/cards/file-card.mjs';
import { buildFileNarrativeRollup } from '../src/cards/file-rollup.mjs';
import { buildFromGraphJson, createSqliteGraphStore } from '../src/graph-store/graph-db.mjs';
import { extractNativeCalls } from '../src/relations/native-calls.mjs';
import { extractNativeImports } from '../src/relations/native-imports.mjs';

const SERVICE = 'src/services/user.service.ts';
const CLASS = 'ts|src/services/user.service.ts|class|exported|UserService|0';
const METHOD = 'ts|src/services/user.service.ts|method|member|UserService.findById|1';
const REPO_CLASS = 'ts|src/repositories/user.repository.ts|class|exported|UserRepository|0';
const CONTROLLER_CLASS = 'ts|src/controllers/user.controller.ts|class|exported|UserController|0';
const ABSENT_KEY = 'ts|src/services/user.service.ts|class|exported|UserServiceLegacy|0';
const MISSING_KEY = 'ts|src/views/user.view.ts|function|exported|renderView|0';
const MODEL_FILE = 'file|src/models/user.model.ts';

const paths = ['src/controllers/user.controller.ts', SERVICE, 'src/repositories/user.repository.ts',
  'src/models/user.model.ts', 'src/utils/format.ts', 'tests/user.service.test.ts'];

async function setup({ extraNodes = [], mutateNodes = (nodes) => nodes } = {}) {
  const files = await Promise.all(paths.map(async path => ({ path,
    content: await readFile(new URL(`./fixtures/layered-app/${path}`, import.meta.url), 'utf8') })));
  const calls = await extractNativeCalls({ files });
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE nodes(id TEXT PRIMARY KEY,label TEXT,kind TEXT,source_file TEXT,community INTEGER,degree INTEGER,metadata TEXT); CREATE TABLE edges(source TEXT,target TEXT,relation TEXT);');
  const nodes = mutateNodes(calls.symbols.map(symbol => ({ id: symbol.id, label: symbol.id.split('|')[4],
    kind: symbol.kind, source_file: symbol.path, metadata: { symbolKey: symbol.symbolKey } })));
  buildFromGraphJson(db, { nodes: [...nodes, ...extraNodes], links: [] }, 'feature-card-fixture');
  const store = createSqliteGraphStore(db);
  store.persistNativeRelations(await extractNativeImports({ files }));
  const symbolKeys = new Set(nodes.map(node => node.metadata.symbolKey));
  return { db, store, symbolKeys };
}
const snapshot = db => JSON.stringify(['meta', 'nodes', 'edges', 'native_edges', 'native_import_bindings']
  .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
const narrative = (summary, mentions = []) => ({ summary, behavior: ['Behaves.'], sideEffects: [],
  errors: [], contracts: [], changeNotes: 'Stable.', mentions });
const load = () => import('../src/cards/feature-card.mjs');

test('S19 explicit feature membership verifies caller-declared symbol AND file keys against the graph', async () => {
  const { store, symbolKeys } = await setup();
  const { buildFeatureCard } = await load();
  const card = buildFeatureCard({ graphDb: store, name: 'User management', symbolKeys,
    members: [METHOD, MODEL_FILE, REPO_CLASS, CLASS, MISSING_KEY] });
  assert.equal(card.kind, 'feature-card');
  assert.equal(card.name, 'User management');
  assert.deepEqual(card.symbols, [
    { id: REPO_CLASS, symbolKey: REPO_CLASS, kind: 'class', path: 'src/repositories/user.repository.ts' },
    { id: CLASS, symbolKey: CLASS, kind: 'class', path: SERVICE },
    { id: METHOD, symbolKey: METHOD, kind: 'method', path: SERVICE },
  ]);
  assert.deepEqual(card.files, [{ id: MODEL_FILE, path: 'src/models/user.model.ts', kind: 'file' }]);
  assert.equal(card.rejected.length, 1);
  assert.deepEqual(card.rejected[0], { member: MISSING_KEY, reason: 'symbol-not-in-graph' });
  assert.deepEqual(card.narratives, []);
  assert.equal(card.text, '');
  // Deterministic: independent of member input order, byte-stable across calls.
  const shuffled = buildFeatureCard({ graphDb: store, name: 'User management', symbolKeys,
    members: [MISSING_KEY, CLASS, REPO_CLASS, MODEL_FILE, METHOD] });
  assert.equal(JSON.stringify(shuffled), JSON.stringify(card));
});

test('S19 honest rejected membership: non-canonical keys, unknown files, ambiguous and stale identities', async () => {
  const { store, symbolKeys } = await setup({
    extraNodes: [
      { id: `${CLASS}#dup`, label: 'UserService', kind: 'class', source_file: SERVICE,
        metadata: { symbolKey: CLASS } },
      // Stale identity: node id claims a canonical key its metadata contradicts.
      { id: ABSENT_KEY, label: 'UserServiceLegacy', kind: 'class', source_file: SERVICE,
        metadata: { symbolKey: 'ts|src/services/user.service.ts|class|exported|UserServiceStale|0' } },
    ],
  });
  const { buildFeatureCard } = await load();
  const card = buildFeatureCard({ graphDb: store, name: 'Stale probe', symbolKeys,
    members: [ABSENT_KEY, CLASS, 'node_7', 'file|src/missing.ts', 'whatever', '/etc/passwd'] });
  // Ambiguous canonical key withheld from symbols; stale id never verifies.
  assert.deepEqual(card.symbols, []);
  const rejected = new Map(card.rejected.map(item => [`${item.member}|${item.reason}`, item]));
  assert.ok(rejected.has(`${CLASS}|ambiguous-symbol-key`));
  assert.ok(rejected.has(`${ABSENT_KEY}|symbol-not-in-graph`));
  assert.ok(rejected.has('node_7|non-canonical-member-key'));
  assert.ok(rejected.has('whatever|non-canonical-member-key'));
  assert.ok(rejected.has('/etc/passwd|non-canonical-member-key'));
  assert.ok(rejected.has('file|src/missing.ts|file-not-in-graph'));
  assert.equal(card.rejected.length, 6);
});

test('S19 narratives aggregate only verified members with verbatim provenance and explicit rejections', async () => {
  const { store, symbolKeys } = await setup();
  const { buildFeatureCard } = await load();
  const entries = [
    { symbolKey: METHOD, narrative: narrative('Devuelve un usuario por id.') },
    { symbolKey: CLASS, narrative: narrative('UserService gestiona el acceso — verbatim.') },
    { symbolKey: REPO_CLASS, narrative: narrative(`${Array(26).fill('word').join(' ')}`) },
    { symbolKey: CONTROLLER_CLASS, narrative: narrative('Declared nowhere.') },
    { symbolKey: 'node_42', narrative: narrative('Raw id narrative.') },
  ];
  const card = buildFeatureCard({ graphDb: store, name: 'User management', symbolKeys,
    members: [CLASS, METHOD, REPO_CLASS], narratives: entries });
  assert.deepEqual(card.narratives, [
    { symbolKey: CLASS, summary: 'UserService gestiona el acceso — verbatim.' },
    { symbolKey: METHOD, summary: 'Devuelve un usuario por id.' },
  ]);
  assert.equal(card.text,
    `- ${CLASS}: UserService gestiona el acceso — verbatim.\n- ${METHOD}: Devuelve un usuario por id.`);
  const rejected = new Map(card.rejected.map(item => [`${item.member}|${item.reason}`, item]));
  assert.ok(rejected.has(`${CONTROLLER_CLASS}|symbol-not-in-feature`));
  assert.equal(rejected.get(`${REPO_CLASS}|invalid-narrative`).reason, 'invalid-narrative');
  assert.ok(rejected.get(`${REPO_CLASS}|invalid-narrative`).errors
    .includes('summary must contain at most 25 words'));
  assert.equal(rejected.get('node_42|non-canonical-symbol-key').reason, 'non-canonical-symbol-key');
  // Deterministic: independent of narrative input order, byte-stable across calls.
  const shuffled = buildFeatureCard({ graphDb: store, name: 'User management', symbolKeys,
    members: [REPO_CLASS, METHOD, CLASS], narratives: [...entries].reverse() });
  assert.equal(JSON.stringify(shuffled), JSON.stringify(card));
});

test('S19 malformed inputs fail closed with TypeError and an empty feature stays honest', async () => {
  const { store, symbolKeys } = await setup();
  const { buildFeatureCard } = await load();
  const good = { symbolKey: METHOD, narrative: narrative('Valid.') };
  assert.throws(() => buildFeatureCard({ members: [CLASS] }), TypeError);
  assert.throws(() => buildFeatureCard({ graphDb: {}, name: 'x', members: [CLASS] }), TypeError);
  for (const name of ['', null, undefined, {}, [], 7]) {
    assert.throws(() => buildFeatureCard({ graphDb: store, name, members: [CLASS] }), TypeError);
  }
  assert.throws(() => buildFeatureCard({ graphDb: store, name: 'x' }), TypeError);
  assert.throws(() => buildFeatureCard({ graphDb: store, name: 'x', members: 'nope' }), TypeError);
  assert.throws(() => buildFeatureCard({ graphDb: store, name: 'x', members: [''] }), TypeError);
  assert.throws(() => buildFeatureCard({ graphDb: store, name: 'x', members: [null, CLASS] }), TypeError);
  assert.throws(() => buildFeatureCard({ graphDb: store, name: 'x', members: [CLASS, CLASS] }), TypeError);
  assert.throws(() => buildFeatureCard({ graphDb: store, name: 'x', members: ['file|../escape.ts'] }), TypeError);
  assert.throws(() => buildFeatureCard({ graphDb: store, name: 'x', members: [CLASS], narratives: 'nope' }), TypeError);
  assert.throws(() => buildFeatureCard({ graphDb: store, name: 'x', members: [CLASS], narratives: [{ symbolKey: CLASS }] }), TypeError);
  assert.throws(() => buildFeatureCard({ graphDb: store, name: 'x', members: [CLASS], narratives: [good, good] }), TypeError);
  assert.throws(() => buildFeatureCard({ graphDb: store, name: 'x', members: [CLASS], narratives: [], symbolKeys: 'x' }), TypeError);
  const empty = buildFeatureCard({ graphDb: store, name: 'Nothing yet', members: [], symbolKeys });
  assert.deepEqual(empty, { kind: 'feature-card', name: 'Nothing yet', symbols: [], files: [],
    narratives: [], text: '', rejected: [] });
});

test('S19 inputs stay immutable, store bytes and existing file/rollup cards stay unchanged', async () => {
  const { db, store, symbolKeys } = await setup();
  const { buildFeatureCard } = await load();
  try {
    const before = snapshot(db);
    const fileCard = buildFileCard(store, SERVICE);
    const rollup = buildFileNarrativeRollup({ graphDb: store, filePath: SERVICE, symbolKeys });
    const fileCardExpected = structuredClone(fileCard);
    const rollupExpected = structuredClone(rollup);
    const members = [CLASS, METHOD, MODEL_FILE];
    const entries = [{ symbolKey: METHOD, narrative: narrative('Opted in.') }];
    const beforeCall = JSON.stringify({ members, entries, symbolKeys: [...symbolKeys] });
    for (const entry of entries) { Object.freeze(entry.narrative); Object.freeze(entry); }
    Object.freeze(entries); Object.freeze(members);
    const card = buildFeatureCard({ graphDb: store, name: 'User management', symbolKeys, members, narratives: entries });
    assert.equal(card.narratives.length, 1);
    assert.equal(JSON.stringify({ members, entries, symbolKeys: [...symbolKeys] }), beforeCall);
    assert.deepEqual(buildFileCard(store, SERVICE), fileCardExpected);
    assert.deepEqual(buildFileNarrativeRollup({ graphDb: store, filePath: SERVICE, symbolKeys }), rollupExpected);
    assert.equal(snapshot(db), before);
  } finally { db.close(); }
});

test('S19 public surface is a synchronous pure function with no I/O or provider imports', async () => {
  const { buildFeatureCard } = await load();
  assert.equal(typeof buildFeatureCard, 'function');
  assert.equal(buildFeatureCard.constructor.name, 'Function');
  const source = await readFile(new URL('../src/cards/feature-card.mjs', import.meta.url), 'utf8');
  const specifiers = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1]);
  assert.deepEqual([...new Set(specifiers)].sort(),
    ['./file-card.mjs', './narrative-schema.mjs', './prompt-v2.mjs']);
});
