import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerQueryTools } from '../mcp/query-tools.mjs';
import { buildFromGraphJson, createSqliteGraphStore, hashGraphJson, openGraphDb } from '../src/graph-store/graph-db.mjs';
import { buildFacts } from '../src/cards/facts.mjs';
import { buildFileCard } from '../src/cards/file-card.mjs';
import { createQueryEngine } from '../src/retrieval/query-engine.mjs';
import { runTargetContext } from '../cli/context.mjs';
import { createRelationsReader } from '../src/query/relations.mjs';

const path = 'src/services/worker.ts';
const key = `ts|${path}|class|exported|WorkerService|0`;
const symbolEndpoint = { id: key, symbolKey: key, kind: 'class', path };
const fileEndpoint = { id: `file|${path}`, kind: 'file', path };
const known = { role: 'service', layer: 'application', confidence: 0.6, evidence: ['name suffix marker: WorkerService'] };
const unknown = { role: null, layer: null, confidence: 0, evidence: [] };
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pmc-role-exposure-'));
  const pmc = join(root, '.planning/project-memory-context');
  mkdirSync(join(pmc, 'graph'), { recursive: true });
  mkdirSync(join(pmc, 'enrichment'), { recursive: true });
  const nodes = [
    { id: 'raw-symbol', label: 'WorkerService', kind: 'class', source_file: path, metadata: { symbolKey: key, semanticSummary: 'Keeps summary.' } },
    { id: 'raw-file', label: path, source_file: path },
  ];
  const graph = { nodes, links: [] }, json = JSON.stringify(graph);
  const dbPath = join(pmc, 'graph/graph.db');
  const db = new DatabaseSync(dbPath);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE nodes(id TEXT PRIMARY KEY,label TEXT,kind TEXT,node_kind TEXT,source_file TEXT,community INTEGER,degree INTEGER,metadata TEXT); CREATE TABLE edges(source TEXT,target TEXT,relation TEXT);');
  buildFromGraphJson(db, graph, hashGraphJson(json));
  const raw = createSqliteGraphStore(db);
  raw.persistNativeRelations({ relations: [], unresolved: [] });
  const store = { ...raw, getNode: (id) => raw.getNode(id === key ? 'raw-symbol' : id === fileEndpoint.id ? 'raw-file' : id) };
  const symbolIndex = { [key]: { graphNodeId: 'raw-symbol' } };
  const worklist = [{ symbolKey: key, name: 'WorkerService', kind: 'class', filePath: path }];
  for (const [name, value] of [['symbol-index', symbolIndex], ['worklist', worklist]]) {
    writeFileSync(join(pmc, `enrichment/${name}.json`), JSON.stringify(value));
  }
  writeFileSync(join(pmc, 'graph/graph.json'), json);
  writeFileSync(join(pmc, 'install.json'), '{}');
  // Fixture-owned initialization precedes query hashes; queries must not create
  // the legacy auxiliary schema when checking exposure-only byte preservation.
  openGraphDb(dbPath, join(pmc, 'graph/graph.json')).close();
  const artifacts = { graphStore: store, symbolIndex, worklist };
  const assign = (classification) => raw.persistNodeRoles([
    { endpoint: symbolEndpoint, classification }, { endpoint: fileEndpoint, classification },
  ]);
  return { root, pmc, db, dbPath, raw, store, artifacts, graph, assign };
}

test('S5 facts and file cards expose exactly the persisted four-field classification, without writes', (t) => {
  const f = fixture(t);
  const previousFacts = buildFacts(f.store, key), previousCard = buildFileCard(f.store, path);
  f.assign(known);
  const before = digest(f.dbPath);
  const facts = buildFacts(f.store, key), card = buildFileCard(f.store, path);
  assert.deepEqual(facts.roleClassification, known);
  assert.deepEqual(card.roleClassification, known);
  assert.deepEqual(buildFacts(f.store, fileEndpoint.id).roleClassification, known);
  const { roleClassification: factRole, ...unchangedFacts } = facts;
  const { roleClassification: cardRole, ...unchangedCard } = card;
  assert.deepEqual(unchangedFacts, previousFacts);
  assert.deepEqual(unchangedCard, previousCard);
  assert.equal(digest(f.dbPath), before);
});

