// F4A1 / S13: `pmc_relations` optional `stopAtRole` — role-stopping traversal.
//
// Every test drives the actual shared query adapter through the real MCP
// Client/McpServer pair over InMemoryTransport. The layered fixture is the
// authoritative golden `layered-app` source set; its role ledger is seeded by
// the approved F2 classifier output (never hardcoded, never a golden edit).
// Synthetic fixtures are owned temp directories only, and every request must
// leave the graph.db bytes, schema, rows and config artifacts untouched.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerQueryTools } from '../mcp/query-tools.mjs';
import { extractNativeCalls } from '../src/relations/native-calls.mjs';
import { extractNativeImportBindings } from '../src/relations/native-import-bindings.mjs';
import { extractSymbolsForFile } from '../src/extractors/tree-sitter/extract.mjs';
import { classifySymbol, loadProfile } from '../src/roles/classify.mjs';
import { buildFromGraphJson, createSqliteGraphStore, hashGraphJson } from '../src/graph-store/graph-db.mjs';

const USER_SERVICE = 'ts|src/services/user.service.ts|class|exported|UserService|0';
const FIND_BY_ID = 'ts|src/services/user.service.ts|method|member|UserService.findById|1';
const USER_CONTROLLER = 'ts|src/controllers/user.controller.ts|class|exported|UserController|0';
const GET_USER = 'ts|src/controllers/user.controller.ts|method|member|UserController.getUser|1';
const TEST_USER_SERVICE = 'ts|tests/user.service.test.ts|function|exported|testUserService|0';

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const payload = result => {
  assert.notEqual(result.isError, true, result.content[0]?.text);
  return JSON.parse(result.content[0].text);
};
// Endpoint shape must mirror the shared reader's `endpoint()` exactly so the
// byte-parity test compares real serialized bytes, not a synthesized shape.
const endpoint = key => {
  const parts = key.split('|');
  return { id: key, symbolKey: key, kind: parts[2], path: parts[1] };
};
const callEdge = (sourceKey, targetKey, relation = 'calls') =>
  ({ source: endpoint(sourceKey), target: endpoint(targetKey), relation });
const pairs = edges => edges.map(edge => `${edge.source.symbolKey ?? edge.source.id} -> ${edge.target.symbolKey ?? edge.target.id}`).sort();

async function connect(projectRoot) {
  const server = new McpServer({ name: 'stop-at-role-fixture', version: '1.0.0' });
  registerQueryTools(server, { projectRoot });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'stop-at-role-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return { server, client };
}

function dbState(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all();
    const nodes = db.prepare('SELECT id, metadata FROM nodes ORDER BY id').all();
    const roles = schema.some(table => table.name === 'node_role_assignments')
      ? db.prepare('SELECT endpoint_id, classification FROM node_role_assignments ORDER BY endpoint_id').all()
      : null;
    const meta = db.prepare('SELECT key, value FROM meta ORDER BY key').all();
    return JSON.stringify({ schema, nodes, roles, meta });
  } finally { db.close(); }
}

// ── Authoritative layered-app fixture with the F2-seeded role ledger ─────────
const paths = ['src/cli/main.ts', 'src/controllers/user.controller.ts', 'src/services/user.service.ts',
  'src/repositories/user.repository.ts', 'src/db/client.ts', 'src/models/user.model.ts',
  'src/interfaces/user-repository.ts', 'src/utils/format.ts', 'src/views/user.view.ts', 'tests/user.service.test.ts'];
let root, dbPath, client, server, golden, configHashes;

