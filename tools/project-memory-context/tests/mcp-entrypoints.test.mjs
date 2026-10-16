// F4A2 / S14: `pmc_entrypoints_for` — complete reverse call reachability to
// application entrypoints and controllers.
//
// Plan 4.2: "reverse reachability to roles `entrypoint`, `cli-command`,
// `mcp-tool`, `controller`, or route handlers"; v3 purpose: "Which CLI
// commands, MCP tools, routes, or `main` functions reach X".
//
// Every test drives the actual shared query adapter through the real MCP
// Client/McpServer pair over InMemoryTransport. The layered fixture is the
// authoritative golden `layered-app` source set; its role ledger is seeded by
// the approved F2 classifier output (never hardcoded, never a golden edit).
// Synthetic fixtures are owned temp directories only, every request must
// leave the graph.db bytes, mtime, schema, role ledger and config artifacts
// untouched, and no test spawns a child process or reaches outside temp.
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

// Owned temp isolation for this file's process: HOME/USERPROFILE/TMPDIR/TEMP/TMP
// all point inside one owned root, so no fixture can touch production state.
const ENV_ROOT = mkdtempSync(join(tmpdir(), 'pmc-entrypoints-env-'));
for (const name of ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP']) process.env[name] = ENV_ROOT;

const USER_SERVICE = 'ts|src/services/user.service.ts|class|exported|UserService|0';
const FIND_BY_ID = 'ts|src/services/user.service.ts|method|member|UserService.findById|1';
const USER_CONTROLLER = 'ts|src/controllers/user.controller.ts|class|exported|UserController|0';
const GET_USER = 'ts|src/controllers/user.controller.ts|method|member|UserController.getUser|1';
const TEST_USER_SERVICE = 'ts|tests/user.service.test.ts|function|exported|testUserService|0';
const MAIN = 'ts|src/cli/main.ts|function|exported|main|0';
const SERVICE_FILE = 'src/services/user.service.ts';
const SERVICE_FILE_ID = 'file|src/services/user.service.ts';

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const payload = result => {
  assert.notEqual(result.isError, true, result.content[0]?.text);
  return JSON.parse(result.content[0].text);
};
const match = (symbolKey, role, layer, distance, path) => ({ symbolKey, role, layer, distance, path });

async function connect(projectRoot) {
  const server = new McpServer({ name: 'entrypoints-fixture', version: '1.0.0' });
  registerQueryTools(server, { projectRoot });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'entrypoints-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return { server, client };
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

function layeredSnapshot() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return JSON.stringify({
      db: hash(dbPath),
      mtime: statSync(dbPath).mtimeMs,
      schema: db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all(),
      nodes: db.prepare('SELECT id, metadata FROM nodes ORDER BY id').all(),
      roles: db.prepare('SELECT endpoint_id, classification FROM node_role_assignments ORDER BY endpoint_id').all(),
      meta: db.prepare('SELECT key, value FROM meta ORDER BY key').all(),
      config: configHashes.map(path => [path, hash(path)]),
    });
  } finally {
    db.close();
  }
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'pmc-entrypoints-'));
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
  rmSync(ENV_ROOT, { recursive: true, force: true });
});

// ── Golden layered behavior ──────────────────────────────────────────────────

test('S14 golden q8 entrypoints projection for the UserService class is exactly main', async () => {
  const result = payload(await layeredCall('pmc_entrypoints_for', { target: USER_SERVICE }));
  assert.equal(result.status, 'resolved');
  assert.equal(result.target, USER_SERVICE);
  const expectedEntrypoints = golden.questions.find(question => question.id === 'q8-entrypoint-user-service').expected;
  assert.deepEqual(result.entrypoints.map(item => item.symbolKey), expectedEntrypoints,
    'q8 stays authoritative: only the fixture main function is an application entrypoint');
  assert.deepEqual(result.entrypoints, [
    match(MAIN, 'cli', 'entrypoint', 2, [USER_SERVICE, FIND_BY_ID, GET_USER, MAIN]),
  ]);
  assert.deepEqual(result.matches, [
    match(GET_USER, 'controller', 'presentation', 1, [USER_SERVICE, FIND_BY_ID, GET_USER]),
    match(MAIN, 'cli', 'entrypoint', 2, [USER_SERVICE, FIND_BY_ID, GET_USER, MAIN]),
  ], 'the complete union keeps controller AND entrypoint evidence; service/test roles are not role-set evidence');
  assert.deepEqual(result.controllers, [
    match(GET_USER, 'controller', 'presentation', 1, [USER_SERVICE, FIND_BY_ID, GET_USER]),
  ], 'the matching method stays its actual method key; no owner class is invented');
  assert.deepEqual(Object.keys(result).sort(), ['controllers', 'entrypoints', 'matches', 'status', 'target']);
});

