import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerQueryTools } from '../mcp/query-tools.mjs';
import { extractNativeCalls } from '../src/relations/native-calls.mjs';
import { extractNativeImportBindings } from '../src/relations/native-import-bindings.mjs';
import { buildFromGraphJson, createSqliteGraphStore, hashGraphJson } from '../src/graph-store/graph-db.mjs';

const SERVICE = 'ts|src/services/user.service.ts|method|member|UserService.findById|1';
const FORMAT = 'ts|src/utils/format.ts|function|exported|formatName|1';
const paths = ['src/cli/main.ts', 'src/controllers/user.controller.ts', 'src/services/user.service.ts',
  'src/repositories/user.repository.ts', 'src/db/client.ts', 'src/models/user.model.ts',
  'src/interfaces/user-repository.ts', 'src/utils/format.ts', 'src/views/user.view.ts', 'tests/user.service.test.ts'];
let root, dbPath, client, server, golden;
async function connect(projectRoot) {
  const server = new McpServer({ name: 'facts-fixture', version: '1.0.0' });
  registerQueryTools(server, { projectRoot });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'facts-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return { server, client };
}
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'pmc-mcp-relations-'));
  const pmc = join(root, '.planning', 'project-memory-context');
  mkdirSync(join(pmc, 'graph'), { recursive: true }); mkdirSync(join(pmc, 'enrichment'), { recursive: true });
  const files = paths.map(path => ({ path, content: readFileSync(new URL(`./fixtures/layered-app/${path}`, import.meta.url), 'utf8') }));
  const calls = await extractNativeCalls({ files });
  const graph = { nodes: calls.symbols.map(symbol => ({ id: symbol.id, label: symbol.id.split('|')[4], kind: symbol.kind,
    source_file: symbol.path, metadata: { symbolKey: symbol.id, semanticSummary: symbol.id === SERVICE ? 'Finds a user by ID.' : '' } })), links: [] };
  const json = JSON.stringify(graph); writeFileSync(join(pmc, 'graph', 'graph.json'), json);
  dbPath = join(pmc, 'graph', 'graph.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE nodes(id TEXT PRIMARY KEY,label TEXT,kind TEXT,source_file TEXT,community INTEGER,degree INTEGER,metadata TEXT); CREATE TABLE edges(source TEXT,target TEXT,relation TEXT);');
    buildFromGraphJson(db, graph, hashGraphJson(json));
    const store = createSqliteGraphStore(db); store.persistNativeRelations(calls);
    store.persistNativeRelations(await extractNativeImportBindings({ files }));
  } finally { db.close(); }
  const index = Object.fromEntries(calls.symbols.map(symbol => [symbol.id, { graphNodeId: symbol.id,
    semanticSummary: symbol.id === SERVICE ? 'Finds a user by ID.' : '' }]));
  writeFileSync(join(pmc, 'enrichment', 'symbol-index.json'), JSON.stringify(index));
  writeFileSync(join(pmc, 'enrichment', 'worklist.json'), JSON.stringify(calls.symbols.map(symbol => ({ symbolKey: symbol.id,
    name: symbol.id.split('|')[4], filePath: symbol.path, kind: symbol.kind }))));
  golden = JSON.parse(readFileSync(new URL('./fixtures/layered-app/expected.json', import.meta.url), 'utf8'));
  ({ client, server } = await connect(root));
});
after(async () => { await client?.close(); await server?.close(); if (root) rmSync(root, { recursive: true, force: true }); });
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, result.content[0]?.text);
  return JSON.parse(result.content[0].text);
}