async function layeredCall(name, args) {
  const before = hash(dbPath);
  const result = await client.callTool({ name, arguments: args });
  assert.equal(hash(dbPath), before, 'every request preserves exact DB bytes');
  return result;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'pmc-stop-at-role-'));
  const pmc = join(root, '.planning', 'project-memory-context');
  mkdirSync(join(pmc, 'graph'), { recursive: true });
  mkdirSync(join(pmc, 'enrichment'), { recursive: true });
  const files = paths.map(path => ({ path, content: readFileSync(new URL(`./fixtures/layered-app/${path}`, import.meta.url), 'utf8') }));
  const calls = await extractNativeCalls({ files });
  const graph = { nodes: calls.symbols.map(symbol => ({ id: symbol.id, label: symbol.id.split('|')[4], kind: symbol.kind,
    source_file: symbol.path, metadata: { symbolKey: symbol.id, semanticSummary: '' } })), links: [] };
  const json = JSON.stringify(graph);
  writeFileSync(join(pmc, 'graph', 'graph.json'), json);
  dbPath = join(pmc, 'graph', 'graph.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE nodes(id TEXT PRIMARY KEY,label TEXT,kind TEXT,source_file TEXT,community INTEGER,degree INTEGER,metadata TEXT); CREATE TABLE edges(source TEXT,target TEXT,relation TEXT);');
    buildFromGraphJson(db, graph, hashGraphJson(json));
    const store = createSqliteGraphStore(db);
    store.persistNativeRelations(calls);
    store.persistNativeRelations(await extractNativeImportBindings({ files }));
    // Role ledger seeded from the approved F2 classifier over the actual
    // extraction records: no hardcoded roles, no golden edits.
    const records = [];
    for (const file of files) records.push(...await extractSymbolsForFile({ filePath: file.path, content: file.content }));
    const generic = loadProfile('generic');
    const assignments = calls.symbols.map(symbol => {
      const record = records.find(candidate => candidate.symbolKey === symbol.symbolKey);
      assert.ok(record, `extractor record must exist for ${symbol.symbolKey}`);
      return { endpoint: symbol, classification: classifySymbol(record, { profile: generic, allSymbols: records }) };
    });
    const seeded = store.persistNodeRoles(assignments);
    assert.equal(seeded.updated, assignments.length, 'every extracted symbol gets a persisted F2 classification');
  } finally { db.close(); }
  const index = Object.fromEntries(calls.symbols.map(symbol => [symbol.id, { graphNodeId: symbol.id, semanticSummary: '' }]));
  writeFileSync(join(pmc, 'enrichment', 'symbol-index.json'), JSON.stringify(index));
  writeFileSync(join(pmc, 'enrichment', 'worklist.json'), JSON.stringify(calls.symbols.map(symbol => ({ symbolKey: symbol.id,
    name: symbol.id.split('|')[4], filePath: symbol.path, kind: symbol.kind }))));
  golden = JSON.parse(readFileSync(new URL('./fixtures/layered-app/expected.json', import.meta.url), 'utf8'));
  configHashes = ['graph/graph.json', 'enrichment/symbol-index.json', 'enrichment/worklist.json']
    .map(relative => join(pmc, relative));
  ({ client, server } = await connect(root));
});

after(async () => {
  await client?.close();
  await server?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

test('S13 fixture ledger: F2 classifier seed matches every golden symbol role', () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT endpoint_id, classification FROM node_role_assignments').all();
    for (const [key, expected] of Object.entries(golden.symbols)) {
      const row = rows.find(candidate => candidate.endpoint_id === key);
      assert.ok(row, `role ledger must assign golden symbol ${key}`);
      const classification = JSON.parse(row.classification);
      assert.equal(classification.role, expected.role, `${key} role`);
      assert.equal(classification.layer, expected.layer, `${key} layer`);
    }
  } finally { db.close(); }
});

test('S13 q7 class target stops at the nearest controller class with boundary evidence', async () => {
  const result = payload(await layeredCall('pmc_relations', {
    target: USER_SERVICE, direction: 'in', relations: ['calls'], depth: 1, stopAtRole: 'controller',
  }));
  assert.equal(result.status, 'resolved');
  assert.equal(result.stoppedAtRole, 'controller');
  assert.deepEqual(result.matches, [
    { symbolKey: USER_CONTROLLER, role: 'controller', distance: 1,
      path: [USER_SERVICE, FIND_BY_ID, GET_USER, USER_CONTROLLER] },
  ]);
  assert.deepEqual(pairs(result.edges), [
    `${GET_USER} -> ${FIND_BY_ID}`,
    `${TEST_USER_SERVICE} -> ${FIND_BY_ID}`,
  ].sort());
  // Real member-level evidence only: no fabricated class-level call edge.
  assert.ok(result.edges.every(edge => edge.source.kind !== 'class' && edge.target.kind !== 'class'));
});

