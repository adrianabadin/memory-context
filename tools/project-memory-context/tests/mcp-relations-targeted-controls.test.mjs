import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerQueryTools } from '../mcp/query-tools.mjs';
import { buildFromGraphJson, createSqliteGraphStore } from '../src/graph-store/graph-db.mjs';
import { extractNativeCalls } from '../src/relations/native-calls.mjs';
import { extractNativeImportBindings } from '../src/relations/native-import-bindings.mjs';

// Durable same-rule controls from the independent targeted recheck.
const A = 'js|src/a.js|function|exported|alpha|0';
const B = 'py|src/b.py|function|exported|beta|0';
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const node = (id, key, path, kind = 'function') => ({ id, label: key.split('|')[4], kind, source_file: path, metadata: { symbolKey: key } });

async function fixture(t, { nodes, links = [], index = {}, native = true }) {
  const root = mkdtempSync(join(tmpdir(), 'independent-mcp-controls-'));
  const pmc = join(root, '.planning/project-memory-context');
  mkdirSync(join(pmc, 'graph'), { recursive: true }); mkdirSync(join(pmc, 'enrichment'), { recursive: true });
  const graph = { nodes, links };
  writeFileSync(join(pmc, 'graph/graph.json'), JSON.stringify(graph));
  writeFileSync(join(pmc, 'enrichment/symbol-index.json'), JSON.stringify(index));
  const dbPath = join(pmc, 'graph/graph.db'); const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE nodes(id TEXT PRIMARY KEY,label TEXT,kind TEXT,source_file TEXT,community INTEGER,degree INTEGER,metadata TEXT); CREATE TABLE edges(source TEXT,target TEXT,relation TEXT);');
    buildFromGraphJson(db, graph, 'independent-controls');
    if (native) createSqliteGraphStore(db).persistNativeRelations({ relations: [], unresolved: [] });
  } finally { db.close(); }
  const server = new McpServer({ name: 'independent-controls', version: '1.0.0' });
  registerQueryTools(server, { projectRoot: root });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'independent-controls', version: '1.0.0' });
  await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  // Retain only these new owned fixtures as regression evidence.
  return { root, pmc, client, dbPath, async call(name, args) {
    const before = hash(dbPath); const result = await client.callTool({ name, arguments: args });
    assert.equal(hash(dbPath), before, 'every request preserves exact DB bytes'); return result;
  } };
}
function payload(result) {
  assert.notEqual(result.isError, true, result.content[0].text);
  return JSON.parse(result.content[0].text);
}
// These serialized response goldens were observed against archived22b7faf,
// not synthesized from candidate behavior or a mocked candidate handler.
const baselineRows = {
  [A]: { symbolKey: A, filePath: 'src/a.js', name: 'alpha', graphNodeId: 'a', memoryId: 11, status: 'done', semanticSummary: 'Alpha.' },
  [B]: { symbolKey: B, filePath: 'src/b.py', name: 'beta', graphNodeId: 'b', memoryId: 12, status: 'pending', semanticSummary: 'Beta.' },
};
for (const native of [false, true]) for (const relation of ['calls', 'imports', 'contains']) {
  test(`B1 exact baseline responses both directions ${relation} tables=${native}`, async t => {
    const f = await fixture(t, { nodes: [node('a', A, 'src/a.js'), { id: 'b', label: 'beta', kind: 'function', source_file: 'src/b.py' }],
      links: [{ source: 'a', target: 'b', relation }], index: {
        [A]: { graphNodeId: 'a', memoryId: 11, status: 'done', semanticSummary: 'Alpha.' },
        [B]: { graphNodeId: 'b', memoryId: 12, status: 'pending', semanticSummary: 'Beta.' },
      }, native });
    for (const [name, symbol, neighbor] of [['pmc_get_dependencies', A, B], ['pmc_get_dependents', B, A]]) {
      assert.deepEqual(await f.call(name, { symbol }), { content: [{ type: 'text', text: JSON.stringify([baselineRows[neighbor]], null, 2) }] });
    }
  });
}
for (const mismatch of ['metadata', 'path']) {
  test(`B2 rejects file exports with contradictory ${mismatch}`, async t => {
    const n = node(A, A, 'src/a.js');
    if (mismatch === 'metadata') n.metadata.symbolKey = B;
    else n.source_file = 'src/other.js';
    const f = await fixture(t, { nodes: [n], index: { [A]: { graphNodeId: A } } });
    const card = payload(await f.call('pmc_card', { target: n.source_file }));
    assert.equal(card.status, 'resolved'); assert.equal(card.facts.symbolCount, 0); assert.deepEqual(card.facts.exports, []);
    assert.equal(payload(await f.call('pmc_card', { target: A })).status, 'missing');
  });
}
test('B3 strict options reject variants; known arguments remain valid', async t => {
  const f = await fixture(t, { nodes: [node(A, A, 'src/a.js')] });
  for (const [name, args] of [
    ['pmc_relations', { target: A, direction: 'inbound', relations: ['calls'], depth: 2, level: 'compact' }],
    ['pmc_card', { target: A, stopAtRole: 'controller' }], ['pmc_relations', { target: A, depth: 1, typo: true }],
  ]) {
    const result = await f.call(name, args); assert.equal(result.isError, true); assert.match(result.content[0].text, /Unrecognized key/);
  }
  assert.equal(payload(await f.call('pmc_relations', { target: A, direction: 'outbound', relations: [], depth: 3 })).status, 'resolved');
  assert.equal(payload(await f.call('pmc_card', { target: A })).facts.id, A);
  // S13 legitimate addition: pmc_relations now accepts the optional stopAtRole
  // (pmc_card above still rejects it), and its empty boundary changes nothing.
  const accepted = payload(await f.call('pmc_relations', { target: A, stopAtRole: 'controller' }));
  assert.equal(accepted.status, 'resolved');
  assert.equal(accepted.stoppedAtRole, 'controller');
  assert.deepEqual(accepted.matches, []);
  const baseline = payload(await f.call('pmc_relations', { target: A }));
  const withoutOption = { status: accepted.status, target: accepted.target, direction: accepted.direction,
    depth: accepted.depth, edges: accepted.edges };
  assert.deepEqual(withoutOption, baseline, 'stopAtRole only appends its own keys; the default fields stay identical');
});
test('B4 normalized absent/existing paths and canonical file IDs', async t => {
  const f = await fixture(t, { nodes: [node(A, A, 'src/a.js'), { id: 'file|src/empty.js', label: 'src/empty.js', kind: 'file', source_file: 'src/empty.js' }] });
  for (const target of ['src/missing.js', './src/missing.js', 'file|src/missing.js']) for (const name of ['pmc_card', 'pmc_relations']) {
    const result = payload(await f.call(name, { target })); assert.equal(result.status, 'missing'); assert.deepEqual(result.candidates, []);
    if (name === 'pmc_relations') assert.deepEqual(result.edges, []);
  }
  for (const target of ['src/a.js', './src/a.js', 'file|src/a.js', 'src/empty.js', 'file|src/empty.js']) {
    const result = payload(await f.call('pmc_card', { target })); assert.equal(result.status, 'resolved'); assert.equal(result.facts.kind, 'file');
  }
});
test('direct regression: own AST golden Q1-Q3 and six-tool stdio parity', async t => {
  const paths = ['src/cli/main.ts', 'src/controllers/user.controller.ts', 'src/services/user.service.ts', 'src/repositories/user.repository.ts',
    'src/db/client.ts', 'src/models/user.model.ts', 'src/interfaces/user-repository.ts', 'src/utils/format.ts', 'src/views/user.view.ts', 'tests/user.service.test.ts'];
  const files = paths.map(path => ({ path, content: readFileSync(new URL(`./fixtures/layered-app/${path}`, import.meta.url), 'utf8') }));
  const calls = await extractNativeCalls({ files }); const imports = await extractNativeImportBindings({ files });
  const f = await fixture(t, { nodes: calls.symbols.map(symbol => node(symbol.id, symbol.id, symbol.path, symbol.kind)) });
  const db = new DatabaseSync(f.dbPath);
  try { const store = createSqliteGraphStore(db); store.persistNativeRelations(calls); store.persistNativeRelations(imports); }
  finally { db.close(); }
  writeFileSync(join(f.pmc, 'graph/graph.json'), '{POISON');
  const golden = JSON.parse(readFileSync(new URL('./fixtures/layered-app/expected.json', import.meta.url), 'utf8'));
  const service = 'ts|src/services/user.service.ts|method|member|UserService.findById|1';
  const format = 'ts|src/utils/format.ts|function|exported|formatName|1';
  for (const [target, direction, side, id] of [[service, 'in', 'source', 'q1-callers-user-service-find-by-id'],
    [service, 'out', 'target', 'q2-callees-user-service-find-by-id'], [format, 'in', 'source', 'q3-dependents-format-name']]) {
    const result = payload(await f.call('pmc_relations', { target, direction, relations: ['calls'], depth: 1 }));
    assert.deepEqual(result.edges.map(edge => edge[side].symbolKey).sort(), golden.questions.find(question => question.id === id).expected.slice().sort());
  }
  const client = new Client({ name: 'stdio-targeted', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../mcp/pmc-query-server.mjs', import.meta.url))],
    env: { ...process.env, PMC_PROJECT_ROOT: f.root }, stderr: 'pipe' });
  await client.connect(transport);
  try {
    const standalone = await client.listTools(), composed = await f.client.listTools();
    assert.equal(standalone.tools.length, 6);
    assert.deepEqual(JSON.parse(JSON.stringify(standalone)), JSON.parse(JSON.stringify(composed)));
    for (const name of ['pmc_relations', 'pmc_card']) assert.equal(standalone.tools.find(tool => tool.name === name).annotations.readOnlyHint, true);
  } finally { await client.close(); }
});
