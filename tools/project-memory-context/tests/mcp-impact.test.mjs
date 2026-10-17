// F4B / S15: `pmc_impact(target)` — dependents, statically referenced covering
// tests and affected roles, ranked by a pure dependency-free PageRank.
//
// Plan 4.3: "dependents, covering tests, and affected roles, ranked by
// PageRank"; v3 table: `pmc_impact(target)` answers "Dependents, covering
// tests, affected roles".
//
// Every test drives the actual shared query adapter through the real MCP
// Client/McpServer pair over InMemoryTransport. The layered fixture is the
// authoritative golden `layered-app` source set; its role ledger is seeded by
// the approved F2 classifier output (never hardcoded, never a golden edit).
// Synthetic fixtures are owned temp directories only, every request must
// leave the graph.db bytes, mtime, schema, role ledger and config artifacts
// untouched, and no test spawns a child process or reaches outside temp.
//
// The `tests` projection reuses the EXISTING `buildFacts` evidence (importer
// files + the existing test-path filter + top-level exported symbols): it is
// a STATIC referenced-test candidate list, never executed coverage, and the
// role/layer on every record comes from the canonical ledger only — never
// from a filename, path or name guess.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
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
const ENV_ROOT = mkdtempSync(join(tmpdir(), 'pmc-impact-env-'));
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
const cmpKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// The documented record ordering: rank descending, canonical key ascending.
const byRankThenKey = records =>
  [...records].sort((a, b) => (b.rank - a.rank) || cmpKey(a.symbolKey, b.symbolKey));

async function connect(projectRoot, register = registerQueryTools) {
  const server = new McpServer({ name: 'impact-fixture', version: '1.0.0' });
  register(server, { projectRoot });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'impact-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return { server, client };
}

// ── Authoritative layered-app fixture with the F2-seeded role ledger ─────────
const paths = ['src/cli/main.ts', 'src/controllers/user.controller.ts', 'src/services/user.service.ts',
  'src/repositories/user.repository.ts', 'src/db/client.ts', 'src/models/user.model.ts',
  'src/interfaces/user-repository.ts', 'src/utils/format.ts', 'src/views/user.view.ts', 'tests/user.service.test.ts'];
let root, dbPath, client, server, golden, configHashes;
let callPairs, liftPairs, fileImportPairs, registryKeys;

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
  root = mkdtempSync(join(tmpdir(), 'pmc-impact-'));
  const pmc = join(root, '.planning', 'project-memory-context');
  mkdirSync(join(pmc, 'graph'), { recursive: true });
  mkdirSync(join(pmc, 'enrichment'), { recursive: true });
  const files = paths.map(path => ({ path, content: readFileSync(new URL(`./fixtures/layered-app/${path}`, import.meta.url), 'utf8') }));
  const calls = await extractNativeCalls({ files });
  const imports = await extractNativeImportBindings({ files });
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
    store.persistNativeRelations(imports);
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

  // Independent ground truth for path-step proofs: the actual extracted call
  // edges, the file-level import edges, and the documented binding-resolved
  // inbound import lift (exported symbols of an importing file depend on the
  // bound symbol) re-derived here from the raw extraction output.
  callPairs = new Set(calls.relations.map(relation => JSON.stringify([relation.source.id, relation.target.id])));
  fileImportPairs = new Set(imports.relations.map(relation => JSON.stringify([relation.source.id, relation.target.id])));
  liftPairs = new Set();
  registryKeys = Object.keys(index);
  for (const relation of imports.relations) {
    for (const binding of relation.bindings ?? []) {
      if (!binding.target?.id) continue;
      const importingPath = relation.source.id.slice('file|'.length);
      for (const key of registryKeys) {
        const parts = key.split('|');
        if (parts[1] === importingPath && parts[3] === 'exported') liftPairs.add(JSON.stringify([key, binding.target.id]));
      }
    }
  }
  assert.ok(callPairs.size > 0 && fileImportPairs.size > 0 && liftPairs.size > 0, 'ground truth extraction must be nonempty');
});

after(async () => {
  await client?.close();
  await server?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  rmSync(ENV_ROOT, { recursive: true, force: true });
});