test('S13 method target findById stops at the member UserController.getUser without owner projection', async () => {
  const result = payload(await layeredCall('pmc_relations', {
    target: FIND_BY_ID, direction: 'in', relations: ['calls'], depth: 1, stopAtRole: 'controller',
  }));
  assert.equal(result.status, 'resolved');
  assert.equal(result.stoppedAtRole, 'controller');
  assert.deepEqual(result.matches, [
    { symbolKey: GET_USER, role: 'controller', distance: 1, path: [FIND_BY_ID, GET_USER] },
  ]);
  assert.equal(result.matches.some(match => match.symbolKey === USER_CONTROLLER), false,
    'a member-level start keeps member boundaries (method evidence, no owner projection)');
  assert.deepEqual(pairs(result.edges), [
    `${GET_USER} -> ${FIND_BY_ID}`,
    `${TEST_USER_SERVICE} -> ${FIND_BY_ID}`,
  ].sort());
});

test('S13 absent stopAtRole keeps byte-identical default output and key set', async () => {
  const raw = await layeredCall('pmc_relations', { target: FIND_BY_ID, direction: 'in', relations: ['calls'], depth: 1 });
  assert.notEqual(raw.isError, true, raw.content[0]?.text);
  const expected = {
    status: 'resolved',
    target: FIND_BY_ID,
    direction: 'in',
    depth: 1,
    edges: [callEdge(GET_USER, FIND_BY_ID), callEdge(TEST_USER_SERVICE, FIND_BY_ID)],
  };
  assert.equal(raw.content[0].text, JSON.stringify(expected, null, 2),
    'the default serialized response stays byte-identical when the option is absent');
  const parsed = JSON.parse(raw.content[0].text);
  assert.equal(Object.hasOwn(parsed, 'stoppedAtRole'), false);
  assert.equal(Object.hasOwn(parsed, 'matches'), false);
});

test('S13 a valid role with no boundary returns an empty matches array beside default-identical edges', async () => {
  const args = { target: FIND_BY_ID, direction: 'in', relations: ['calls'], depth: 1 };
  const baseline = payload(await layeredCall('pmc_relations', { ...args }));
  const stopped = payload(await layeredCall('pmc_relations', { ...args, stopAtRole: 'dto' }));
  assert.equal(stopped.status, 'resolved');
  assert.equal(stopped.stoppedAtRole, 'dto');
  assert.deepEqual(stopped.matches, [], 'a known role absent from the fixture is an empty boundary, not an error');
  assert.deepEqual(stopped.edges, baseline.edges, 'an unmatched walk keeps exactly the default edge set');
  assert.deepEqual(Object.keys(stopped).sort(),
    ['depth', 'direction', 'edges', 'matches', 'status', 'stoppedAtRole', 'target']);
  assert.deepEqual(Object.keys(baseline).sort(), ['depth', 'direction', 'edges', 'status', 'target']);
});

test('S13 invalid stopAtRole values reject without silent success and preserve DB bytes, schema, rows and config', async () => {
  const before = {
    bytes: hash(dbPath),
    mtime: statSync(dbPath).mtimeMs,
    state: dbState(dbPath),
    config: configHashes.map(path => [path, hash(path)]),
  };
  for (const value of ['contorller', 'controller ', 'Controller']) {
    const result = await client.callTool({ name: 'pmc_relations', arguments: { target: FIND_BY_ID, stopAtRole: value } });
    assert.equal(result.isError, true, `unknown role ${JSON.stringify(value)} must not be ignored as success`);
    assert.match(result.content[0].text, /stopAtRole/);
    assert.match(result.content[0].text, /unknown role/);
  }
  for (const value of ['', ' ', null, 42]) {
    const result = await client.callTool({ name: 'pmc_relations', arguments: { target: FIND_BY_ID, stopAtRole: value } });
    assert.equal(result.isError, true, `invalid stopAtRole value ${JSON.stringify(value)} must reject`);
  }
  const typo = await client.callTool({ name: 'pmc_relations', arguments: { target: FIND_BY_ID, stopAtRoleTypo: 'controller' } });
  assert.equal(typo.isError, true, 'an unknown input key still rejects');
  assert.match(typo.content[0].text, /Unrecognized key/);
  const valid = await client.callTool({ name: 'pmc_relations', arguments: {
    target: FIND_BY_ID, direction: 'in', relations: ['calls'], depth: 1, stopAtRole: 'controller' } });
  assert.notEqual(valid.isError, true, valid.content[0]?.text);
  assert.equal(hash(dbPath), before.bytes, 'accepted and rejected queries keep exact DB bytes');
  assert.equal(statSync(dbPath).mtimeMs, before.mtime, 'no write time changes');
  assert.equal(dbState(dbPath), before.state, 'schema, rows, role ledger and meta stay identical');
  for (const [path, bytes] of before.config) assert.equal(hash(path), bytes, `${path} config artifact unchanged`);
});