test('S14 method target findById returns the full role union including getUser and main', async () => {
  const result = payload(await layeredCall('pmc_entrypoints_for', { target: FIND_BY_ID }));
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.matches.map(item => item.symbolKey), [GET_USER, MAIN]);
  assert.ok(result.matches.some(item => item.symbolKey === GET_USER && item.role === 'controller'),
    'all-role union includes UserController.getUser');
  assert.ok(result.matches.some(item => item.symbolKey === MAIN && item.role === 'cli'),
    'all-role union includes main');
  assert.deepEqual(result.entrypoints, [match(MAIN, 'cli', 'entrypoint', 2, [FIND_BY_ID, GET_USER, MAIN])]);
  assert.deepEqual(result.controllers, [match(GET_USER, 'controller', 'presentation', 1, [FIND_BY_ID, GET_USER])]);
  assert.equal(result.matches.some(item => item.symbolKey === TEST_USER_SERVICE), false,
    'a reachable test symbol is traversed but is not entrypoint/controller role evidence');
});

test('S14 file and alias targets expand through exact proven membership only', async () => {
  const canonical = payload(await layeredCall('pmc_entrypoints_for', { target: SERVICE_FILE }));
  assert.equal(canonical.status, 'resolved');
  assert.equal(canonical.target, SERVICE_FILE);
  assert.deepEqual(canonical.matches, [
    match(GET_USER, 'controller', 'presentation', 1, [SERVICE_FILE_ID, FIND_BY_ID, GET_USER]),
    match(MAIN, 'cli', 'entrypoint', 2, [SERVICE_FILE_ID, FIND_BY_ID, GET_USER, MAIN]),
  ], 'file seeds are zero-hop registry members; paths start at the file endpoint');
  assert.deepEqual(canonical.entrypoints.map(item => item.symbolKey), [MAIN]);
  const explicitFile = payload(await layeredCall('pmc_entrypoints_for', { target: SERVICE_FILE_ID }));
  assert.deepEqual(explicitFile, canonical, 'file|<path> resolves to the same answer');
  const alias = payload(await layeredCall('pmc_entrypoints_for', { target: 'findById' }));
  assert.deepEqual(alias, {
    status: 'resolved',
    target: FIND_BY_ID,
    matches: [
      match(GET_USER, 'controller', 'presentation', 1, [FIND_BY_ID, GET_USER]),
      match(MAIN, 'cli', 'entrypoint', 2, [FIND_BY_ID, GET_USER, MAIN]),
    ],
    entrypoints: [match(MAIN, 'cli', 'entrypoint', 2, [FIND_BY_ID, GET_USER, MAIN])],
    controllers: [match(GET_USER, 'controller', 'presentation', 1, [FIND_BY_ID, GET_USER])],
  }, 'a unique member alias resolves to the same walk as its canonical key (paths start at the selected target)');
});

test('S14 nearest S13 q7 and the golden 16/16 classifier ledger stay unchanged', async () => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT endpoint_id, classification FROM node_role_assignments').all();
    let checked = 0;
    for (const [key, expected] of Object.entries(golden.symbols)) {
      const row = rows.find(candidate => candidate.endpoint_id === key);
      assert.ok(row, `role ledger must assign golden symbol ${key}`);
      const classification = JSON.parse(row.classification);
      assert.equal(classification.role, expected.role, `${key} role`);
      assert.equal(classification.layer, expected.layer, `${key} layer`);
      checked += 1;
    }
    assert.equal(checked, 16, 'all16 golden symbols keep their classifier roles');
  } finally { db.close(); }
  const q7 = golden.questions.find(question => question.id === 'q7-nearest-controller-user-service');
  const stopped = payload(await layeredCall('pmc_relations', {
    target: USER_SERVICE, direction: 'in', relations: ['calls'], depth: 1, stopAtRole: 'controller',
  }));
  assert.equal(stopped.stoppedAtRole, 'controller');
  assert.deepEqual(stopped.matches.map(item => item.symbolKey), q7.expected,
    'S13 q7 nearest controller is unchanged by the new tool');
});

