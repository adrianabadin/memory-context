import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { buildFromGraphJson, createSqliteGraphStore, openGraphDb, hashGraphJson } from '../src/graph-store/graph-db.mjs';
import { loadProfile } from '../src/roles/classify.mjs';
import { buildFacts } from '../src/cards/facts.mjs';
import { buildFileCard } from '../src/cards/file-card.mjs';
import { createRelationsReader } from '../src/query/relations.mjs';
import { createQueryEngine } from '../src/retrieval/query-engine.mjs';

const path = 'src/adapter.ts';
const key = `ts|${path}|function|exported|execute|0`;
const classification = { role: 'custom-adapter', layer: null, confidence: 0.4, evidence: ['configured role', 'explicit evidence'] };
const unknown = { role: null, layer: null, confidence: 0, evidence: [] };
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'r3b-own-'));
  const pmc = join(root, '.planning/project-memory-context');
  mkdirSync(join(pmc, 'graph'), { recursive: true });
  mkdirSync(join(pmc, 'enrichment'), { recursive: true });
  const graph = { nodes: [
    { id: 'n', label: 'execute', kind: 'function', source_file: path, metadata: { symbolKey: key, semanticSummary: 'Existing summary.' } },
    { id: 'f', label: path, source_file: path },
  ], links: [] };
  const json = JSON.stringify(graph), dbPath = join(pmc, 'graph/graph.db');
  const db = new DatabaseSync(dbPath);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE nodes(id TEXT PRIMARY KEY,label TEXT,kind TEXT,node_kind TEXT,source_file TEXT,community INTEGER,degree INTEGER,metadata TEXT); CREATE TABLE edges(source TEXT,target TEXT,relation TEXT);');
  buildFromGraphJson(db, graph, hashGraphJson(json));
  const raw = createSqliteGraphStore(db);
  raw.persistNativeRelations({ relations: [], unresolved: [] });
  const index = { [key]: { graphNodeId: 'n' } };
  const worklist = [{ symbolKey: key, name: 'execute', filePath: path, kind: 'function' }];
  writeFileSync(join(pmc, 'graph/graph.json'), json);
  writeFileSync(join(pmc, 'install.json'), '{}');
  const setIndex = (value) => writeFileSync(join(pmc, 'enrichment/symbol-index.json'), JSON.stringify(value));
  setIndex(index);
  writeFileSync(join(pmc, 'enrichment/worklist.json'), JSON.stringify(worklist));
  openGraphDb(dbPath, join(pmc, 'graph/graph.json')).close();
  const store = { ...raw, getNode: (id) => raw.getNode(id === key ? 'n' : id) };
  const profile = loadProfile('generic');
  profile.roleLayers['custom-adapter'] = null;
  const assign = (value) => raw.persistNodeRoles([
    { endpoint: { id: key, symbolKey: key, kind: 'function', path }, classification: value },
    { endpoint: { id: `file|${path}`, kind: 'file', path }, classification: value },
  ], { profile });
  const snapshot = () => JSON.stringify(db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all()) +
    JSON.stringify(db.prepare('SELECT * FROM nodes ORDER BY id').all());
  return { root, pmc, graph, db, dbPath, raw, store, index, worklist, setIndex, assign, snapshot };
}

const strip = (value) => {
  const { roleClassification, ...rest } = value;
  return rest;
};
function cli(module, root, args) {
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    `const {main}=await import(${JSON.stringify(module)});process.exitCode=await main(process.argv.slice(1),{memoryStoreLoader:async()=>null});`,
    ...args], { cwd: root, encoding: 'utf8' });
}
function cliCases() {
  return [[key, 'symbol'], [path, 'file']].flatMap(([target, mode]) =>
    ['compact', 'extended', 'deep'].flatMap((depth) =>
      ['all', 'dependencies', 'callers', 'containment', 'impact'].map((focus) => [mode, target, depth, focus])));
}

test('S5 independent baseline parity, custom nullable roles, all CLI focus/depth and aliases', async (t) => {
  const f = setup(t);
  const module = new URL('../cli/context.mjs', import.meta.url).href;
  const baseline = process.env.PMC_BASELINE_ROOT
    ? pathToFileURL(join(process.env.PMC_BASELINE_ROOT, 'tools/project-memory-context/cli/context.mjs')).href : module;
  const reader = createRelationsReader({ projectRoot: f.root });
  const aliases = [key, 'n', 'execute', `${path}#execute`, path, `file|${path}`];
  const beforeCards = await Promise.all(aliases.map((target) => reader.card({ target })));
  const outputs = new Map();
  for (const args of cliCases()) {
    const old = cli(baseline, f.root, args), current = cli(module, f.root, args);
    assert.equal(current.status, 0, current.stderr);
    assert.equal(current.stderr, '');
    assert.equal(current.stdout, old.stdout);
    assert.equal(current.stderr, old.stderr);
    assert.equal(current.status, old.status);
    outputs.set(args.join(':'), current.stdout);
  }
  f.assign(classification);
  const bytes = hash(f.dbPath), snapshot = f.snapshot();
  for (let i = 0; i < aliases.length; i++) {
    const card = await reader.card({ target: aliases[i] });
    assert.equal(card.status, 'resolved');
    assert.deepEqual(card.facts.roleClassification, classification);
    assert.deepEqual({ ...card, facts: strip(card.facts) }, beforeCards[i]);
  }
  assert.deepEqual(buildFacts(f.store, key).roleClassification, classification);
  assert.deepEqual(buildFileCard(f.store, path).roleClassification, classification);
  const lines = '  role: custom-adapter\n  layer: null\n  confidence: 0.4\n  evidence: configured role; explicit evidence\n';
  for (const args of cliCases()) {
    const result = cli(module, f.root, args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.includes(lines));
    assert.equal(result.stdout.replace(lines, ''), outputs.get(args.join(':')));
  }
  assert.equal(hash(f.dbPath), bytes);
  assert.equal(f.snapshot(), snapshot);
  f.assign(unknown);
  const result = cli(module, f.root, ['symbol', 'execute', 'compact', 'all']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('  role: null\n  layer: null\n  confidence: 0\n  evidence: none\n'));
  const withheld = { ...f.store, getNodeRole: () => null }, optional = { ...f.store };
  delete optional.getNodeRole;
  for (const store of [withheld, optional]) {
    assert.equal(Object.hasOwn(buildFacts(store, key), 'roleClassification'), false);
    assert.equal(Object.hasOwn(buildFileCard(store, path), 'roleClassification'), false);
  }
});

