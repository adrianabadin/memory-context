import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerQueryTools } from '../mcp/query-tools.mjs';
import { buildFromGraphJson, createSqliteGraphStore } from '../src/graph-store/graph-db.mjs';

const A = 'js|src/a.js|function|exported|alpha|0';
const B = 'py|src/b.py|function|exported|beta|0';
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

async function fixture(t, { nodes, links = [], index = {}, native = true }) {
  const root = mkdtempSync(join(tmpdir(), 'independent-mcp-regression-'));
  const pmc = join(root, '.planning/project-memory-context');
  mkdirSync(join(pmc, 'graph'), { recursive: true });
  mkdirSync(join(pmc, 'enrichment'), { recursive: true });
  const graph = { nodes, links };
  writeFileSync(join(pmc, 'graph/graph.json'), JSON.stringify(graph));
  writeFileSync(join(pmc, 'enrichment/symbol-index.json'), JSON.stringify(index));
  const dbPath = join(pmc, 'graph/graph.db'); const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE nodes(id TEXT PRIMARY KEY,label TEXT,kind TEXT,source_file TEXT,community INTEGER,degree INTEGER,metadata TEXT); CREATE TABLE edges(source TEXT,target TEXT,relation TEXT);');
    buildFromGraphJson(db, graph, 'independent');
    if (native) createSqliteGraphStore(db).persistNativeRelations({ relations: [], unresolved: [] });
  } finally { db.close(); }
  const server = new McpServer({ name: 'independent', version: '1.0.0' });
  registerQueryTools(server, { projectRoot: root });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'independent', version: '1.0.0' });
  await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  // Retain only these new owned fixtures as verification evidence.
  return { dbPath, async call(name, args) {
    const before = hash(dbPath);
    const result = await client.callTool({ name, arguments: args });
    assert.equal(hash(dbPath), before, 'every request preserves exact DB bytes');
    return result;
  } };
}
function payload(result) {
  assert.notEqual(result.isError, true, result.content[0].text);
  return JSON.parse(result.content[0].text);
}
const node = (id, key, path, kind = 'function') => ({ id, label: key.split('|')[4], kind, source_file: path, metadata: { symbolKey: key } });

for (const native of [false, true]) {
  test(`legacy aliases preserve mixed identities (native tables=${native})`, async t => {
    const f = await fixture(t, { nodes: [node('a', A, 'src/a.js'), { id: 'b', label: 'beta', kind: 'function', source_file: 'src/b.py' }],
      links: [{ source: 'a', target: 'b', relation: 'calls' }],
      index: { [A]: { graphNodeId: 'a' }, [B]: { graphNodeId: 'b', semanticSummary: 'Beta summary.' } }, native });
    const expected = [{ symbolKey: B, filePath: 'src/b.py', name: 'beta', graphNodeId: 'b', memoryId: null, status: null, semanticSummary: 'Beta summary.' }];
    assert.deepEqual(await f.call('pmc_get_dependencies', { symbol: A }), { content: [{ type: 'text', text: JSON.stringify(expected, null, 2) }] });
    assert.deepEqual(payload(await f.call('pmc_get_dependents', { symbol: B })).map(item => item.symbolKey), [A]);
  });
}
for (const mismatch of ['index', 'kind']) {
  test(`file cards withhold contradictory identities (${mismatch})`, async t => {
    const f = await fixture(t, { nodes: [node(A, A, 'src/a.js', mismatch === 'kind' ? 'class' : 'function')],
      index: { [A]: { graphNodeId: mismatch === 'index' ? 'wrong' : A } } });
    assert.equal(payload(await f.call('pmc_card', { target: A })).status, 'missing');
    const file = payload(await f.call('pmc_card', { target: 'src/a.js' }));
    assert.equal(file.status, 'resolved');
    assert.deepEqual(file.facts.exports, []);
    assert.deepEqual(file.facts.members, []);
    assert.equal(file.facts.symbolCount, 0);
  });
}
for (const [name, extra] of [['pmc_relations', { stopAtRoleTypo: 'controller' }], ['pmc_card', { unsupportedOption: 'x' }]]) {
  test(`${name} rejects unsupported explicit options`, async t => {
    const f = await fixture(t, { nodes: [node(A, A, 'src/a.js')] });
    assert.equal((await f.call(name, { target: A, ...extra })).isError, true, 'an explicit unsupported option cannot succeed silently');
  });
}
// pmc_card's `level` is now a supported S16 option, so it must be accepted (not rejected).
test('pmc_card accepts the supported level option and rejects an invalid level value', async t => {
  const f = await fixture(t, { nodes: [node(A, A, 'src/a.js')] });
  assert.notEqual((await f.call('pmc_card', { target: A, level: 'deep' })).isError, true, 'a supported level cannot be rejected');
  assert.equal((await f.call('pmc_card', { target: A, level: 'huge' })).isError, true, 'an invalid level value cannot succeed');
});
test('pmc_relations validates stopAtRole strictly and keeps absent-option output identical', async t => {
  const f = await fixture(t, { nodes: [node(A, A, 'src/a.js')] });
  const rejected = await f.call('pmc_relations', { target: A, stopAtRole: 'contorller' });
  assert.equal(rejected.isError, true, 'an unknown role value cannot be ignored as success');
  assert.match(rejected.content[0].text, /unknown role/);
  const baseline = payload(await f.call('pmc_relations', { target: A, direction: 'in', relations: ['calls'], depth: 1 }));
  assert.deepEqual(Object.keys(baseline).sort(), ['depth', 'direction', 'edges', 'status', 'target'],
    'the default response keeps exactly its prior key set');
  const accepted = payload(await f.call('pmc_relations', { target: A, direction: 'in', relations: ['calls'], depth: 1, stopAtRole: 'controller' }));
  assert.equal(accepted.status, 'resolved');
  assert.equal(accepted.stoppedAtRole, 'controller');
  assert.deepEqual(accepted.matches, [], 'a known role with no assignment is an empty boundary, not an unknown-role error');
  assert.deepEqual(accepted.edges, baseline.edges, 'an empty boundary preserves the default edge set');
});
for (const name of ['pmc_card', 'pmc_relations']) {
  test(`${name} does not resolve an absent file`, async t => {
    const f = await fixture(t, { nodes: [node(A, A, 'src/a.js')] });
    const result = payload(await f.call(name, { target: 'src/missing.js' }));
    assert.equal(result.status, 'missing'); assert.deepEqual(result.candidates, []);
    if (name === 'pmc_relations') assert.deepEqual(result.edges, []);
  });
}