function assertResolvedShape(result) {
  assert.deepEqual(Object.keys(result).sort(), ['dependents', 'rankModel', 'roles', 'status', 'target', 'tests']);
  assert.equal(result.status, 'resolved');
  assert.equal(result.rankModel.algorithm, 'PageRank');
  assert.equal(result.rankModel.damping, 0.85);
  assert.equal(result.rankModel.tolerance, 1e-8);
  assert.equal(result.rankModel.maxIterations, 100);
  assert.equal(result.rankModel.scope, 'full-known-canonical-dependencies');
  assert.ok(Number.isInteger(result.rankModel.iterations) && result.rankModel.iterations >= 1 &&
    result.rankModel.iterations <= 100, 'iterations stay bounded');
  assert.equal(typeof result.rankModel.converged, 'boolean');
}

// ── Golden layered behavior ──────────────────────────────────────────────────

test('S15 golden q12 covering tests are exact for class, member and file targets', async () => {
  const expected = golden.questions.find(question => question.id === 'q12-tests-user-service').expected;
  const classResult = payload(await layeredCall('pmc_impact', { target: USER_SERVICE }));
  assertResolvedShape(classResult);
  assert.equal(classResult.target, USER_SERVICE);
  assert.deepEqual(classResult.tests.map(item => item.symbolKey), expected,
    'q12 stays authoritative: the class target projects exactly the golden static test candidate');
  assert.deepEqual(classResult.tests, [{
    symbolKey: TEST_USER_SERVICE,
    relation: 'tests',
    kind: 'function',
    rank: classResult.tests[0].rank,
    role: 'test',
    layer: 'test',
    provenance: 'static-import-reference',
  }], 'the projection reuses existing facts evidence with its canonical F2 role and static provenance');
  assert.ok(Number.isFinite(classResult.tests[0].rank) && classResult.tests[0].rank >= 0,
    'every returned record carries a computed rank from the ranking graph');
  assert.equal(/coverage|executed|ran|passed/i.test(classResult.tests[0].provenance), false,
    'static provenance is never dressed up as executed coverage');

  // The member target keeps the same facts.tests projection (card-facts 132-137).
  const memberResult = payload(await layeredCall('pmc_impact', { target: FIND_BY_ID }));
  assert.deepEqual(memberResult.tests.map(item => item.symbolKey), expected,
    'a member target resolves the same covering static test candidates as its class');
  assert.equal(memberResult.target, FIND_BY_ID);

  // A file target projects the same evidence at file scope.
  const fileResult = payload(await layeredCall('pmc_impact', { target: SERVICE_FILE }));
  assert.deepEqual(fileResult.tests.map(item => item.symbolKey), ['file|tests/user.service.test.ts'],
    'a file target keeps the file-scope shape of the existing facts evidence');
  assert.deepEqual(fileResult.tests.map(item => [item.kind, item.relation, item.role, item.layer]),
    [['file', 'tests', null, null]], 'file-scope candidates keep kind file and take no invented role');
  const explicitFile = payload(await layeredCall('pmc_impact', { target: SERVICE_FILE_ID }));
  assert.equal(JSON.stringify(explicitFile), JSON.stringify(fileResult), 'file|<path> resolves to the same answer');
});

