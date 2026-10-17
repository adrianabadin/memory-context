import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { extractNativeCalls } from '../src/relations/native-calls.mjs';
import { buildFromGraphJson, hashGraphJson, createSqliteGraphStore } from '../src/graph-store/graph-db.mjs';
import { createQueryEngine } from '../src/retrieval/query-engine.mjs';
import { resolveTarget } from '../src/retrieval/target-resolver.mjs';
import { runTargetContext, parseArgs } from '../cli/context.mjs';

const SERVICE = 'ts|src/services/user.service.ts|method|member|UserService.findById|1';
const FORMAT = 'ts|src/utils/format.ts|function|exported|formatName|1';
const paths = ['src/cli/main.ts', 'src/controllers/user.controller.ts', 'src/services/user.service.ts',
  'src/repositories/user.repository.ts', 'src/db/client.ts', 'src/models/user.model.ts',
  'src/interfaces/user-repository.ts', 'src/utils/format.ts', 'src/views/user.view.ts', 'tests/user.service.test.ts'];
let root, artifacts, engine, golden, fixtureDb;
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'pmc-native-cli-'));
  const pmc = join(root, '.planning', 'project-memory-context');
  mkdirSync(join(pmc, 'graph'), { recursive: true }); mkdirSync(join(pmc, 'enrichment'), { recursive: true });
  writeFileSync(join(pmc, 'install.json'), '{}');
  const files = paths.map(path => ({ path, content: readFileSync(new URL(`./fixtures/layered-app/${path}`, import.meta.url), 'utf8') }));
  const calls = await extractNativeCalls({ files });
  const nodes = calls.symbols.map(symbol => ({ id: symbol.id, kind: symbol.kind, label: symbol.id.split('|')[4], source_file: symbol.path }));
  const graph = { nodes, links: [] }; const json = JSON.stringify(graph);
  writeFileSync(join(pmc, 'graph', 'graph.json'), json);
  const db = new DatabaseSync(join(pmc, 'graph', 'graph.db'));
  fixtureDb = db;
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE nodes(id TEXT PRIMARY KEY,label TEXT,kind TEXT,source_file TEXT,community INTEGER,degree INTEGER,metadata TEXT); CREATE TABLE edges(source TEXT,target TEXT,relation TEXT);');
  buildFromGraphJson(db, graph, hashGraphJson(json));
  const store = createSqliteGraphStore(db); store.persistNativeRelations(calls);
  const symbolIndex = Object.fromEntries(calls.symbols.map(symbol => [symbol.id, { graphNodeId: symbol.id }]));
  const worklist = calls.symbols.map(symbol => ({ symbolKey: symbol.id, name: symbol.id.split('|')[4], kind: symbol.kind, filePath: symbol.path }));
  writeFileSync(join(pmc, 'enrichment', 'symbol-index.json'), JSON.stringify(symbolIndex));
  writeFileSync(join(pmc, 'enrichment', 'worklist.json'), JSON.stringify(worklist));
  artifacts = { graphStore: store, symbolIndex, worklist };
  engine = createQueryEngine(artifacts);
  golden = JSON.parse(readFileSync(new URL('./fixtures/layered-app/expected.json', import.meta.url), 'utf8'));
});
after(() => { fixtureDb?.close(); if (root) rmSync(root, { recursive: true, force: true }); });
const answer = id => golden.questions.find(question => question.id === id).expected.slice().sort();

test('CLI adapter answers Q1-Q3 with correctly labeled native directions', async () => {
  for (const [target, focus, label, question] of [
    [SERVICE, 'callers', 'calls (inbound)', 'q1-callers-user-service-find-by-id'],
    [SERVICE, 'all', 'calls (outbound)', 'q2-callees-user-service-find-by-id'],
    [FORMAT, 'callers', 'calls (inbound)', 'q3-dependents-format-name'],
  ]) {
    const result = await runTargetContext({ projectRoot: root, target, explicitMode: 'symbol', depth: 'compact', focus, artifacts });
    assert.equal(result.resolved.mode, 'symbol');
    assert.deepEqual(result.input.relations.find(relation => relation.kind === label)?.items.slice().sort(), answer(question));
    assert.ok(result.output.includes(label));
  }
});
test('canonical key, path#member, bare member and graph node ID resolve without guessing ties', () => {
  for (const target of [SERVICE, 'src/services/user.service.ts#findById', 'findById']) {
    assert.equal(resolveTarget({ engine, explicitMode: 'symbol', target }).symbolKey, SERVICE);
    assert.equal(resolveTarget({ engine, target }).symbolKey, SERVICE);
  }
  const first = 'ts|a.ts|method|member|One.findById|1', second = 'ts|b.ts|method|member|Two.findById|1';
  const ambiguous = createQueryEngine({ graph: { nodes: [], links: [] }, symbolIndex: {
    [first]: { graphNodeId: 'one' }, [second]: { graphNodeId: 'two' },
  } });
  assert.equal(resolveTarget({ engine: ambiguous, target: 'one' }).symbolKey, first);
  assert.deepEqual(resolveTarget({ engine: ambiguous, explicitMode: 'symbol', target: 'findById' }).symbolKeys, [first, second]);
  assert.equal(resolveTarget({ engine: ambiguous, target: 'a.ts#findById' }).symbolKey, first);
});
test('the public CLI main parses callers and prints getUser with a successful exit in isolated state', () => {
  const cli = new URL('../cli/context.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const { main } = await import(${JSON.stringify(cli)}); process.exitCode = await main(process.argv.slice(1), { memoryStoreLoader: async () => null });`,
    'symbol', 'findById', 'compact', 'callers'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /UserController\.getUser/);
  assert.match(result.stdout, /calls \(inbound\)/);
  assert.equal(result.stderr, '');
});
test('legacy graph-only traversal, file/query resolution and parser defaults stay intact', async () => {
  const a = 'ts|a.ts|function|exported|alpha|0', b = 'ts|b.ts|function|exported|beta|0';
  const legacy = createQueryEngine({ graph: { nodes: [{ id: 'a', label: 'alpha' }, { id: 'b', label: 'beta' }],
    links: [{ source: 'a', target: 'b', relation: 'calls' }] }, symbolIndex: { [a]: { graphNodeId: 'a' }, [b]: { graphNodeId: 'b' } } });
  assert.deepEqual((await legacy.querySymbolContext({ symbolKey: a, depth: 'compact' })).edges,
    [{ source: 'a', target: 'b', relation: 'calls' }]);
  assert.equal((await legacy.queryImpactScope({ symbolKeys: [b], depth: 'compact' })).dependents[0].symbolKey, a);
  assert.deepEqual(parseArgs(['alpha']), { explicitMode: null, target: 'alpha', depth: 'compact', focus: 'all', refresh: false, help: false });
  assert.equal(resolveTarget({ engine: legacy, target: 'a.ts' }).mode, 'file');
  assert.equal(resolveTarget({ engine: legacy, target: 'unmatched words' }).mode, 'query');
});
