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
const REPO = 'src/repositories/user.repository.ts';
const CONTROLLER = 'src/controllers/user.controller.ts';
const CLASS = 'ts|src/services/user.service.ts|class|exported|UserService|0';
const METHOD = 'ts|src/services/user.service.ts|method|member|UserService.findById|1';
const SERVICE_CTOR = 'ts|src/services/user.service.ts|method|member|UserService.constructor|1';
const REPO_CLASS = 'ts|src/repositories/user.repository.ts|class|exported|UserRepository|0';
const REPO_CTOR = 'ts|src/repositories/user.repository.ts|method|member|UserRepository.constructor|1';
const REPO_FIND = 'ts|src/repositories/user.repository.ts|method|member|UserRepository.findOne|1';
const CONTROLLER_CLASS = 'ts|src/controllers/user.controller.ts|class|exported|UserController|0';
const FOREIGN_FILE_KEY = 'ts|src/views/user.view.ts|function|exported|renderView|0';

const paths = [CONTROLLER, SERVICE, REPO, 'src/models/user.model.ts', 'src/utils/format.ts', 'tests/user.service.test.ts'];
const COMMUNITY_BY_PATH = { [SERVICE]: 1, [REPO]: 1, [CONTROLLER]: 2, 'src/models/user.model.ts': 3 };