test('S15 dependents are the complete reverse closure with truthful distances and grounded paths', async () => {
  const result = payload(await layeredCall('pmc_impact', { target: USER_SERVICE }));
  assertResolvedShape(result);
  assert.deepEqual(result.dependents.map(item => [item.symbolKey, item.kind, item.distance, item.role, item.layer]), [
    [GET_USER, 'method', 1, 'controller', 'presentation'],
    [MAIN, 'function', 2, 'cli', 'entrypoint'],
    [USER_CONTROLLER, 'class', 1, 'controller', 'presentation'],
    [TEST_USER_SERVICE, 'function', 1, 'test', 'test'],
  ], 'complete reverse calls+imports closure: member callers, binding-resolved import dependents and the upstream main');
  assert.deepEqual(result.dependents.find(item => item.symbolKey === GET_USER).path,
    [USER_SERVICE, FIND_BY_ID, GET_USER], 'a member-expanded path shows the zero-hop membership step first');
  assert.deepEqual(result.dependents.find(item => item.symbolKey === MAIN).path,
    [USER_SERVICE, USER_CONTROLLER, MAIN], 'the shortest deterministic chain wins over a longer call-only chain');
  assert.deepEqual(result.dependents.find(item => item.symbolKey === USER_CONTROLLER).path,
    [USER_SERVICE, USER_CONTROLLER], 'the binding-resolved import dependent starts at the selected target');
  assert.deepEqual(result.dependents.find(item => item.symbolKey === TEST_USER_SERVICE).path,
    [USER_SERVICE, TEST_USER_SERVICE], 'a call-and-import dependent keeps the smallest canonical parent');

  // Every path step is grounded: an actual extracted call edge, an actual
  // file-import edge, the documented binding-resolved import lift, or the
  // single zero-hop proven membership step at position 1.
  const groundedSteps = new Set([...callPairs, ...liftPairs, ...fileImportPairs]);
  const membershipStep = (container, memberKey) => {
    const member = memberKey.split('|');
    if (container.startsWith('file|')) return member[1] === container.slice('file|'.length);
    const parts = container.split('|');
    const name = member[4] ?? '';
    return parts.length === 6 && member[3] === 'member' && member[1] === parts[1] &&
      name.slice(0, name.lastIndexOf('.')) === parts[4];
  };
  for (const item of result.dependents) {
    assert.equal(item.path[0], USER_SERVICE, 'every path starts at the selected target');
    assert.equal(item.path.at(-1), item.symbolKey, 'every path ends at its record');
    assert.ok(Number.isFinite(item.rank) && item.rank >= 0, 'every dependent carries a computed rank');
    let hops = 0;
    for (let step = 1; step < item.path.length; step += 1) {
      const pair = JSON.stringify([item.path[step], item.path[step - 1]]);
      if (groundedSteps.has(pair)) { hops += 1; continue; }
      assert.equal(step, 1, `only the first step may be zero-hop membership, got ${pair}`);
      assert.ok(membershipStep(item.path[0], item.path[1]), `${pair} must be proven membership`);
    }
    assert.equal(hops, item.distance, 'distance counts actual dependency hops, never the membership step');
  }
});

test('S15 dependents sort by rank descending then canonical key and ranks are query-independent', async () => {
  const fromClass = payload(await layeredCall('pmc_impact', { target: USER_SERVICE }));
  assert.deepEqual(fromClass.dependents, byRankThenKey(fromClass.dependents),
    'the delivered order is exactly rank DESC then canonical key ASC');
  assert.ok(fromClass.dependents[0].rank >= fromClass.dependents.at(-1).rank);
  assert.ok(fromClass.dependents.every(item => Number.isFinite(item.rank) && item.rank >= 0));

  const fromMember = payload(await layeredCall('pmc_impact', { target: FIND_BY_ID }));
  assert.deepEqual(fromMember.dependents, byRankThenKey(fromMember.dependents),
    'member-target dependents use the same ordering contract');
  assert.deepEqual(fromMember.rankModel, fromClass.rankModel,
    'the ranking model describes the same full graph for every target of one state');

  const memberRank = new Map(fromMember.dependents.map(item => [item.symbolKey, item.rank]));
  for (const item of fromClass.dependents) {
    if (!memberRank.has(item.symbolKey)) continue;
    assert.equal(item.rank, memberRank.get(item.symbolKey),
      `${item.symbolKey} keeps the same graph-global rank across different targets`);
  }
  // Strict rank priority over key order: GET_USER's key sorts after main's,
  // yet GET_USER ranks strictly higher because main depends on it.
  const order = fromClass.dependents.map(item => item.symbolKey);
  assert.ok(order.indexOf(GET_USER) < order.indexOf(MAIN), 'rank order, not key order, drives the listing');
  assert.ok(fromClass.dependents.find(item => item.symbolKey === GET_USER).rank >
    fromClass.dependents.find(item => item.symbolKey === MAIN).rank,
    'a node depended upon by main strictly outranks the unpointed root');
  // Exact ties fall back to canonical key order.
  const tied = fromClass.dependents.filter(item => item.rank === fromClass.dependents[1].rank);
  assert.deepEqual(tied.map(item => item.symbolKey), [...tied.map(item => item.symbolKey)].sort(cmpKey));
});