test('S13 ambiguous targets return candidates instead of walking or inventing a boundary', async () => {
  const result = payload(await layeredCall('pmc_relations', { target: 'constructor', stopAtRole: 'controller' }));
  assert.equal(result.status, 'ambiguous');
  assert.ok(result.candidates.length > 1);
  assert.ok(result.candidates.every(candidate => candidate.symbolKey));
});

test('S13 file target walks its file seeds and reports the projected class boundary', async () => {
  const result = payload(await layeredCall('pmc_relations', {
    target: 'src/services/user.service.ts', direction: 'in', relations: ['calls'], depth: 1, stopAtRole: 'controller',
  }));
  assert.equal(result.status, 'resolved');
  assert.equal(result.stoppedAtRole, 'controller');
  assert.deepEqual(result.matches, [
    { symbolKey: USER_CONTROLLER, role: 'controller', distance: 1,
      path: [`file|src/services/user.service.ts`, FIND_BY_ID, GET_USER, USER_CONTROLLER] },
  ]);
  assert.deepEqual(pairs(result.edges), [
    `${GET_USER} -> ${FIND_BY_ID}`,
    `${TEST_USER_SERVICE} -> ${FIND_BY_ID}`,
  ].sort());
});

// ── Synthetic owned fixtures: walker rules on a fully controlled graph ───────
const T = 'js|src/t.js|function|exported|start|0';
const M1 = 'js|src/m1.js|function|exported|middle|0';
const C1 = 'js|src/c1.js|function|exported|ctrlOne|0';
const C2 = 'js|src/c2.js|function|exported|ctrlTwo|0';
const C3 = 'js|src/c3.js|function|exported|ctrlThree|0';
const P = 'js|src/p.js|function|exported|predecessor|0';

const mnode = (key, metadata = {}) => {
  const parts = key.split('|');
  return { id: key, label: parts[4], kind: parts[2], source_file: parts[1], metadata: { symbolKey: key, ...metadata } };
};
const mindex = keys => Object.fromEntries(keys.map(key => [key, { graphNodeId: key }]));
const endpointOf = key => {
  const parts = key.split('|');
  return { id: key, symbolKey: key, kind: parts[2], path: parts[1] };
};
const generic = loadProfile('generic');
const known = role => ({ role, layer: generic.roleLayers[role], confidence: 0.7, evidence: ['fixture ledger evidence'] });
const unknownClassification = { role: null, layer: null, confidence: 0, evidence: [] };

