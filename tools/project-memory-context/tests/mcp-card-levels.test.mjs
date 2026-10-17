import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
const paths = ['src/cli/main.ts', 'src/controllers/user.controller.ts', 'src/services/user.service.ts',
  'src/repositories/user.repository.ts', 'src/db/client.ts', 'src/models/user.model.ts',
  'src/interfaces/user-repository.ts', 'src/utils/format.ts', 'src/views/user.view.ts', 'tests/user.service.test.ts'];
let root, dbPath, client, server;

async function connect(projectRoot) {
  const server = new McpServer({ name: 'card-levels-fixture', version: '1.0.0' });
  registerQueryTools(server, { projectRoot });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'card-levels-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return { server, client };
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'pmc-mcp-card-levels-'));
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
  ({ client, server } = await connect(root));
});
after(async () => { await client?.close(); await server?.close(); if (root) rmSync(root, { recursive: true, force: true }); });

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, result.content[0]?.text);
  return JSON.parse(result.content[0].text);
}

test('omitting level preserves the exact legacy facts-only payload byte-for-byte', async () => {
  const before = hash(dbPath);
  const legacy = await call('pmc_card', { target: SERVICE });
  // Legacy shape is exactly {status,target,facts,enrichment} — no level fields leak in.
  assert.deepEqual(Object.keys(legacy).sort(), ['enrichment', 'facts', 'status', 'target']);
  assert.equal(legacy.status, 'resolved');
  assert.equal(legacy.target, SERVICE);
  assert.equal(legacy.enrichment, 'Finds a user by ID.');
  assert.equal(legacy.facts.id, SERVICE);
  assert.equal('level' in legacy, false);
  assert.equal('tokenCeiling' in legacy, false);
  assert.equal(hash(dbPath), before);
});

test('compact level returns essentials under the 2000 ceiling without padding', async () => {
  const out = await call('pmc_card', { target: SERVICE, level: 'compact' });
  assert.equal(out.status, 'resolved');
  assert.equal(out.target, SERVICE);
  assert.equal(out.level, 'compact');
  assert.equal(out.tokenCeiling, 2000);
  assert.equal(out.truncated, false);
  assert.deepEqual(out.omittedSections, []);
  assert.deepEqual(Object.keys(out.card).sort(),
    ['fanIn', 'fanOut', 'id', 'kind', 'location', 'role', 'signature', 'summary']);
  assert.equal(out.card.summary, 'Finds a user by ID.');
  assert.ok(out.tokensEstimated > 0 && out.tokensEstimated < out.tokenCeiling, 'not filled to the ceiling');
  assert.equal('callers' in out.card, false);
});

test('extended adds relation context under the 5000 ceiling', async () => {
  const out = await call('pmc_card', { target: SERVICE, level: 'extended' });
  assert.equal(out.tokenCeiling, 5000);
  assert.ok('callers' in out.card && 'callees' in out.card && 'tests' in out.card);
  assert.equal('roleEvidence' in out.card, false);
});

test('deep adds role evidence under the 10000 ceiling', async () => {
  const out = await call('pmc_card', { target: SERVICE, level: 'deep' });
  assert.equal(out.tokenCeiling, 10000);
  assert.ok('callers' in out.card);
  assert.ok(Array.isArray(out.card.roleEvidence));
});

test('file target is leveled too', async () => {
  const out = await call('pmc_card', { target: 'src/services/user.service.ts', level: 'extended' });
  assert.equal(out.card.kind, 'file');
  assert.ok('exports' in out.card && 'members' in out.card);
});

test('invalid level is rejected by the MCP input schema', async () => {
  const result = await client.callTool({ name: 'pmc_card', arguments: { target: SERVICE, level: 'huge' } });
  assert.equal(result.isError, true);
});