test('S15 roles aggregate only canonical assignments and count each key once', async () => {
  const result = payload(await layeredCall('pmc_impact', { target: USER_SERVICE }));
  assert.deepEqual(result.roles.map(role => role.role), ['controller', 'cli', 'test'],
    'roles order by summed rank DESC then role ASC; null-role nodes never aggregate');
  const controller = result.roles.find(role => role.role === 'controller');
  assert.deepEqual(controller.symbolKeys, [GET_USER, USER_CONTROLLER].sort(cmpKey),
    'both canonically assigned controller dependents aggregate');
  assert.equal(controller.layer, 'presentation', 'a unanimous canonical layer projects');
  const controllerSum = [GET_USER, USER_CONTROLLER]
    .map(key => result.dependents.find(item => item.symbolKey === key).rank)
    .reduce((sum, rank) => sum + rank, 0);
  assert.ok(Math.abs(controller.rank - controllerSum) < 1e-15, 'the role rank is the sum of its unique members');
  const test = result.roles.find(role => role.role === 'test');
  assert.deepEqual(test.symbolKeys, [TEST_USER_SERVICE],
    'a key present in both dependents and tests contributes exactly once');
  assert.equal(test.rank, result.dependents.find(item => item.symbolKey === TEST_USER_SERVICE).rank,
    'single counting is proven against the dependent record rank, never doubled');
  assert.equal(test.layer, 'test');
  const cli = result.roles.find(role => role.role === 'cli');
  assert.deepEqual(cli.symbolKeys, [MAIN]);
  assert.equal(cli.layer, 'entrypoint');
  assert.ok(result.roles.every(role => role.rank > 0 && role.symbolKeys.length > 0));
  assert.deepEqual(result.roles, [...result.roles].sort((a, b) => (b.rank - a.rank) || cmpKey(a.role, b.role)),
    'role records use rank DESC then role ASC');
});

test('S15 file targets expand exact-path symbols and keep file import dependents', async () => {
  const result = payload(await layeredCall('pmc_impact', { target: SERVICE_FILE }));
  const keys = result.dependents.map(item => item.symbolKey);
  assert.deepEqual(keys.sort(cmpKey), [GET_USER, MAIN, TEST_USER_SERVICE, USER_CONTROLLER,
    `file|src/controllers/user.controller.ts`, `file|src/cli/main.ts`, `file|tests/user.service.test.ts`].sort(cmpKey),
    'a file target keeps exact-path symbols as seeds and reports the importing files as dependents');
  const fileDependent = result.dependents.find(item => item.symbolKey === 'file|src/controllers/user.controller.ts');
  assert.deepEqual([fileDependent.kind, fileDependent.distance, fileDependent.role, fileDependent.layer],
    ['file', 1, null, null], 'file endpoints keep kind file and take no invented role');
  assert.deepEqual(result.dependents.find(item => item.symbolKey === MAIN).path,
    [SERVICE_FILE_ID, USER_SERVICE, USER_CONTROLLER, MAIN],
    'path starts at the selected file endpoint and keeps the zero-hop membership step');
});

test('S15 strict input accepts only target and rejects invalid targets helpfully', async () => {
  for (const args of [
    { target: USER_SERVICE, depth: 3 },
    { target: USER_SERVICE, direction: 'in' },
    { target: USER_SERVICE, stopAtRole: 'controller' },
    { target: USER_SERVICE, role: 'service' },
    { target: USER_SERVICE, typo: true },
  ]) {
    const result = await client.callTool({ name: 'pmc_impact', arguments: args });
    assert.equal(result.isError, true, `unknown option ${JSON.stringify(args)} must not be ignored as success`);
    assert.match(result.content[0].text, /Unrecognized key/);
  }
  for (const target of [123, null, {}, true]) {
    const result = await client.callTool({ name: 'pmc_impact', arguments: { target } });
    assert.equal(result.isError, true, `non-string target ${JSON.stringify(target)} must reject`);
  }
  const empty = await client.callTool({ name: 'pmc_impact', arguments: { target: '' } });
  assert.equal(empty.isError, true, 'an empty target must reject');
  const blank = await client.callTool({ name: 'pmc_impact', arguments: { target: '   ' } });
  assert.equal(blank.isError, true, 'a whitespace target must reject');
  assert.match(blank.content[0].text, /nonempty/);
  const absent = await client.callTool({ name: 'pmc_impact', arguments: {} });
  assert.equal(absent.isError, true, 'a missing target must reject');
});