async function setup({ extraNodes = [], mutateNodes = (nodes) => nodes } = {}) {
  const files = await Promise.all(paths.map(async path => ({ path,
    content: await readFile(new URL(`./fixtures/layered-app/${path}`, import.meta.url), 'utf8') })));
  const calls = await extractNativeCalls({ files });
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE nodes(id TEXT PRIMARY KEY,label TEXT,kind TEXT,source_file TEXT,community INTEGER,degree INTEGER,metadata TEXT); CREATE TABLE edges(source TEXT,target TEXT,relation TEXT); CREATE TABLE community_names(community_id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT,updated_at TEXT);');
  const nodes = mutateNodes(calls.symbols.map(symbol => ({ id: symbol.id, label: symbol.id.split('|')[4],
    kind: symbol.kind, source_file: symbol.path, community: COMMUNITY_BY_PATH[symbol.path] ?? null,
    metadata: { symbolKey: symbol.symbolKey } })));
  buildFromGraphJson(db, { nodes: [...nodes, ...extraNodes], links: [] }, 'community-card-fixture');
  const store = createSqliteGraphStore(db);
  store.persistNativeRelations(await extractNativeImports({ files }));
  const symbolKeys = new Set(nodes.map(node => node.metadata.symbolKey));
  return { db, store, symbolKeys };
}
const snapshot = db => JSON.stringify(['meta', 'nodes', 'edges', 'native_edges', 'native_import_bindings']
  .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
const narrative = (summary, mentions = []) => ({ summary, behavior: ['Behaves.'], sideEffects: [],
  errors: [], contracts: [], changeNotes: 'Stable.', mentions });
const load = () => import('../src/cards/community-card.mjs');

test('S19 community membership comes only from actual graph assignments; verified name, canonical order, provenance', async () => {
  const { store, symbolKeys } = await setup();
  store.upsertCommunityName('1', 'Persistence & Service');
  const { buildCommunityCard } = await load();
  const card = buildCommunityCard({ graphDb: store, communityId: 1, filePaths: [SERVICE, CONTROLLER, REPO], symbolKeys });
  assert.equal(card.kind, 'community-card');
  assert.equal(card.communityId, '1');
  assert.equal(card.name, 'Persistence & Service');
  assert.deepEqual(card.scannedFiles, [CONTROLLER, REPO, SERVICE]);
  assert.deepEqual(card.members, [
    { id: REPO_CLASS, symbolKey: REPO_CLASS, kind: 'class', path: REPO },
    { id: REPO_CTOR, symbolKey: REPO_CTOR, kind: 'method', path: REPO },
    { id: REPO_FIND, symbolKey: REPO_FIND, kind: 'method', path: REPO },
    { id: CLASS, symbolKey: CLASS, kind: 'class', path: SERVICE },
    { id: SERVICE_CTOR, symbolKey: SERVICE_CTOR, kind: 'method', path: SERVICE },
    { id: METHOD, symbolKey: METHOD, kind: 'method', path: SERVICE },
  ]);
  // Controller symbols live in a scanned file but carry community 2: never listed.
  assert.ok(!card.members.some(member => member.symbolKey.startsWith('ts|src/controllers')));
  assert.deepEqual(card.narratives, []);
  assert.equal(card.text, '');
  assert.deepEqual(card.rejected, []);
  // Deterministic: independent of filePaths input order, byte-stable across calls.
  const shuffled = buildCommunityCard({ graphDb: store, communityId: 1,
    filePaths: [REPO, SERVICE, CONTROLLER], symbolKeys });
  assert.equal(JSON.stringify(shuffled), JSON.stringify(card));
});

test('S19 absent community name stays honestly null; unknown community is an honest empty card', async () => {
  const { store, symbolKeys } = await setup();
  const { buildCommunityCard } = await load();
  const unnamed = buildCommunityCard({ graphDb: store, communityId: 3, filePaths: ['src/models/user.model.ts'], symbolKeys });
  assert.equal(unnamed.name, null);
  assert.equal(unnamed.members.length, 3);
  const empty = buildCommunityCard({ graphDb: store, communityId: 99, filePaths: [SERVICE], symbolKeys });
  assert.deepEqual(empty, { kind: 'community-card', communityId: '99', name: null, scannedFiles: [SERVICE],
    members: [], narratives: [], text: '', rejected: [] });
});

test('S19 honest rejected/missing membership: unknown file, ambiguous keys, non-member narratives, verbatim provenance', async () => {
  const { store, symbolKeys } = await setup({
    extraNodes: [{ id: `${CLASS}#dup`, label: 'UserService', kind: 'class', source_file: SERVICE,
      community: 1, metadata: { symbolKey: CLASS } }],
  });
  store.upsertCommunityName('1', 'Persistence & Service');
  const { buildCommunityCard } = await load();
  const entries = [
    { symbolKey: METHOD, narrative: narrative('Devuelve un usuario por id.') },
    { symbolKey: CLASS, narrative: narrative('Duplicate-key member narrative.') },
    { symbolKey: CONTROLLER_CLASS, narrative: narrative('Scanned but other community.') },
    { symbolKey: FOREIGN_FILE_KEY, narrative: narrative('Canonical but unscanned file.') },
    { symbolKey: 'node_42', narrative: narrative('Raw id narrative.') },
    { symbolKey: REPO_FIND, narrative: narrative(`${Array(26).fill('word').join(' ')}`) },
  ];
  const card = buildCommunityCard({ graphDb: store, communityId: 1, filePaths: [SERVICE, 'src/missing.ts', REPO],
    narratives: entries, symbolKeys });
  // The ambiguous canonical key is withheld from members AND from narratives.
  assert.ok(!card.members.some(member => member.symbolKey === CLASS));
  assert.ok(!card.narratives.some(item => item.symbolKey === CLASS));
  assert.deepEqual(card.narratives, [{ symbolKey: METHOD, summary: 'Devuelve un usuario por id.' }]);
  assert.equal(card.text, `- ${METHOD}: Devuelve un usuario por id.`);
  const rejected = new Map(card.rejected.map(item => [`${item.member}|${item.reason}`, item]));
  assert.ok(rejected.has(`${CLASS}|ambiguous-symbol-key`));
  assert.ok(rejected.has('file|src/missing.ts|file-not-in-graph'));
  assert.equal(rejected.get(`${CONTROLLER_CLASS}|symbol-not-in-community`).reason, 'symbol-not-in-community');
  assert.equal(rejected.get(`${FOREIGN_FILE_KEY}|symbol-not-in-community`).reason, 'symbol-not-in-community');
  assert.equal(rejected.get('node_42|non-canonical-symbol-key').reason, 'non-canonical-symbol-key');
  assert.equal(rejected.get(`${REPO_FIND}|invalid-narrative`).reason, 'invalid-narrative');
  assert.ok(rejected.get(`${REPO_FIND}|invalid-narrative`).errors
    .includes('summary must contain at most 25 words'));
  // Deterministic rejected ordering, independent of narrative input order.
  const shuffled = buildCommunityCard({ graphDb: store, communityId: 1,
    filePaths: ['src/missing.ts', REPO, SERVICE], narratives: [...entries].reverse(), symbolKeys });
  assert.equal(JSON.stringify(shuffled), JSON.stringify(card));
});

test('S19 programming-error shapes fail closed with TypeError before any side effect', async () => {
  const { store, symbolKeys } = await setup();
  const { buildCommunityCard } = await load();
  const good = { symbolKey: METHOD, narrative: narrative('Valid.') };
  assert.throws(() => buildCommunityCard({ communityId: 1, filePaths: [SERVICE] }), TypeError);
  assert.throws(() => buildCommunityCard({ graphDb: {}, communityId: 1, filePaths: [SERVICE] }), TypeError);
  assert.throws(() => buildCommunityCard({ graphDb: { getNodesByFile: () => [] }, communityId: 1, filePaths: [SERVICE] }), TypeError);
  for (const communityId of ['', null, undefined, {}, [], true, NaN, Infinity]) {
    assert.throws(() => buildCommunityCard({ graphDb: store, communityId, filePaths: [SERVICE] }), TypeError);
  }
  assert.throws(() => buildCommunityCard({ graphDb: store, communityId: 1 }), TypeError);
  assert.throws(() => buildCommunityCard({ graphDb: store, communityId: 1, filePaths: 'nope' }), TypeError);
  assert.throws(() => buildCommunityCard({ graphDb: store, communityId: 1, filePaths: [''] }), TypeError);
  assert.throws(() => buildCommunityCard({ graphDb: store, communityId: 1, filePaths: ['/etc/passwd'] }), TypeError);
  assert.throws(() => buildCommunityCard({ graphDb: store, communityId: 1, filePaths: ['../escape.ts'] }), TypeError);
  assert.throws(() => buildCommunityCard({ graphDb: store, communityId: 1, filePaths: [SERVICE], narratives: 'nope' }), TypeError);
  assert.throws(() => buildCommunityCard({ graphDb: store, communityId: 1, filePaths: [SERVICE], narratives: [null] }), TypeError);
  assert.throws(() => buildCommunityCard({ graphDb: store, communityId: 1, filePaths: [SERVICE], narratives: [{ narrative: narrative('x') }] }), TypeError);
  assert.throws(() => buildCommunityCard({ graphDb: store, communityId: 1, filePaths: [SERVICE], narratives: [{ symbolKey: METHOD }] }), TypeError);
  assert.throws(() => buildCommunityCard({ graphDb: store, communityId: 1, filePaths: [SERVICE], narratives: [{ symbolKey: '', narrative: narrative('x') }] }), TypeError);
  assert.throws(() => buildCommunityCard({ graphDb: store, communityId: 1, filePaths: [SERVICE], narratives: [good, good] }), TypeError);
  assert.throws(() => buildCommunityCard({ graphDb: store, communityId: 1, filePaths: [SERVICE], narratives: [], symbolKeys: 'x' }), TypeError);
});

test('S19 inputs stay immutable, store bytes and existing file/rollup cards stay unchanged', async () => {
  const { db, store, symbolKeys } = await setup();
  const { buildCommunityCard } = await load();
  try {
    const before = snapshot(db);
    const fileCard = buildFileCard(store, SERVICE);
    const rollup = buildFileNarrativeRollup({ graphDb: store, filePath: SERVICE, symbolKeys });
    const fileCardExpected = structuredClone(fileCard);
    const rollupExpected = structuredClone(rollup);
    const entries = [{ symbolKey: METHOD, narrative: narrative('Opted in.') }];
    const filePaths = [SERVICE, REPO];
    const beforeCall = JSON.stringify({ entries, filePaths, symbolKeys: [...symbolKeys] });
    for (const entry of entries) { Object.freeze(entry.narrative); Object.freeze(entry); }
    Object.freeze(entries); Object.freeze(filePaths);
    const card = buildCommunityCard({ graphDb: store, communityId: 1, filePaths, narratives: entries, symbolKeys });
    assert.equal(card.narratives.length, 1);
    assert.equal(JSON.stringify({ entries, filePaths, symbolKeys: [...symbolKeys] }), beforeCall);
    assert.deepEqual(buildFileCard(store, SERVICE), fileCardExpected);
    assert.deepEqual(buildFileNarrativeRollup({ graphDb: store, filePath: SERVICE, symbolKeys }), rollupExpected);
    assert.equal(snapshot(db), before);
  } finally { db.close(); }
});

test('S19 public surface is a synchronous pure function with no I/O or provider imports', async () => {
  const { buildCommunityCard } = await load();
  assert.equal(typeof buildCommunityCard, 'function');
  assert.equal(buildCommunityCard.constructor.name, 'Function');
  const source = await readFile(new URL('../src/cards/community-card.mjs', import.meta.url), 'utf8');
  const specifiers = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1]);
  assert.deepEqual([...new Set(specifiers)].sort(),
    ['./file-card.mjs', './narrative-schema.mjs', './prompt-v2.mjs']);
});