async function micro(t, { nodes, links = [], index = {}, assignments = [], profile } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pmc-stop-micro-'));
  const pmc = join(dir, '.planning/project-memory-context');
  mkdirSync(join(pmc, 'graph'), { recursive: true });
  mkdirSync(join(pmc, 'enrichment'), { recursive: true });
  const graph = { nodes, links };
  writeFileSync(join(pmc, 'graph/graph.json'), JSON.stringify(graph));
  writeFileSync(join(pmc, 'enrichment/symbol-index.json'), JSON.stringify(index));
  const fixtureDb = join(pmc, 'graph/graph.db');
  const db = new DatabaseSync(fixtureDb);
  try {
    db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE nodes(id TEXT PRIMARY KEY,label TEXT,kind TEXT,source_file TEXT,community INTEGER,degree INTEGER,metadata TEXT); CREATE TABLE edges(source TEXT,target TEXT,relation TEXT);');
    buildFromGraphJson(db, graph, 'stop-at-role-micro');
    createSqliteGraphStore(db).persistNativeRelations({ relations: [], unresolved: [] });
    if (assignments.length) createSqliteGraphStore(db).persistNodeRoles(assignments, profile ? { profile } : {});
  } finally { db.close(); }
  const { server: fixtureServer, client: fixtureClient } = await connect(dir);
  t.after(async () => { await fixtureClient.close(); await fixtureServer.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dbPath: fixtureDb, async call(name, args) {
    const before = hash(fixtureDb);
    const result = await fixtureClient.callTool({ name, arguments: args });
    assert.equal(hash(fixtureDb), before, 'every request preserves exact DB bytes');
    return result;
  } };
}

test('S13 first match per path: ties keep every boundary, a controller behind a match stays cut', async t => {
  const f = await micro(t, {
    nodes: [mnode(T), mnode(M1), mnode(C1), mnode(C2), mnode(C3)],
    links: [{ source: T, target: M1, relation: 'calls' }, { source: M1, target: C1, relation: 'calls' },
      { source: C1, target: C2, relation: 'calls' }, { source: T, target: C3, relation: 'calls' }],
    index: mindex([T, M1, C1, C2, C3]),
    assignments: [C1, C2, C3].map(key => ({ endpoint: endpointOf(key), classification: known('controller') })),
  });
  const result = payload(await f.call('pmc_relations', { target: T, direction: 'out', relations: ['calls'], depth: 3, stopAtRole: 'controller' }));
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.matches, [
    { symbolKey: C3, role: 'controller', distance: 1, path: [T, C3] },
    { symbolKey: C1, role: 'controller', distance: 2, path: [T, M1, C1] },
  ]);
  assert.equal(result.matches.some(match => match.symbolKey === C2), false,
    'a controller behind an earlier controller match is never expanded');
  assert.deepEqual(pairs(result.edges), [
    `${M1} -> ${C1}`,
    `${T} -> ${C3}`,
    `${T} -> ${M1}`,
  ].sort());
  assert.equal(result.edges.some(edge => (edge.source.symbolKey ?? edge.source.id) === C1), false,
    'edges beyond the matching node are not traversed');
});

test('S13 depth bounds how far the boundary search may reach', async t => {
  const f = await micro(t, {
    nodes: [mnode(T), mnode(M1), mnode(C1), mnode(C3)],
    links: [{ source: T, target: M1, relation: 'calls' }, { source: M1, target: C1, relation: 'calls' },
      { source: T, target: C3, relation: 'calls' }],
    index: mindex([T, M1, C1, C3]),
    assignments: [C1, C3].map(key => ({ endpoint: endpointOf(key), classification: known('controller') })),
  });
  const shallow = payload(await f.call('pmc_relations', { target: T, direction: 'out', relations: ['calls'], depth: 1, stopAtRole: 'controller' }));
  assert.deepEqual(shallow.matches.map(match => match.symbolKey), [C3], 'depth 1 only reports distance-1 boundaries');
  const deep = payload(await f.call('pmc_relations', { target: T, direction: 'out', relations: ['calls'], depth: 2, stopAtRole: 'controller' }));
  assert.deepEqual(deep.matches.map(match => match.symbolKey), [C3, C1]);
  assert.deepEqual(deep.matches.find(match => match.symbolKey === C1).path, [T, M1, C1]);
});

test('S13 only requested relations and direction gate the walk', async t => {
  const f = await micro(t, {
    nodes: [mnode(T), mnode(M1), mnode(C1), mnode(C3), mnode(P)],
    links: [{ source: T, target: M1, relation: 'calls' }, { source: M1, target: C1, relation: 'imports' },
      { source: T, target: C3, relation: 'calls' }, { source: P, target: T, relation: 'calls' }],
    index: mindex([T, M1, C1, C3, P]),
    assignments: [C1, C3].map(key => ({ endpoint: endpointOf(key), classification: known('controller') })),
  });
  const callsOnly = payload(await f.call('pmc_relations', { target: T, direction: 'out', relations: ['calls'], depth: 3, stopAtRole: 'controller' }));
  assert.deepEqual(callsOnly.matches.map(match => match.symbolKey), [C3], 'the imports edge is not walked when not requested');
  const both = payload(await f.call('pmc_relations', { target: T, direction: 'out', relations: ['calls', 'imports'], depth: 3, stopAtRole: 'controller' }));
  assert.deepEqual(both.matches.map(match => match.symbolKey), [C3, C1]);
  const inbound = payload(await f.call('pmc_relations', { target: T, direction: 'in', relations: ['calls'], depth: 1, stopAtRole: 'controller' }));
  assert.deepEqual(inbound.matches, [], 'the inbound direction walks callers, not callees');
  assert.deepEqual(pairs(inbound.edges), [`${P} -> ${T}`]);
});

