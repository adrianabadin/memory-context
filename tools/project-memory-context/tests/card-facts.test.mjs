// tools/project-memory-context/tests/card-facts.test.mjs
//
// Task 1.3: the facts builder reads canonical native endpoints back from the
// GraphStore (nodes table as the symbol registry + the unit-C `native_edges`
// seam) and answers the golden relational questions of
// tests/fixtures/layered-app/expected.json that the facts shape can express.
// The store is assembled exactly the way production assembles it: the two
// native extractors run over the fixture sources, registry symbols become
// graph nodes, and both extractor results persist through the fail-closed
// `persistNativeRelations` seam (no bespoke persistence in this test).
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import { buildFromGraphJson, createSqliteGraphStore } from '../src/graph-store/graph-db.mjs';
import { NATIVE_EDGES_SCHEMA_SQL, persistNativeRelations } from '../src/graph-store/native-relations.mjs';
import { extractNativeCalls } from '../src/relations/native-calls.mjs';
import { extractNativeImportBindings } from '../src/relations/native-import-bindings.mjs';
import { buildFacts } from '../src/cards/facts.mjs';

// ── Fixture store ─────────────────────────────────────────────────────────────

const FIXTURE_PATHS = [
  'src/cli/main.ts',
  'src/controllers/user.controller.ts',
  'src/services/user.service.ts',
  'src/repositories/user.repository.ts',
  'src/db/client.ts',
  'src/models/user.model.ts',
  'src/interfaces/user-repository.ts',
  'src/utils/format.ts',
  'src/views/user.view.ts',
  'tests/user.service.test.ts',
];

const FIND_BY_ID = 'ts|src/services/user.service.ts|method|member|UserService.findById|1';
const GET_USER = 'ts|src/controllers/user.controller.ts|method|member|UserController.getUser|1';
const TEST_FN = 'ts|tests/user.service.test.ts|function|exported|testUserService|0';
const FIND_ONE = 'ts|src/repositories/user.repository.ts|method|member|UserRepository.findOne|1';
const QUERY = 'ts|src/db/client.ts|method|member|DatabaseClient.query|2';
const USER_ENTITY_CONSTRUCTOR = 'ts|src/models/user.model.ts|method|member|UserEntity.constructor|3';
const FORMAT = 'ts|src/utils/format.ts|function|exported|formatName|1';
const RENDER = 'ts|src/views/user.view.ts|function|exported|renderUser|1';
const MAIN = 'ts|src/cli/main.ts|function|exported|main|0';
const USER_SERVICE = 'ts|src/services/user.service.ts|class|exported|UserService|0';
const USER_CONTROLLER = 'ts|src/controllers/user.controller.ts|class|exported|UserController|0';
const USER_REPOSITORY = 'ts|src/repositories/user.repository.ts|class|exported|UserRepository|0';
const USER = 'ts|src/models/user.model.ts|interface|exported|User|0';
const USER_ENTITY = 'ts|src/models/user.model.ts|class|exported|UserEntity|0';

let store;

before(async () => {
  const files = [];
  for (const path of FIXTURE_PATHS) {
    files.push({ path, content: await readFile(new URL(`./fixtures/layered-app/${path}`, import.meta.url), 'utf8') });
  }
  const calls = await extractNativeCalls({ files });
  const imports = await extractNativeImportBindings({ files });

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

  // The registry endpoints become the graph nodes: id = symbolKey, so
  // getNode/getNodesByFile answer identity and file membership.
  const nodes = calls.symbols.map((endpoint) => {
    const [lang, path, kind, scope, name, arity] = endpoint.symbolKey.split('|');
    return {
      id: endpoint.symbolKey,
      label: name,
      kind: endpoint.kind,
      source_file: endpoint.path,
      metadata: { symbolKey: endpoint.symbolKey },
    };
  });
  buildFromGraphJson(db, { nodes, links: [] }, 'card-facts-fixture');

  persistNativeRelations(db, calls);
  persistNativeRelations(db, imports);
  store = createSqliteGraphStore(db);
});

const callsItem = (symbolKey, kind) => ({ symbolKey, relation: 'calls', kind });

// ── Golden questions (expected.json is authoritative) ─────────────────────────

test('q1: callers of UserService.findById are exactly UserController.getUser and the test function', () => {
  const facts = buildFacts(store, FIND_BY_ID);
  assert.deepEqual(facts.callers, [callsItem(GET_USER, 'method'), callsItem(TEST_FN, 'function')]);
});

test('q2: callees of UserService.findById are exactly UserRepository.findOne and formatName', () => {
  const facts = buildFacts(store, FIND_BY_ID);
  assert.deepEqual(facts.callees, [callsItem(FIND_ONE, 'method'), callsItem(FORMAT, 'function')]);
});

test('q9/q10: findOne callers/callees are exact; constructor instantiation stays a store edge, never a callee', () => {
  const facts = buildFacts(store, FIND_ONE);
  assert.deepEqual(facts.callers, [callsItem(FIND_BY_ID, 'method')]);
  assert.deepEqual(facts.callees, [callsItem(QUERY, 'method')]);
  // Non-vacuous proof: the instantiation edge exists in the store; facts list
  // it under neither callers nor callees (construction, not a named call).
  const edges = store.getNativeEdgesFor(FIND_ONE);
  assert.ok(edges.some((e) => e.relation === 'calls' && e.target.id === USER_ENTITY_CONSTRUCTOR));
});