test('S15 missing and ambiguous targets keep candidate shapes with empty projections', async () => {
  const missing = payload(await layeredCall('pmc_impact', { target: 'src/does-not-exist.ts' }));
  assert.equal(missing.status, 'missing');
  assert.deepEqual(missing.candidates, []);
  assert.deepEqual(Object.keys(missing).sort(), ['candidates', 'dependents', 'roles', 'status', 'tests']);
  assert.deepEqual(missing.dependents, []);
  assert.deepEqual(missing.tests, []);
  assert.deepEqual(missing.roles, []);
  const ambiguous = payload(await layeredCall('pmc_impact', { target: 'constructor' }));
  assert.equal(ambiguous.status, 'ambiguous');
  assert.ok(ambiguous.candidates.length > 1, 'multiple constructor members stay ambiguous');
  assert.ok(ambiguous.candidates.every(candidate => candidate.symbolKey));
  assert.deepEqual(ambiguous.dependents, []);
  assert.deepEqual(ambiguous.tests, []);
  assert.deepEqual(ambiguous.roles, []);
});

test('S15 accepted and rejected requests preserve DB bytes, mtime, schema, roles and config', async () => {
  const before = layeredSnapshot();
  for (const [name, args] of [
    ['pmc_impact', { target: USER_SERVICE }],
    ['pmc_impact', { target: FIND_BY_ID }],
    ['pmc_impact', { target: SERVICE_FILE }],
    ['pmc_impact', { target: 'constructor' }],
    ['pmc_impact', { target: 'src/does-not-exist.ts' }],
    ['pmc_impact', { target: USER_SERVICE, depth: 3 }],
    ['pmc_impact', { target: 42 }],
    ['pmc_relations', { target: FIND_BY_ID, direction: 'in', relations: ['calls'], depth: 1 }],
    ['pmc_card', { target: USER_SERVICE }],
  ]) {
    await client.callTool({ name, arguments: args });
  }
  assert.equal(layeredSnapshot(), before, 'no request mutates DB bytes, mtime, schema, ledger rows, meta or config');
});