test('S13 a matching start is a depth-0 boundary with no outgoing walk', async t => {
  const f = await micro(t, {
    nodes: [mnode(T), mnode(M1), mnode(C1), mnode(C2)],
    links: [{ source: T, target: M1, relation: 'calls' }, { source: M1, target: C1, relation: 'calls' },
      { source: C1, target: C2, relation: 'calls' }],
    index: mindex([T, M1, C1, C2]),
    assignments: [C1, C2].map(key => ({ endpoint: endpointOf(key), classification: known('controller') })),
  });
  for (const direction of ['out', 'in']) {
    const result = payload(await f.call('pmc_relations', { target: C1, direction, relations: ['calls'], depth: 3, stopAtRole: 'controller' }));
    assert.deepEqual(result.matches, [{ symbolKey: C1, role: 'controller', distance: 0, path: [C1] }]);
    assert.deepEqual(result.edges, [], `a matching start never walks ${direction}ward`);
  }
});

test('S13 cycles stay bounded without looping or inventing matches', async t => {
  const A = 'js|src/cyc-a.js|function|exported|cycleA|0';
  const B = 'js|src/cyc-b.js|function|exported|cycleB|0';
  const f = await micro(t, {
    nodes: [mnode(A), mnode(B)],
    links: [{ source: A, target: B, relation: 'calls' }, { source: B, target: A, relation: 'calls' }],
    index: mindex([A, B]),
  });
  const result = payload(await f.call('pmc_relations', { target: A, direction: 'out', relations: ['calls'], depth: 3, stopAtRole: 'dto' }));
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.matches, []);
  assert.deepEqual(pairs(result.edges), [`${A} -> ${B}`, `${B} -> ${A}`].sort());
});

test('S13 member roles inherit only from an actual container assignment with proven ownership', async t => {
  const OWNER = 'js|src/cls.js|class|exported|Owner|0';
  const WORK = 'js|src/cls.js|method|member|Owner.doWork|0';
  const controller = { endpoint: endpointOf(OWNER), classification: known('controller') };

  const inherited = await micro(t, {
    nodes: [mnode(OWNER), mnode(WORK)], links: [], index: mindex([OWNER, WORK]), assignments: [controller],
  });
  const start = payload(await inherited.call('pmc_relations', { target: WORK, stopAtRole: 'controller' }));
  assert.deepEqual(start.matches, [{ symbolKey: WORK, role: 'controller', distance: 0, path: [WORK] }],
    'a member inherits its uniquely resolved container assignment');

  const explicit = await micro(t, {
    nodes: [mnode(OWNER), mnode(WORK)], links: [], index: mindex([OWNER, WORK]),
    assignments: [controller, { endpoint: endpointOf(WORK), classification: unknownClassification }],
  });
  const withheld = payload(await explicit.call('pmc_relations', { target: WORK, stopAtRole: 'controller' }));
  assert.deepEqual(withheld.matches, [], 'an explicit unknown member assignment must not be overridden by inheritance');
  assert.equal(withheld.status, 'resolved');

  const ownRole = await micro(t, {
    nodes: [mnode(OWNER), mnode(WORK)], links: [], index: mindex([OWNER, WORK]),
    assignments: [controller, { endpoint: endpointOf(WORK), classification: known('service') }],
  });
  assert.deepEqual(payload(await ownRole.call('pmc_relations', { target: WORK, stopAtRole: 'service' })).matches.map(match => match.symbolKey), [WORK]);
  assert.deepEqual(payload(await ownRole.call('pmc_relations', { target: WORK, stopAtRole: 'controller' })).matches, [],
    'an explicit member assignment wins over the container role');

  const unassigned = await micro(t, { nodes: [mnode(OWNER), mnode(WORK)], links: [], index: mindex([OWNER, WORK]) });
  assert.deepEqual(payload(await unassigned.call('pmc_relations', { target: WORK, stopAtRole: 'controller' })).matches, [],
    'without a container assignment there is nothing to inherit');
});