test('S14 strict input accepts only target and rejects invalid targets helpfully', async () => {
  for (const args of [
    { target: USER_SERVICE, depth: 3 },
    { target: USER_SERVICE, direction: 'in' },
    { target: USER_SERVICE, stopAtRole: 'controller' },
    { target: USER_SERVICE, typo: true },
  ]) {
    const result = await client.callTool({ name: 'pmc_entrypoints_for', arguments: args });
    assert.equal(result.isError, true, `unknown option ${JSON.stringify(args)} must not be ignored as success`);
    assert.match(result.content[0].text, /Unrecognized key/);
  }
  for (const target of [123, null, {}, true]) {
    const result = await client.callTool({ name: 'pmc_entrypoints_for', arguments: { target } });
    assert.equal(result.isError, true, `non-string target ${JSON.stringify(target)} must reject`);
  }
  const empty = await client.callTool({ name: 'pmc_entrypoints_for', arguments: { target: '' } });
  assert.equal(empty.isError, true, 'an empty target must reject');
  const blank = await client.callTool({ name: 'pmc_entrypoints_for', arguments: { target: '   ' } });
  assert.equal(blank.isError, true, 'a whitespace target must reject');
  assert.match(blank.content[0].text, /nonempty/);
  const absent = await client.callTool({ name: 'pmc_entrypoints_for', arguments: {} });
  assert.equal(absent.isError, true, 'a missing target must reject');
});

test('S14 missing and ambiguous targets keep candidate shapes with empty projections', async () => {
  const missing = payload(await layeredCall('pmc_entrypoints_for', { target: 'src/does-not-exist.ts' }));
  assert.equal(missing.status, 'missing');
  assert.deepEqual(missing.candidates, []);
  assert.deepEqual(missing.matches, []);
  assert.deepEqual(missing.entrypoints, []);
  assert.deepEqual(missing.controllers, []);
  const ambiguous = payload(await layeredCall('pmc_entrypoints_for', { target: 'constructor' }));
  assert.equal(ambiguous.status, 'ambiguous');
  assert.ok(ambiguous.candidates.length > 1, 'multiple constructor members stay ambiguous');
  assert.ok(ambiguous.candidates.every(candidate => candidate.symbolKey));
  assert.deepEqual(ambiguous.matches, []);
  assert.deepEqual(ambiguous.entrypoints, []);
  assert.deepEqual(ambiguous.controllers, []);
});

test('S14 accepted and rejected requests preserve DB bytes, mtime, schema, roles and config', async () => {
  const before = layeredSnapshot();
  for (const [name, args] of [
    ['pmc_entrypoints_for', { target: USER_SERVICE }],
    ['pmc_entrypoints_for', { target: FIND_BY_ID }],
    ['pmc_entrypoints_for', { target: SERVICE_FILE }],
    ['pmc_entrypoints_for', { target: 'constructor' }],
    ['pmc_entrypoints_for', { target: 'src/does-not-exist.ts' }],
    ['pmc_entrypoints_for', { target: USER_SERVICE, depth: 3 }],
    ['pmc_entrypoints_for', { target: 42 }],
    ['pmc_relations', { target: FIND_BY_ID, direction: 'in', relations: ['calls'], depth: 1, stopAtRole: 'controller' }],
    ['pmc_card', { target: USER_SERVICE }],
  ]) {
    await client.callTool({ name, arguments: args });
  }
  assert.equal(layeredSnapshot(), before, 'no request mutates DB bytes, mtime, schema, ledger rows, meta or config');
});