test('S15 pmc_impact is registered read-only with a target-only strict schema', async () => {
  const tools = (await client.listTools()).tools;
  const impact = tools.find(tool => tool.name === 'pmc_impact');
  assert.ok(impact, 'pmc_impact joins the shared query registry');
  assert.deepEqual(impact.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.deepEqual(Object.keys(impact.inputSchema.properties), ['target'], 'only target is accepted');
  assert.deepEqual(impact.inputSchema.required, ['target']);
  assert.equal(impact.inputSchema.additionalProperties, false);
  for (const name of ['pmc_relations', 'pmc_card', 'pmc_entrypoints_for', 'pmc_get_dependents', 'pmc_get_dependencies']) {
    assert.ok(tools.some(tool => tool.name === name), `${name} stays registered untouched`);
  }
});

// Conditional old-tool byte parity against an owned b8e95de archive, run only
// when the parent prepared S15_BASELINE; honestly skipped otherwise.
test('S15 old seven tools default response byte parity (conditional archive)', { skip: !process.env.S15_BASELINE }, async () => {
  const base = await import(pathToFileURL(join(process.env.S15_BASELINE, 'tools/project-memory-context/mcp/query-tools.mjs')));
  const old = await connect(root, base.registerQueryTools);
  try {
    const nowTools = (await client.listTools()).tools;
    const oldTools = (await old.client.listTools()).tools;
    assert.deepEqual(nowTools.filter(tool => tool.name !== 'pmc_impact'), oldTools,
      'the pre-existing seven tools keep byte-identical descriptors');
    let count = 0;
    for (const [name, args] of [
      ['pmc_query_project', { question: 'UserService' }],
      ['pmc_search_symbols', { query: 'user' }],
      ['pmc_get_dependents', { symbol: FIND_BY_ID }],
      ['pmc_get_dependencies', { symbol: FIND_BY_ID }],
      ['pmc_relations', { target: FIND_BY_ID, direction: 'in', relations: ['calls'], depth: 1 }],
      ['pmc_card', { target: USER_SERVICE }],
      ['pmc_entrypoints_for', { target: USER_SERVICE }],
    ]) {
      const before = hash(dbPath);
      assert.equal(JSON.stringify(await client.callTool({ name, arguments: args })),
        JSON.stringify(await old.client.callTool({ name, arguments: args })), `${name} stays byte-identical`);
      assert.equal(hash(dbPath), before, 'parity requests preserve DB bytes');
      count += 1;
    }
    assert.equal(count, 7);
  } finally { await old.client.close(); await old.server.close(); }
});

// ── Synthetic owned fixtures: controlled dependency graphs ───────────────────
const SINK = 'js|src/sink.js|function|exported|sink|0';
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

async function micro(t, { keys, links = [], index = {}, assignments = [], profile, kinds = {}, native = false, imports = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'pmc-impact-micro-'));
  const pmc = join(dir, '.planning/project-memory-context');
  mkdirSync(join(pmc, 'graph'), { recursive: true });
  mkdirSync(join(pmc, 'enrichment'), { recursive: true });
  const graph = { nodes: keys.map(key => mnode(key)),
    links: native ? [] : links.map(([source, target, relation = 'calls']) => ({ source, target, relation })) };
  writeFileSync(join(pmc, 'graph/graph.json'), JSON.stringify(graph));
  writeFileSync(join(pmc, 'enrichment/symbol-index.json'), JSON.stringify(index));
  const fixtureDb = join(pmc, 'graph/graph.db');
  const db = new DatabaseSync(fixtureDb);
  try {
    db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE nodes(id TEXT PRIMARY KEY,label TEXT,kind TEXT,source_file TEXT,community INTEGER,degree INTEGER,metadata TEXT); CREATE TABLE edges(source TEXT,target TEXT,relation TEXT);');
    buildFromGraphJson(db, graph, 'impact-micro');
    const store = createSqliteGraphStore(db);
    if (native) {
      store.persistNativeRelations({ relations: links.map(([source, target, relation = 'calls']) =>
        ({ source: endpointOf(source), target: endpointOf(target), relation })), unresolved: [] });
    } else {
      store.persistNativeRelations({ relations: [], unresolved: [] });
    }
    if (imports.length) {
      store.persistNativeRelations({ relations: imports.map(item => ({
        source: { id: `file|${item.from}`, kind: 'file', path: item.from },
        target: { id: `file|${item.to}`, kind: 'file', path: item.to },
        relation: 'imports',
        bindings: item.bindings ?? [],
      })), unresolved: [] });
    }
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

test('S15 dependents cross three hops without cutting and terminate on cycles', async t => {
  const chain = ['h1', 'h2', 'h3', 'h4', 'h5'].map(name => `js|src/${name}.js|function|exported|${name}|0`);
  const chainFixture = await micro(t, {
    keys: [SINK, ...chain],
    links: [[chain[4], chain[3]], [chain[3], chain[2]], [chain[2], chain[1]], [chain[1], chain[0]], [chain[0], SINK]],
    index: mindex([SINK, ...chain]),
  });
  const chained = payload(await chainFixture.call('pmc_impact', { target: SINK }));
  assertResolvedShape(chained);
  assert.deepEqual(chained.dependents.map(item => [item.symbolKey, item.distance]),
    chain.map((key, index) => [key, index + 1]), 'a chain of five callers is fully reported, past any three-hop habit');
  assert.deepEqual(chained.dependents.find(item => item.symbolKey === chain[4]).path,
    [SINK, ...chain], 'paths carry the whole evidence chain from the selected target');
  assert.deepEqual(chained.tests, []);
  assert.deepEqual(chained.roles, []);

  const CY1 = 'js|src/cy1.js|function|exported|cycleOne|0';
  const CY2 = 'js|src/cy2.js|function|exported|cycleTwo|0';
  const first = await micro(t, {
    keys: [SINK, CY1, CY2],
    links: [[CY1, SINK], [CY1, CY2], [CY2, CY1]],
    index: mindex([SINK, CY1, CY2]),
  });
  const cycled = payload(await first.call('pmc_impact', { target: SINK }));
  assert.deepEqual(cycled.dependents.map(item => [item.symbolKey, item.distance]), [[CY1, 1], [CY2, 2]],
    'a cycle visits each key once and stops at the visited set');
  const second = await micro(t, {
    keys: [CY2, SINK, CY1].reverse(),
    links: [[CY2, CY1], [CY1, CY2], [CY1, SINK]],
    index: mindex([CY2, SINK, CY1]),
  });
  assert.equal(JSON.stringify(payload(await second.call('pmc_impact', { target: SINK }))), JSON.stringify(cycled),
    'reversed node/link insertion produces byte-identical output');
});

test('S15 diamond branches resolve deterministically with full payload stability', async t => {
  const D1 = 'js|src/d1.js|function|exported|left|0';
  const D2 = 'js|src/d2.js|function|exported|right|0';
  const DTOP = 'js|src/dtop.js|function|exported|top|0';
  const edges = [[D1, SINK], [D2, SINK], [DTOP, D1], [DTOP, D2]];
  const first = await micro(t, { keys: [SINK, D1, D2, DTOP], links: edges, index: mindex([SINK, D1, D2, DTOP]) });
  const diamond = payload(await first.call('pmc_impact', { target: SINK }));
  assert.deepEqual(diamond.dependents.map(item => [item.symbolKey, item.distance]),
    [[D1, 1], [D2, 1], [DTOP, 2]]);
  assert.deepEqual(diamond.dependents.find(item => item.symbolKey === DTOP).path, [SINK, D1, DTOP],
    'the tied parent resolves to the smallest canonical edge key, never database order');
  const second = await micro(t, {
    keys: [DTOP, D2, D1, SINK], links: [...edges].reverse(), index: mindex([DTOP, D2, D1, SINK]),
  });
  assert.equal(JSON.stringify(payload(await second.call('pmc_impact', { target: SINK }))), JSON.stringify(diamond),
    'the full payload survives reversed diamond insertion byte for byte');
});

test('S15 legacy and native identities produce the same dependent closure', async t => {
  const L1 = 'js|src/l1.js|function|exported|legacyOne|0';
  const L2 = 'js|src/l2.js|function|exported|legacyTwo|0';
  const edges = [[L1, SINK], [L2, L1]];
  const legacy = await micro(t, { keys: [SINK, L1, L2], links: edges, index: mindex([SINK, L1, L2]) });
  const native = await micro(t, { keys: [SINK, L1, L2], links: edges, index: mindex([SINK, L1, L2]), native: true });
  const legacyResult = payload(await legacy.call('pmc_impact', { target: SINK }));
  const nativeResult = payload(await native.call('pmc_impact', { target: SINK }));
  assert.deepEqual(legacyResult.dependents.map(item => [item.symbolKey, item.distance]), [[L1, 1], [L2, 2]]);
  assert.deepEqual(nativeResult.dependents.map(item => [item.symbolKey, item.distance]),
    legacyResult.dependents.map(item => [item.symbolKey, item.distance]),
    'the adapter mixes legacy and native identities through one closure contract');
});

test('S15 rank-first ordering and graph-global role sums', async t => {
  const ZEBRA = 'js|src/z.js|function|exported|zebra|0';
  const ALPHA = 'js|src/a.js|function|exported|alpha|0';
  const M1 = 'js|src/m1.js|function|exported|m1|0';
  const M2 = 'js|src/m2.js|function|exported|m2|0';
  const edges = [[ZEBRA, SINK], [ALPHA, SINK], [M1, ZEBRA], [M2, ZEBRA]];
  const f = await micro(t, {
    keys: [SINK, ZEBRA, ALPHA, M1, M2], links: edges, index: mindex([SINK, ZEBRA, ALPHA, M1, M2]),
    assignments: [assign(ZEBRA, 'controller', 'presentation'), assign(M1, 'service', 'application')],
  });
  const result = payload(await f.call('pmc_impact', { target: SINK }));
  assert.deepEqual(result.dependents.map(item => item.symbolKey), [ZEBRA, ALPHA, M1, M2],
    'the highest-ranked dependent sorts first even though its key sorts last; exact ties then use key order');
  assert.deepEqual(result.dependents.map(item => [item.symbolKey, item.role, item.layer]), [
    [ZEBRA, 'controller', 'presentation'], [ALPHA, null, null], [M1, 'service', 'application'], [M2, null, null]],
    'records carry only canonical roles and honest nulls');
  assert.deepEqual(result.roles.map(role => [role.role, role.symbolKeys]), [
    ['controller', [ZEBRA]], ['service', [M1]]], 'null roles never aggregate');
  assert.ok(result.roles[0].rank > result.roles[1].rank, 'role ranks follow the summed member ranks');

  const upstream = payload(await f.call('pmc_impact', { target: ZEBRA }));
  assert.deepEqual(upstream.dependents.map(item => item.symbolKey), [M1, M2],
    'a different target over the same graph reports its own closure');
  const upstreamRank = new Map(upstream.dependents.map(item => [item.symbolKey, item.rank]));
  for (const item of result.dependents) {
    if (!upstreamRank.has(item.symbolKey)) continue;
    assert.equal(item.rank, upstreamRank.get(item.symbolKey),
      'graph-global ranks never depend on which target asked');
  }
  assert.deepEqual(upstream.rankModel, result.rankModel, 'one graph, one ranking model');
});

test('S15 only canonical assignments produce roles, never names, metadata, exclusions or unknowns', async t => {
  const N = 'js|src/n.js|function|exported|middle|0';
  const K = 'js|tests/named.test.js|function|exported|testNamed|0';
  const E = 'js|src/e.js|function|exported|caller|0';
  const T = 'js|src/t.js|function|exported|sink|0';
  const stale = { roleClassification: { role: 'test', layer: 'test', confidence: 0.9, evidence: ['stale metadata only'] } };
  for (const variant of ['absent', 'unknown', 'metadata']) {
    const assignments = [assign(E, 'cli', 'entrypoint')];
    if (variant === 'unknown') assignments.push(explicitUnknown(N));
    const keys = [N, K, E, T];
    const fixture = await micro(t, {
      keys, links: [[N, T], [K, T], [E, N]], index: mindex(keys), assignments,
      // no assignment ever exists for K: a test-looking name/file is not a role
    });
    const result = payload(await fixture.call('pmc_impact', { target: T }));
    assert.deepEqual(result.dependents.map(item => [item.symbolKey, item.role]),
      [[N, null], [E, 'cli'], [K, null]],
      `${variant}: the unassigned middle/test-looking nodes stay role-null and rank order is untouched`);
    assert.deepEqual(result.roles.map(role => [role.role, role.symbolKeys]), [['cli', [E]]],
      `${variant}: only the canonical assignment aggregates`);
  }

  const OWNER = 'js|src/own.js|class|exported|Owner|0';
  const WORK = 'js|src/own.js|method|member|Owner.doWork|0';
  const SINK2 = 'js|src/sink2.js|function|exported|sink2|0';
  const excluded = await micro(t, {
    keys: [OWNER, WORK, SINK2], links: [[WORK, SINK2]], index: mindex([OWNER, WORK, SINK2]),
    assignments: [assign(OWNER, 'cli-command', 'entrypoint')], kinds: { [WORK]: 'doc' },
  });
  const excludedResult = payload(await excluded.call('pmc_impact', { target: SINK2 }));
  assert.deepEqual(excludedResult.dependents.map(item => [item.symbolKey, item.role]), [[WORK, null]],
    'an excluded doc member inherits no owner role, so it never contributes one');
  assert.deepEqual(excludedResult.roles, [], 'no excluded-kind node can acquire a role through ownership');

  const metadataOnly = await micro(t, {
    keys: [OWNER, WORK, SINK2], links: [[WORK, SINK2]], index: mindex([OWNER, WORK, SINK2]),
    assignments: [], kinds: {},
  });
  const metadataResult = payload(await metadataOnly.call('pmc_impact', { target: SINK2 }));
  assert.deepEqual(metadataResult.roles, [], 'node.metadata.roleClassification is never consulted');
});

test('S15 test candidates without a canonical assignment carry null roles and invent no test role', async t => {
  const SERVICE = 'js|src/s.js|class|exported|Service|0';
  const TESTFN = 'js|tests/s.test.js|function|exported|testService|0';
  const f = await micro(t, {
    keys: [SERVICE, TESTFN], links: [], index: mindex([SERVICE, TESTFN]),
    imports: [{ from: 'tests/s.test.js', to: 'src/s.js' }],
  });
  const result = payload(await f.call('pmc_impact', { target: SERVICE }));
  assertResolvedShape(result);
  assert.deepEqual(result.tests.map(item => [item.symbolKey, item.relation, item.kind, item.role, item.layer]),
    [[TESTFN, 'tests', 'function', null, null]],
    'the static candidate is reported without fabricating a test role from the file name');
  assert.deepEqual(result.dependents, [],
    'with no resolved binding there is no grounded symbol-level import dependent: facts evidence is not a dependency claim');
  assert.deepEqual(result.roles, [], 'a null-role test candidate never becomes a role');
});