test('MCP pmc_relations answers exact Q1-Q3 typed canonical edges', async () => {
  const before = hash(dbPath);
  for (const [target, direction, side, question] of [
    [SERVICE, 'in', 'source', 'q1-callers-user-service-find-by-id'],
    [SERVICE, 'out', 'target', 'q2-callees-user-service-find-by-id'],
    [FORMAT, 'in', 'source', 'q3-dependents-format-name'],
  ]) {
    const result = await call('pmc_relations', { target, direction, relations: ['calls'], depth: 1 });
    assert.equal(result.status, 'resolved');
    assert.deepEqual(result.edges.map(edge => edge[side].symbolKey).sort(),
      golden.questions.find(item => item.id === question).expected.slice().sort());
    assert.ok(result.edges.every(edge => edge.relation === 'calls' && edge.source.kind && edge.target.kind));
  }
  assert.equal(hash(dbPath), before);
});
test('MCP card returns facts plus existing enrichment and supports file cards', async () => {
  const before = hash(dbPath);
  const card = await call('pmc_card', { target: 'src/services/user.service.ts#findById' });
  assert.equal(card.facts.id, SERVICE);
  assert.equal(card.enrichment, 'Finds a user by ID.');
  assert.deepEqual(card.facts.callers.map(item => item.symbolKey).sort(),
    golden.questions.find(item => item.id === 'q1-callers-user-service-find-by-id').expected.slice().sort());
  const file = await call('pmc_card', { target: 'src/services/user.service.ts' });
  assert.equal(file.facts.kind, 'file'); assert.ok(file.facts.exports.length);
  assert.equal(hash(dbPath), before);
});
test('MCP direction aliases/depth and legacy aliases preserve their array response shape', async () => {
  const inbound = await call('pmc_relations', { target: SERVICE, direction: 'inbound', relations: ['calls'], depth: 2 });
  assert.ok(inbound.edges.some(edge => edge.source.symbolKey.includes('main|0')));
  const dependents = await call('pmc_get_dependents', { symbol: SERVICE });
  assert.ok(Array.isArray(dependents));
  assert.deepEqual(dependents.map(symbol => symbol.symbolKey).sort(),
    golden.questions.find(item => item.id === 'q1-callers-user-service-find-by-id').expected.slice().sort());
  const dependencies = await call('pmc_get_dependencies', { symbol: SERVICE });
  assert.ok(dependencies.every(symbol => typeof symbol.semanticSummary === 'string'));
});
test('MCP ambiguous targets return candidates, not an invented unique identity', async () => {
  const card = await call('pmc_card', { target: 'constructor' });
  assert.equal(card.status, 'ambiguous');
  assert.ok(card.candidates.length > 1 && card.candidates.every(candidate => candidate.symbolKey));
});
test('MCP file import depth is honored rather than silently ignored', async () => {
  const before = hash(dbPath);
  const request = { target: 'src/services/user.service.ts', direction: 'out', relations: ['imports'] };
  const first = await call('pmc_relations', { ...request, depth: 1 });
  const second = await call('pmc_relations', { ...request, depth: 2 });
  const reachesClient = result => result.edges.some(edge => edge.source.path === 'src/repositories/user.repository.ts' && edge.target.path === 'src/db/client.ts');
  assert.equal(reachesClient(first), false);
  assert.equal(reachesClient(second), true);
  assert.equal(hash(dbPath), before);
});
test('MCP file calls include the requested native members instead of ignoring calls', async () => {
  const result = await call('pmc_relations', { target: 'src/services/user.service.ts', direction: 'out', relations: ['calls'], depth: 1 });
  assert.deepEqual(result.edges.map(edge => edge.target.symbolKey).sort(),
    golden.questions.find(item => item.id === 'q2-callees-user-service-find-by-id').expected.slice().sort());
});
test('missing graph.db is an explicit tool error and creates no database', async () => {
  const missing = mkdtempSync(join(tmpdir(), 'pmc-mcp-missing-'));
  const connected = await connect(missing);
  try {
    const result = await connected.client.callTool({ name: 'pmc_card', arguments: { target: SERVICE } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /graph\.db is unavailable/);
    assert.equal(existsSync(join(missing, '.planning', 'project-memory-context', 'graph', 'graph.db')), false);
  } finally { await connected.client.close(); await connected.server.close(); rmSync(missing, { recursive: true, force: true }); }
});
test('legacy aliases preserve pre-canonical graph identities even when graph.db exists', async () => {
  const legacy = mkdtempSync(join(tmpdir(), 'pmc-mcp-legacy-'));
  const pmc = join(legacy, '.planning', 'project-memory-context');
  mkdirSync(join(pmc, 'graph'), { recursive: true }); mkdirSync(join(pmc, 'enrichment'), { recursive: true });
  const alpha = 'js|a.js|function|exported|alpha|0', beta = 'js|b.js|function|exported|beta|0';
  const graph = { nodes: [{ id: 'a', label: 'alpha', kind: 'function', source_file: 'a.js' },
    { id: 'b', label: 'beta', kind: 'function', source_file: 'b.js' }], links: [{ source: 'a', target: 'b', relation: 'calls' }] };
  const json = JSON.stringify(graph); writeFileSync(join(pmc, 'graph', 'graph.json'), json);
  writeFileSync(join(pmc, 'enrichment', 'symbol-index.json'), JSON.stringify({
    [alpha]: { graphNodeId: 'a' }, [beta]: { graphNodeId: 'b', semanticSummary: 'Legacy beta summary.' },
  }));
  const path = join(pmc, 'graph', 'graph.db'); const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE nodes(id TEXT PRIMARY KEY,label TEXT,kind TEXT,source_file TEXT,community INTEGER,degree INTEGER,metadata TEXT); CREATE TABLE edges(source TEXT,target TEXT,relation TEXT);');
    buildFromGraphJson(db, graph, hashGraphJson(json));
  } finally { db.close(); }
  const before = hash(path); const connected = await connect(legacy);
  try {
    const result = await connected.client.callTool({ name: 'pmc_get_dependencies', arguments: { symbol: alpha } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), [{ symbolKey: beta, filePath: 'b.js', name: 'beta',
      graphNodeId: 'b', memoryId: null, status: null, semanticSummary: 'Legacy beta summary.' }]);
    assert.equal(hash(path), before);
  } finally { await connected.client.close(); await connected.server.close(); rmSync(legacy, { recursive: true, force: true }); }
});
test('canonical collisions return both candidates rather than collapsing to missing', async () => {
  const collision = mkdtempSync(join(tmpdir(), 'pmc-mcp-collision-'));
  const pmc = join(collision, '.planning', 'project-memory-context');
  mkdirSync(join(pmc, 'graph'), { recursive: true });
  const symbolKey = 'js|same.js|function|exported|same|0';
  const graph = { nodes: ['one', 'two'].map(id => ({ id, label: 'same', kind: 'function', source_file: 'same.js',
    metadata: { symbolKey } })), links: [] };
  const path = join(pmc, 'graph', 'graph.db'); const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE nodes(id TEXT PRIMARY KEY,label TEXT,kind TEXT,source_file TEXT,community INTEGER,degree INTEGER,metadata TEXT); CREATE TABLE edges(source TEXT,target TEXT,relation TEXT);');
    buildFromGraphJson(db, graph, 'collision');
  } finally { db.close(); }
  const before = hash(path); const connected = await connect(collision);
  try {
    for (const target of [symbolKey, 'same', 'same.js#same']) {
      const result = await connected.client.callTool({ name: 'pmc_card', arguments: { target } });
      assert.notEqual(result.isError, true);
      const card = JSON.parse(result.content[0].text);
      assert.equal(card.status, 'ambiguous');
      assert.deepEqual(card.candidates.map(candidate => candidate.id).sort(), ['one', 'two']);
    }
    assert.equal(hash(path), before);
  } finally { await connected.client.close(); await connected.server.close(); rmSync(collision, { recursive: true, force: true }); }
});