// ── Synthetic owned fixtures: complete reachability on controlled graphs ─────
const T = 'js|src/t.js|function|exported|target|0';
const generic = loadProfile('generic');
const endpointOf = key => ({ id: key, symbolKey: key, kind: key.split('|')[2], path: key.split('|')[1] });
const assign = (key, role, layer) => ({ endpoint: endpointOf(key),
  classification: { role, layer, confidence: 0.7, evidence: ['fixture ledger evidence'] } });
const explicitUnknown = key => ({ endpoint: endpointOf(key),
  classification: { role: null, layer: null, confidence: 0, evidence: [] } });
const mnode = (key, metadata = {}) => {
  const parts = key.split('|');
  return { id: key, label: parts[4], kind: parts[2], source_file: parts[1], metadata: { symbolKey: key, ...metadata } };
};
const mindex = keys => Object.fromEntries(keys.map(key => [key, { graphNodeId: key }]));

async function micro(t, { nodes, links = [], index = {}, assignments = [], profile, kinds = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'pmc-entrypoints-micro-'));
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
    buildFromGraphJson(db, graph, 'entrypoints-micro');
    const store = createSqliteGraphStore(db);
    store.persistNativeRelations({ relations: [], unresolved: [] });
    if (assignments.length) store.persistNodeRoles(assignments, profile ? { profile } : {});
    for (const [key, kind] of Object.entries(kinds)) {
      db.prepare('UPDATE nodes SET node_kind=? WHERE id=?').run(kind, key);
    }
  } finally { db.close(); }
  const { server: fixtureServer, client: fixtureClient } = await connect(dir);
  t.after(async () => {
    try { await fixtureClient.close(); } finally { await fixtureServer.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  return { dbPath: fixtureDb, async call(name, args) {
    const before = hash(fixtureDb);
    const result = await fixtureClient.callTool({ name, arguments: args });
    assert.equal(hash(fixtureDb), before, 'every request preserves exact DB bytes');
    return result;
  } };
}

test('S14 complete reverse reachability passes intermediate controllers and hop depth3', async t => {
  const A2 = 'js|src/a2.js|function|exported|mid2|0';
  const C1 = 'js|src/c1.js|function|exported|ctrlOne|0';
  const A1 = 'js|src/a1.js|function|exported|mid1|0';
  const C2 = 'js|src/c2.js|function|exported|ctrlTwo|0';
  const E = 'js|src/e.js|function|exported|entry|0';
  const f = await micro(t, {
    nodes: [T, A2, C1, A1, C2, E].map(key => mnode(key)),
    links: [{ source: E, target: C2, relation: 'calls' }, { source: C2, target: A1, relation: 'calls' },
      { source: A1, target: C1, relation: 'calls' }, { source: C1, target: A2, relation: 'calls' },
      { source: A2, target: T, relation: 'calls' }],
    index: mindex([T, A2, C1, A1, C2, E]),
    assignments: [assign(C1, 'controller', 'presentation'), assign(C2, 'controller', 'presentation'),
      assign(E, 'cli', 'entrypoint')],
  });
  const result = payload(await f.call('pmc_entrypoints_for', { target: T }));
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.matches, [
    match(C1, 'controller', 'presentation', 2, [T, A2, C1]),
    match(C2, 'controller', 'presentation', 4, [T, A2, C1, A1, C2]),
    match(E, 'cli', 'entrypoint', 5, [T, A2, C1, A1, C2, E]),
  ], 'a controller at hop2 never cuts the upstream controller or entrypoint; depth exceeds3');
  assert.deepEqual(result.controllers.map(item => item.symbolKey), [C1, C2]);
  assert.deepEqual(result.entrypoints.map(item => item.symbolKey), [E]);
  assert.equal(result.matches.some(item => item.symbolKey === A1 || item.symbolKey === A2), false,
    'unroled intermediate nodes are traversed but never matched');
});

test('S14 entrypoint roles, mcp-tool and custom entrypoint-layer roles all project', async t => {
  const K = 'js|src/k.js|function|exported|kCommand|0';
  const L = 'js|src/l.js|function|exported|lCli|0';
  const P = 'js|src/p.js|function|exported|pTool|0';
  const X = 'js|src/x.js|function|exported|xEntry|0';
  const S = 'js|src/s.js|function|exported|sService|0';
  const U = 'js|src/u.js|function|exported|uNobody|0';
  const profile = loadProfile('generic');
  profile.roleLayers['project-entry'] = 'entrypoint';
  const f = await micro(t, {
    nodes: [K, L, P, X, S, U, T].map(key => mnode(key)),
    links: [K, L, P, X, S, U].map(source => ({ source, target: T, relation: 'calls' })),
    index: mindex([K, L, P, X, S, U, T]),
    assignments: [
      assign(K, 'cli-command', profile.roleLayers['cli-command']),
      assign(L, 'cli', profile.roleLayers['cli']),
      assign(P, 'mcp-tool', profile.roleLayers['mcp-tool']),
      assign(X, 'project-entry', 'entrypoint'),
      assign(S, 'service', profile.roleLayers['service']),
    ],
    profile,
  });
  const result = payload(await f.call('pmc_entrypoints_for', { target: T }));
  assert.deepEqual(result.matches.map(item => item.symbolKey), [K, L, P, X],
    'service and unassigned roots never match; matching keys order by distance then symbol key');
  assert.deepEqual(result.entrypoints.map(item => item.symbolKey), [K, L, P, X],
    'cli-command, cli (entrypoint layer), mcp-tool and the custom entrypoint-layer role are entrypoint evidence');
  assert.deepEqual(result.controllers, []);
  assert.equal(result.matches.some(item => item.symbolKey === S || item.symbolKey === U), false);
});

test('S14 controller route handlers project as controllers, not as entrypoints', async t => {
  const E2 = 'js|src/r-e.js|function|exported|runCli|0';
  const R = 'js|src/r-routes.js|function|exported|getUserRoute|0';
  const T2 = 'js|src/r-t.js|function|exported|handler|0';
  const f = await micro(t, {
    nodes: [E2, R, T2].map(key => mnode(key)),
    links: [{ source: E2, target: R, relation: 'calls' }, { source: R, target: T2, relation: 'calls' }],
    index: mindex([E2, R, T2]),
    assignments: [assign(E2, 'cli', 'entrypoint'), assign(R, 'controller', 'presentation'),
      assign(T2, 'service', 'application')],
  });
  const routed = payload(await f.call('pmc_entrypoints_for', { target: T2 }));
  assert.deepEqual(routed.matches, [
    match(R, 'controller', 'presentation', 1, [T2, R]),
    match(E2, 'cli', 'entrypoint', 2, [T2, R, E2]),
  ]);
  assert.deepEqual(routed.controllers.map(item => item.symbolKey), [R]);
  assert.deepEqual(routed.entrypoints.map(item => item.symbolKey), [E2]);
  assert.equal(routed.entrypoints.some(item => item.symbolKey === R), false,
    'the route handler itself is controller evidence only');
  // A recognized controller root matches at distance 0 AND the walk continues.
  const root = payload(await f.call('pmc_entrypoints_for', { target: R }));
  assert.deepEqual(root.matches, [
    match(R, 'controller', 'presentation', 0, [R]),
    match(E2, 'cli', 'entrypoint', 1, [R, E2]),
  ], 'a d0 controller match never cuts the upstream entrypoint');
  assert.deepEqual(root.controllers.map(item => item.symbolKey), [R]);
  assert.deepEqual(root.entrypoints.map(item => item.symbolKey), [E2]);
});

test('S14 absent, explicit unknown, metadata-only and excluded node kinds never match', async t => {
  const N = 'js|src/g-n.js|function|exported|middle|0';
  const E3 = 'js|src/g-e.js|function|exported|caller|0';
  const T3 = 'js|src/g-t.js|function|exported|sink|0';
  const stale = { roleClassification: { role: 'cli-command', layer: 'entrypoint', confidence: 0.9, evidence: ['stale metadata only'] } };
  for (const variant of ['absent', 'unknown', 'metadata']) {
    const assignments = [assign(E3, 'cli', 'entrypoint')];
    if (variant === 'unknown') assignments.push(explicitUnknown(N));
    const nodes = [mnode(N, variant === 'metadata' ? stale : {}), mnode(E3), mnode(T3)];
    const f = await micro(t, {
      nodes, links: [{ source: N, target: T3, relation: 'calls' }, { source: E3, target: N, relation: 'calls' }],
      index: mindex([N, E3, T3]), assignments,
    });
    const result = payload(await f.call('pmc_entrypoints_for', { target: T3 }));
    assert.deepEqual(result.matches, [match(E3, 'cli', 'entrypoint', 2, [T3, N, E3])],
      `${variant}: the middle node never matches, yet reachability continues through it`);
  }

  const OWNER = 'js|src/g-cls.js|class|exported|Owner|0';
  const WORK = 'js|src/g-cls.js|method|member|Owner.doWork|0';
  const T4 = 'js|src/g-t4.js|function|exported|sink4|0';
  const inherited = await micro(t, {
    nodes: [mnode(OWNER), mnode(WORK), mnode(T4)],
    links: [{ source: WORK, target: T4, relation: 'calls' }],
    index: mindex([OWNER, WORK, T4]),
    assignments: [assign(OWNER, 'cli-command', 'entrypoint')],
    kinds: { [WORK]: 'doc' },
  });
  const inheritedResult = payload(await inherited.call('pmc_entrypoints_for', { target: T4 }));
  assert.deepEqual(inheritedResult.matches, [], 'an excluded doc member inherits nothing despite its container role');
  const selfStart = payload(await inherited.call('pmc_entrypoints_for', { target: WORK }));
  assert.deepEqual(selfStart.matches, [], 'an excluded node kind cannot self-match with a prior assignment');
  assert.equal(selfStart.status, 'resolved');

  const owned = await micro(t, {
    nodes: [mnode(OWNER), mnode(WORK), mnode(T4)],
    links: [{ source: WORK, target: T4, relation: 'calls' }],
    index: mindex([OWNER, WORK, T4]),
    assignments: [assign(OWNER, 'cli-command', 'entrypoint'), assign(WORK, 'controller', 'presentation')],
    kinds: { [WORK]: 'doc' },
  });
  const ownedResult = payload(await owned.call('pmc_entrypoints_for', { target: T4 }));
  assert.deepEqual(ownedResult.matches, [],
    'a prior own assignment on an excluded node kind matches neither');
});

test('S14 cycles terminate with deduplicated matches and insertion-order independent output', async t => {
  const E4 = 'js|src/y-e.js|function|exported|starter|0';
  const CY1 = 'js|src/y-a.js|function|exported|cycleA|0';
  const CY2 = 'js|src/y-b.js|function|exported|cycleB|0';
  const T5 = 'js|src/y-t.js|function|exported|sink5|0';
  const cycle = await micro(t, {
    nodes: [E4, CY1, CY2, T5].map(key => mnode(key)),
    links: [{ source: E4, target: CY1, relation: 'calls' }, { source: CY1, target: CY2, relation: 'calls' },
      { source: CY2, target: CY1, relation: 'calls' }, { source: CY1, target: T5, relation: 'calls' }],
    index: mindex([E4, CY1, CY2, T5]),
    assignments: [assign(E4, 'cli', 'entrypoint')],
  });
  const cycleResult = payload(await cycle.call('pmc_entrypoints_for', { target: T5 }));
  assert.deepEqual(cycleResult.matches, [match(E4, 'cli', 'entrypoint', 2, [T5, CY1, E4])],
    'the cycle visits each key once and matches only the entrypoint');
  assert.equal(new Set(cycleResult.matches.map(item => item.symbolKey)).size, cycleResult.matches.length,
    'dedup key is the canonical symbol key');

  const W1 = 'js|src/w1.js|function|exported|callOne|0';
  const W2 = 'js|src/w2.js|function|exported|callTwo|0';
  const T6 = 'js|src/w6.js|function|exported|sink6|0';
  const link = (source, target) => ({ source, target, relation: 'calls' });
  const first = await micro(t, {
    nodes: [mnode(W1), mnode(W2), mnode(T6)],
    links: [link(W1, T6), link(W2, T6)],
    index: mindex([W1, W2, T6]),
    assignments: [assign(W1, 'cli-command', 'entrypoint'), assign(W2, 'cli-command', 'entrypoint')],
  });
  const second = await micro(t, {
    nodes: [mnode(T6), mnode(W2), mnode(W1)],
    links: [link(W2, T6), link(W1, T6)],
    index: mindex([T6, W2, W1]),
    assignments: [assign(W2, 'cli-command', 'entrypoint'), assign(W1, 'cli-command', 'entrypoint')],
  });
  const a = payload(await first.call('pmc_entrypoints_for', { target: T6 }));
  const b = payload(await second.call('pmc_entrypoints_for', { target: T6 }));
  assert.deepEqual(a.entrypoints.map(item => item.symbolKey), [W1, W2],
    'equal-distance ties order by canonical key, not by insertion order');
  assert.equal(JSON.stringify(a), JSON.stringify(b),
    'reversed node/link/assignment insertion produces byte-identical output');
});

test('S14 ownership guesses stay closed: foreign, prefix and ambiguous containers never inherit', async t => {
  const FOREIGN_OWNER = 'js|src/foreign.js|class|exported|Owner|0';
  const OWN_OWNER = 'js|src/o-cls.js|class|exported|Owner|0';
  const IFACE_OWNER = 'js|src/o-cls.js|interface|exported|Owner|0';
  const WORK = 'js|src/o-cls.js|method|member|Owner.doWork|0';
  const MEMBER_TARGET = 'js|src/o-m.js|method|member|Owner.member|0';
  const PRETENDER = 'js|src/o-cls.js|function|exported|Owner.helper|0';

  const foreign = await micro(t, {
    nodes: [mnode(FOREIGN_OWNER), mnode(MEMBER_TARGET)],
    links: [], index: mindex([FOREIGN_OWNER, MEMBER_TARGET]),
    assignments: [assign(FOREIGN_OWNER, 'cli-command', 'entrypoint')],
  });
  const foreignResult = payload(await foreign.call('pmc_entrypoints_for', { target: MEMBER_TARGET }));
  assert.equal(foreignResult.status, 'resolved');
  assert.deepEqual(foreignResult.entrypoints, [],
    'a cross-file container of the same name never seeds entrypoint evidence');

  const ambiguous = await micro(t, {
    nodes: [mnode(OWN_OWNER), mnode(IFACE_OWNER), mnode(WORK)],
    links: [], index: mindex([OWN_OWNER, IFACE_OWNER, WORK]),
    assignments: [assign(OWN_OWNER, 'cli-command', 'entrypoint')],
  });
  const ambiguousResult = payload(await ambiguous.call('pmc_entrypoints_for', { target: WORK }));
  assert.deepEqual(ambiguousResult.matches, [],
    'two same-file containers of one name fail closed instead of picking a winner');

  const prefix = await micro(t, {
    nodes: [mnode(OWN_OWNER), mnode(PRETENDER)],
    links: [], index: mindex([OWN_OWNER, PRETENDER]),
    assignments: [assign(OWN_OWNER, 'cli-command', 'entrypoint')],
  });
  const prefixResult = payload(await prefix.call('pmc_entrypoints_for', { target: PRETENDER }));
  assert.deepEqual(prefixResult.matches, [],
    'a plain function whose name merely contains a prefix never inherits');

  const SIBLING = 'js|src/other.js|function|exported|sibling|0';
  const APP = 'js|src/app.js|function|exported|appMain|0';
  const fileFixture = await micro(t, {
    nodes: [mnode(APP), mnode(SIBLING)],
    links: [], index: mindex([APP, SIBLING]),
    assignments: [assign(SIBLING, 'cli-command', 'entrypoint')],
  });
  const fileResult = payload(await fileFixture.call('pmc_entrypoints_for', { target: 'src/app.js' }));
  assert.equal(fileResult.status, 'resolved');
  assert.deepEqual(fileResult.matches, [],
    'a file target expands only its exact-path symbols, never a prefix-named sibling');
});

test('S14 a resolved root with no qualifying reach returns empty lists, not guesses', async t => {
  const C1 = 'js|src/z-c.js|function|exported|onlyCaller|0';
  const f = await micro(t, {
    nodes: [mnode(C1), mnode(T)],
    links: [{ source: C1, target: T, relation: 'calls' }],
    index: mindex([C1, T]),
    assignments: [assign(C1, 'service', 'application')],
  });
  const result = payload(await f.call('pmc_entrypoints_for', { target: T }));
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.entrypoints, []);
  assert.deepEqual(result.controllers, []);
});
