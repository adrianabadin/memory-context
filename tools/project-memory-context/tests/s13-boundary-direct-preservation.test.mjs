import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerQueryTools } from '../mcp/query-tools.mjs';
import { buildFromGraphJson, createSqliteGraphStore, hashGraphJson } from '../src/graph-store/graph-db.mjs';
import { extractNativeImportBindings } from '../src/relations/native-import-bindings.mjs';
import { loadProfile } from '../src/roles/classify.mjs';

const key = (name, kind = 'function', path = 'src/probe.ts', scope = 'exported') =>
  `ts|${path}|${kind}|${scope}|${name}|0`;
const endpoint = id => ({ id, symbolKey: id, kind: id.split('|')[2], path: id.split('|')[1] });
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

async function connect(root) {
  const server = new McpServer({ name: 'independent-s13', version: '1' });
  registerQueryTools(server, { projectRoot: root });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'independent', version: '1' });
  await client.connect(a);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

async function fixture(t, { keys, edges = [], roles = {}, kinds = {}, native = null, files = null }) {
  const root = mkdtempSync(join(tmpdir(), 'independent-s13-'));
  const pmc = join(root, '.planning/project-memory-context');
  mkdirSync(join(pmc, 'graph'), { recursive: true });
  mkdirSync(join(pmc, 'enrichment'), { recursive: true });
  const graph = {
    nodes: keys.map(id => ({
      id, label: id.split('|')[4], kind: id.split('|')[2], source_file: id.split('|')[1],
      metadata: { symbolKey: id }, ...(kinds[id] ? { node_kind: kinds[id] } : {}),
    })),
    links: edges.map(([source, target, relation = 'calls']) => ({ source, target, relation })),
  };
  const text = JSON.stringify(graph);
  const dbPath = join(pmc, 'graph/graph.db');
  writeFileSync(join(pmc, 'graph/graph.json'), text);
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE nodes(id TEXT PRIMARY KEY,label TEXT,kind TEXT,source_file TEXT,community INTEGER,degree INTEGER,metadata TEXT); CREATE TABLE edges(source TEXT,target TEXT,relation TEXT);');
  buildFromGraphJson(db, graph, hashGraphJson(text));
  const store = createSqliteGraphStore(db);
  const profile = loadProfile('generic');
  profile.roleLayers['project-custom'] = 'application';
  if (native) store.persistNativeRelations(native);
  if (files) store.persistNativeRelations(await extractNativeImportBindings({ files }));
  if (Object.keys(roles).length) {
    store.persistNodeRoles(Object.entries(roles).map(([id, role]) => ({
      endpoint: endpoint(id),
      classification: typeof role === 'object' ? role : {
        role, layer: profile.roleLayers[role], confidence: 1,
        evidence: ['independent fixture role evidence'],
      },
    })), { profile });
  }
  for (const [id, kind] of Object.entries(kinds)) {
    db.prepare('UPDATE nodes SET node_kind=? WHERE id=?').run(kind, id);
  }
  db.close();
  const index = Object.fromEntries(keys.map(id => [id, {
    graphNodeId: id, semanticSummary: 'probe summary',
  }]));
  writeFileSync(join(pmc, 'enrichment/symbol-index.json'), JSON.stringify(index));
  writeFileSync(join(pmc, 'enrichment/worklist.json'), '[]');
  const configs = ['graph/graph.json', 'enrichment/symbol-index.json', 'enrichment/worklist.json']
    .map(path => join(pmc, path));
  const snapshot = () => {
    const query = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return JSON.stringify({
        db: hash(dbPath), mtime: statSync(dbPath).mtimeMs,
        schema: query.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(),
        roles: query.prepare("SELECT name FROM sqlite_master WHERE name='node_role_assignments'").get()
          ? query.prepare('SELECT * FROM node_role_assignments ORDER BY endpoint_id').all() : [],
        config: configs.map(path => [hash(path), statSync(path).mtimeMs]),
      });
    } finally {
      query.close();
    }
  };
  const connection = await connect(root);
  t.after(async () => {
    try { await connection.close(); } finally { rmSync(root, { recursive: true, force: true }); }
  });
  const call = async (name, args) => {
    const before = snapshot();
    const output = await connection.client.callTool({ name, arguments: args });
    assert.equal(snapshot(), before, 'request changed fixture DB/schema/roles/config');
    return output;
  };
  return {
    root, call,
    payload: async args => {
      const output = await call('pmc_relations', args);
      assert.notEqual(output.isError, true, output.content[0].text);
      return JSON.parse(output.content[0].text);
    },
  };
}

const boundary = (symbolKey, distance, path, role = 'controller') =>
  ({ symbolKey, role, distance, path });

test('S13 B1 absent and explicitly unknown owners retain the matching method and cut expansion', async t => {
  const a = key('A', 'class', 'src/a.ts');
  const am = key('A.m', 'method', 'src/a.ts', 'member');
  const c = key('C', 'class');
  const cm = key('C.m', 'method', 'src/probe.ts', 'member');
  const p = key('predecessor');
  for (const owner of ['absent', 'unknown', 'controller']) {
    const roles = { [cm]: 'controller', [p]: 'controller' };
    if (owner === 'unknown') roles[c] = { role: null, layer: null, confidence: 0, evidence: [] };
    if (owner === 'controller') roles[c] = 'controller';
    const f = await fixture(t, { keys: [a, am, c, cm, p], edges: [[cm, am], [p, cm]], roles });
    const result = await f.payload({
      target: a, direction: 'in', relations: ['calls'], depth: 3, stopAtRole: 'controller',
    });
    assert.deepEqual(result.matches, [owner === 'controller'
      ? boundary(c, 1, [a, am, cm, c]) : boundary(cm, 1, [a, am, cm])]);
    assert.equal(result.edges.length, 1);
    assert.equal(result.edges[0].source.symbolKey, cm);
    assert.equal(result.edges[0].target.symbolKey, am);
  }
});

test('S13 B2 doc/config/data cannot self-match or match when reached, with or without an own prior assignment', async t => {
  const c = key('C', 'class');
  const cm = key('C.m', 'method', 'src/probe.ts', 'member');
  const a = key('a', 'method', 'src/a.ts', 'member');
  for (const kind of ['doc', 'config', 'data']) for (const own of [false, true]) {
    const roles = { [c]: 'controller' };
    if (own) roles[cm] = 'controller';
    const f = await fixture(t, { keys: [c, cm, a], edges: [[cm, a]], roles, kinds: { [cm]: kind } });
    for (const target of [cm, a]) {
      const args = { target, direction: 'in', relations: ['calls'], depth: 1 };
      const normal = await f.payload(args);
      const stopped = await f.payload({ ...args, stopAtRole: 'controller' });
      assert.deepEqual(stopped.matches, [], `${kind}, own=${own}, target=${target}`);
      assert.deepEqual(stopped.edges, normal.edges, 'current node-kind filtering stays unchanged');
    }
  }
});