test('S13 proven ownership fails closed and name prefixes never invent membership', async t => {
  const OWNER = 'js|src/cls.js|class|exported|Owner|0';
  const WORK = 'js|src/cls.js|method|member|Owner.doWork|0';
  const FOREIGN_OWNER = 'js|src/owner.js|class|exported|Owner|0';
  const PRETENDER = 'js|src/pretend.js|function|exported|Owner.thing|0';
  const controller = key => ({ endpoint: endpointOf(key), classification: known('controller') });

  const foreign = await micro(t, {
    nodes: [mnode(FOREIGN_OWNER), mnode(WORK)], links: [], index: mindex([FOREIGN_OWNER, WORK]),
    assignments: [controller(FOREIGN_OWNER)],
  });
  assert.deepEqual(payload(await foreign.call('pmc_relations', { target: WORK, stopAtRole: 'controller' })).matches, [],
    'ownership must resolve to a unique container in the same file, not a cross-file name match');

  const pretender = await micro(t, {
    nodes: [mnode(OWNER), mnode(PRETENDER)], links: [], index: mindex([OWNER, PRETENDER]),
    assignments: [controller(OWNER)],
  });
  assert.deepEqual(payload(await pretender.call('pmc_relations', { target: PRETENDER, stopAtRole: 'controller' })).matches, [],
    'a plain function whose name merely contains a prefix never inherits a container role');
});

test('S13 stale legacy metadata roles never satisfy the stop predicate', async t => {
  const stale = { roleClassification: { role: 'controller', layer: 'presentation', confidence: 0.9, evidence: ['stale legacy only'] } };
  const f = await micro(t, {
    nodes: [mnode(T), mnode(M1, stale), mnode(C1)],
    links: [{ source: T, target: M1, relation: 'calls' }, { source: M1, target: C1, relation: 'calls' }],
    index: mindex([T, M1, C1]),
    assignments: [{ endpoint: endpointOf(C1), classification: known('controller') }],
  });
  const shallow = payload(await f.call('pmc_relations', { target: T, direction: 'out', relations: ['calls'], depth: 1, stopAtRole: 'controller' }));
  assert.deepEqual(shallow.matches, [], 'metadata-only legacy roles are not ledger assignments');
  const deep = payload(await f.call('pmc_relations', { target: T, direction: 'out', relations: ['calls'], depth: 3, stopAtRole: 'controller' }));
  assert.deepEqual(deep.matches, [{ symbolKey: C1, role: 'controller', distance: 2, path: [T, M1, C1] }],
    'the walk passes through unroled nodes and matches only the ledger assignment');
});

test('S13 custom canonical ledger roles are accepted beyond the builtin profile vocabulary', async t => {
  const CUSTOM = 'js|src/custom.js|function|exported|customThing|0';
  const profile = loadProfile('generic');
  profile.roleLayers['custom-adapter'] = 'custom-layer';
  const f = await micro(t, {
    nodes: [mnode(CUSTOM)], links: [], index: mindex([CUSTOM]),
    assignments: [{ endpoint: endpointOf(CUSTOM),
      classification: { role: 'custom-adapter', layer: 'custom-layer', confidence: 0.4, evidence: ['configured role evidence'] } }],
    profile,
  });
  const accepted = payload(await f.call('pmc_relations', { target: CUSTOM, stopAtRole: 'custom-adapter' }));
  assert.equal(accepted.status, 'resolved');
  assert.equal(accepted.stoppedAtRole, 'custom-adapter');
  assert.deepEqual(accepted.matches, [{ symbolKey: CUSTOM, role: 'custom-adapter', distance: 0, path: [CUSTOM] }]);
});

test('S13 a builtin role with no matching node returns an empty boundary, not an unknown-role error', async t => {
  const f = await micro(t, { nodes: [mnode(T)], links: [], index: mindex([T]) });
  const result = payload(await f.call('pmc_relations', { target: T, stopAtRole: 'controller' }));
  assert.equal(result.status, 'resolved');
  assert.equal(result.stoppedAtRole, 'controller');
  assert.deepEqual(result.matches, []);
});