test('q3/q4/q5/q6: remaining one-hop golden questions are answered exactly', () => {
  // q3 — dependents of formatName are findById and renderUser.
  assert.deepEqual(buildFacts(store, FORMAT).callers, [callsItem(FIND_BY_ID, 'method'), callsItem(RENDER, 'function')]);
  // q4 — nothing calls main.
  assert.deepEqual(buildFacts(store, MAIN).callers, []);
  // q5 — callees of main at the default depth: the constructor edge from
  // `new UserController()` must not appear as a named callee.
  assert.deepEqual(buildFacts(store, MAIN).callees, [callsItem(GET_USER, 'method')]);
  // q6 — renderUser depends on formatName.
  assert.deepEqual(buildFacts(store, RENDER).callees, [callsItem(FORMAT, 'function')]);
});

test('q12 + plan example: tests are the test-file symbols exercising the target file', () => {
  const forClass = buildFacts(store, USER_SERVICE).tests;
  assert.deepEqual(forClass, [{ symbolKey: TEST_FN, relation: 'tests', kind: 'function' }]);

  const forMember = buildFacts(store, FIND_BY_ID).tests;
  assert.deepEqual(forMember, [{ symbolKey: TEST_FN, relation: 'tests', kind: 'function' }]);
  // The plan's illustrative tests example names the test FILE; the golden
  // answer is the test symbol living in that file, so the entry must be
  // file-scoped to tests/user.service.test.ts.
  assert.ok(forMember.every((item) => item.symbolKey.startsWith('ts|tests/user.service.test.ts|')));
});

test('q11: symbol imports match the unchanged golden exactly', async () => {
  const golden = JSON.parse(await readFile(new URL('./fixtures/layered-app/expected.json', import.meta.url), 'utf8'));
  const facts = buildFacts(store, USER_CONTROLLER);
  assert.deepEqual(facts.imports.map(item => item.symbolKey),
    [...golden.questions.find(question => question.id === 'q11-imports-user-controller').expected].sort());
});

// ── Depth option ──────────────────────────────────────────────────────────────

test('depth 2 expands callees transitively over named calls only', () => {
  const facts = buildFacts(store, MAIN, { depth: 2 });
  assert.deepEqual(facts.callees, [callsItem(GET_USER, 'method'), callsItem(FIND_BY_ID, 'method')]);
});

// ── Shape invariants ──────────────────────────────────────────────────────────

test('identity echo, fan consistency, deterministic ordering and stable repeat calls', () => {
  const facts = buildFacts(store, FIND_BY_ID);
  assert.equal(facts.id, FIND_BY_ID);
  assert.equal(facts.kind, 'method');
  assert.equal(facts.signature, null); // registry endpoints carry no signature
  assert.deepEqual(facts.location, { path: 'src/services/user.service.ts', startLine: null, endLine: null });

  assert.equal(facts.fanIn, facts.callers.length + facts.importedBy.length);
  assert.equal(facts.fanOut, facts.callees.length + facts.imports.length);

  for (const list of [facts.callers, facts.callees, facts.imports, facts.importedBy, facts.tests]) {
    const keys = list.map((item) => item.symbolKey);
    assert.deepEqual(keys, [...keys].sort(), 'relation lists must be sorted by symbolKey');
  }
  assert.deepEqual(buildFacts(store, FIND_BY_ID), facts);
});

test('honest degradation: implements stays empty; unknown targets echo with empty relations', () => {
  // UserRepository *syntactically* implements IUserRepository, but no native
  // relation records that: no evidence, no edge.
  assert.deepEqual(buildFacts(store, USER_REPOSITORY).implements, []);

  const ghost = 'ts|src/nowhere.ts|function|exported|ghost|0';
  const facts = buildFacts(store, ghost);
  assert.equal(facts.id, ghost);
  assert.equal(facts.kind, 'function');
  assert.deepEqual(facts.location, { path: 'src/nowhere.ts', startLine: null, endLine: null });
  assert.deepEqual(facts.callers, []);
  assert.deepEqual(facts.callees, []);
  assert.deepEqual(facts.imports, []);
  assert.deepEqual(facts.importedBy, []);
  assert.deepEqual(facts.implements, []);
  assert.deepEqual(facts.tests, []);
  assert.equal(facts.fanIn, 0);
  assert.equal(facts.fanOut, 0);
});

test('file targets: relation entries and tests are file-scoped paths', () => {
  const facts = buildFacts(store, 'file|src/services/user.service.ts');
  assert.equal(facts.id, 'file|src/services/user.service.ts');
  assert.equal(facts.kind, 'file');
  assert.deepEqual(facts.imports, [
    { path: 'src/models/user.model.ts', relation: 'imports', kind: 'file' },
    { path: 'src/repositories/user.repository.ts', relation: 'imports', kind: 'file' },
    { path: 'src/utils/format.ts', relation: 'imports', kind: 'file' },
  ]);
  assert.deepEqual(facts.importedBy, [
    { path: 'src/controllers/user.controller.ts', relation: 'imports', kind: 'file' },
    { path: 'tests/user.service.test.ts', relation: 'imports', kind: 'file' },
  ]);
  assert.deepEqual(facts.tests, [{ path: 'tests/user.service.test.ts', relation: 'tests', kind: 'file' }]);
  assert.deepEqual(facts.callers, []);
  assert.deepEqual(facts.callees, []);
  assert.deepEqual(facts.implements, []);
  assert.equal(facts.fanIn, 2);
  assert.equal(facts.fanOut, 3);
});

test('invalid inputs fail closed with TypeError', () => {
  assert.throws(() => buildFacts(store, ''), TypeError);
  assert.throws(() => buildFacts(store, 'file|'), TypeError);
  assert.throws(() => buildFacts(store, FIND_BY_ID, { depth: 0 }), TypeError);
  assert.throws(() => buildFacts(store, FIND_BY_ID, { depth: 1.5 }), TypeError);
  assert.throws(() => buildFacts({}, FIND_BY_ID), TypeError);
  assert.throws(() => buildFacts(null, FIND_BY_ID), TypeError);
});