test('S5 explicit unknown differs from unassigned; no stale metadata fallback', async (t) => {
  const f = fixture(t);
  assert.equal(Object.hasOwn(buildFacts(f.store, key), 'roleClassification'), false);
  f.assign(unknown);
  assert.deepEqual(buildFacts(f.store, key).roleClassification, unknown);
  assert.deepEqual(buildFileCard(f.store, path).roleClassification, unknown);
  const withheld = { ...f.store, getNodeRole: () => null };
  assert.equal(Object.hasOwn(buildFacts(withheld, key), 'roleClassification'), false);
  const legacy = { ...f.store };
  delete legacy.getNodeRole;
  assert.equal(Object.hasOwn(buildFileCard(legacy, path), 'roleClassification'), false);
  const result = await runTargetContext({ projectRoot: f.root, target: key, explicitMode: 'symbol', depth: 'compact', focus: 'all', artifacts: f.artifacts });
  assert.deepEqual(result.input.target.roleClassification, unknown);
  assert.match(result.output, /  role: null\n  layer: null\n  confidence: 0\n  evidence: none/);
});

test('S5 get-context exposes roles for symbol/file across depth and focus, preserving earlier output', async (t) => {
  const f = fixture(t);
  const args = { projectRoot: f.root, depth: 'compact', focus: 'all', artifacts: f.artifacts };
  const beforeOutput = (await runTargetContext({ ...args, target: key, explicitMode: 'symbol' })).output;
  f.assign(known);
  const before = digest(f.dbPath);
  for (const [target, explicitMode] of [[key, 'symbol'], [path, 'file']]) {
    for (const depth of ['compact', 'extended', 'deep']) {
      for (const focus of ['all', 'callers']) {
        const result = await runTargetContext({ ...args, target, explicitMode, depth, focus });
        assert.deepEqual(result.input.target.roleClassification, known);
        assert.match(result.output, /  role: service\n  layer: application\n  confidence: 0\.6\n  evidence: name suffix marker: WorkerService/);
      }
    }
  }
  const output = (await runTargetContext({ ...args, target: key, explicitMode: 'symbol' })).output;
  assert.equal(output.replace(/  role: service\n  layer: application\n  confidence: 0\.6\n  evidence: name suffix marker: WorkerService\n/, ''), beforeOutput);
  assert.equal(digest(f.dbPath), before);
});

test('S5 public CLI and actual MCP pmc_card transport return roles without database mutation', async (t) => {
  const f = fixture(t);
  f.assign(known);
  const before = digest(f.dbPath);
  const cli = new URL('../cli/context.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const {main}=await import(${JSON.stringify(cli)});process.exitCode=await main(process.argv.slice(1),{memoryStoreLoader:async()=>null});`,
    'symbol', 'WorkerService', 'compact', 'all'], { cwd: f.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /  role: service/);
  const server = new McpServer({ name: 'role-fixture', version: '1.0.0' });
  registerQueryTools(server, { projectRoot: f.root });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'role-client', version: '1.0.0' });
  await client.connect(clientTransport);
  try {
    for (const target of [key, path]) {
      const response = await client.callTool({ name: 'pmc_card', arguments: { target } });
      assert.notEqual(response.isError, true, response.content[0]?.text);
      const card = JSON.parse(response.content[0].text);
      assert.deepEqual(card.facts.roleClassification, known);
      if (target === key) assert.equal(card.enrichment, 'Keeps summary.');
    }
  } finally { await client.close(); await server.close(); }
  assert.equal(digest(f.dbPath), before);
});

test('S5 ambiguous identities and stale index bindings withhold assignment exposure', async (t) => {
  const f = fixture(t);
  f.assign(known);
  writeFileSync(join(f.pmc, 'enrichment/symbol-index.json'), JSON.stringify({ [key]: { graphNodeId: 'missing' } }));
  const reader = createRelationsReader({ projectRoot: f.root });
  assert.notEqual((await reader.card({ target: key })).status, 'resolved');
  const engine = createQueryEngine({ ...f.artifacts, symbolIndex: { [key]: { graphNodeId: 'missing' } } });
  assert.equal(Object.hasOwn((await engine.querySymbolContext({ symbolKey: key, depth: 'compact' })).target, 'roleClassification'), false);
  buildFromGraphJson(f.db, { nodes: [...f.graph.nodes, { ...f.graph.nodes[0], id: 'duplicate' }], links: [] }, 'duplicates');
  assert.equal(Object.hasOwn(buildFacts(f.store, key), 'roleClassification'), false);
});