test('S5 independent read-only failures, legacy table, identity withholding and rebuild readback', async (t) => {
  const f = setup(t);
  f.assign(classification);
  const reader = createRelationsReader({ projectRoot: f.root });
  for (const [options, message] of [
    [{ target: '', depth: 1 }, 'target must be a nonempty string'],
    [{ target: key, depth: 0 }, 'depth must be an integer from 1 to 3'],
    [{ target: key, direction: 'invalid' }, 'direction must be in, out, inbound or outbound'],
  ]) {
    const bytes = hash(f.dbPath), snapshot = f.snapshot();
    await assert.rejects(reader.relations(options), (error) => error.message === message);
    assert.equal(hash(f.dbPath), bytes);
    assert.equal(f.snapshot(), snapshot);
  }
  for (const bound of ['absent', 'f']) {
    f.setIndex({ [key]: { graphNodeId: bound } });
    const bytes = hash(f.dbPath), card = await reader.card({ target: key });
    assert.notEqual(card.status, 'resolved');
    assert.equal(hash(f.dbPath), bytes);
    const engine = createQueryEngine({ graphStore: f.store, symbolIndex: { [key]: { graphNodeId: bound } }, worklist: f.worklist });
    assert.equal(Object.hasOwn((await engine.querySymbolContext({ symbolKey: key, depth: 'compact' })).target, 'roleClassification'), false);
  }
  f.setIndex(f.index);
  const rebuilt = { ...f.graph, nodes: f.graph.nodes.map((node) => ({ ...node, id: node.id === 'n' ? 'new-n' : node.id })) };
  buildFromGraphJson(f.db, rebuilt, 'rebuilt');
  f.setIndex({ [key]: { graphNodeId: 'new-n' } });
  assert.deepEqual((await reader.card({ target: key })).facts.roleClassification, classification);
  buildFromGraphJson(f.db, { nodes: [...rebuilt.nodes, { ...rebuilt.nodes[0], id: 'dup' }], links: [] }, 'dup');
  const ambiguous = await reader.card({ target: key });
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(Object.hasOwn(ambiguous, 'roleClassification'), false);
  buildFromGraphJson(f.db, f.graph, 'legacy');
  f.setIndex(f.index);
  f.db.exec('DROP TABLE node_role_assignments');
  const bytes = hash(f.dbPath);
  assert.equal(Object.hasOwn((await reader.card({ target: key })).facts, 'roleClassification'), false);
  assert.equal(hash(f.dbPath), bytes);
  const missing = mkdtempSync(join(tmpdir(), 'r3b-missing-'));
  t.after(() => rmSync(missing, { recursive: true, force: true }));
  await assert.rejects(createRelationsReader({ projectRoot: missing }).card({ target: key }), /graph.db is unavailable; prepare PMC graph artifacts before querying:/);
  assert.deepEqual(readdirSync(missing), []);
});

test('S5 independent actual MCP aliases and rejected options preserve bytes/configuration', async (t) => {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { registerQueryTools } = await import('../mcp/query-tools.mjs');
  const f = setup(t);
  f.assign(classification);
  const before = hash(f.dbPath), snapshot = f.snapshot();
  const inputs = ['install.json', 'enrichment/symbol-index.json', 'enrichment/worklist.json', 'graph/graph.json']
    .map((value) => [join(f.pmc, value), hash(join(f.pmc, value))]);
  const server = new McpServer({ name: 'independent', version: '1' });
  registerQueryTools(server, { projectRoot: f.root });
  const client = new Client({ name: 'independent-client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    for (const target of [key, 'n', 'execute', `${path}#execute`, path, `file|${path}`]) {
      const response = await client.callTool({ name: 'pmc_card', arguments: { target } });
      assert.notEqual(response.isError, true, response.content[0]?.text);
      const card = JSON.parse(response.content[0].text);
      assert.deepEqual(card.facts.roleClassification, classification);
      if (card.target === key) assert.equal(card.enrichment, 'Existing summary.');
      assert.equal(hash(f.dbPath), before);
    }
    const rejected = await client.callTool({ name: 'pmc_card', arguments: { target: key, unexpected: true } });
    assert.equal(rejected.isError, true);
    assert.equal(hash(f.dbPath), before);
    assert.equal(f.snapshot(), snapshot);
    for (const [path, bytes] of inputs) assert.equal(hash(path), bytes);
  } finally { await client.close(); await server.close(); }
});
