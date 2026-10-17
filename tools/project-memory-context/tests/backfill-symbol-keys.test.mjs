import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { planSymbolKeyBackfill, main as backfillMain } from '../cli/backfill-symbol-keys.mjs';
import { createSqliteSymbolReader } from '../cli/memory-store-loader.mjs';
import { main as contextMain } from '../cli/context.mjs';

const root = '/repo';
const projectTag = 'project:sample';
const key = 'javascript|src/a.mjs|function|local|alpha|0';
const tag = (value) => `key:symbol:${value.replace(/[^a-zA-Z0-9_-]+/g, '_')}`;
const row = (id, tags = [tag(key), projectTag], extra = {}) => ({ id, tags, ...extra });
const index = (entries = { [key]: { filePath: 'src/a.mjs' } }) => entries;

function harness(responses = {}) {
  const queries = [];
  const client = {};
  const findMemoriesByKeyTag = async (_client, keyTag) => {
    queries.push(keyTag);
    if (responses instanceof Error) throw responses;
    return responses[keyTag] ?? [];
  };
  return { client, queries, findMemoriesByKeyTag };
}

const plan = (symbolIndex, h, options = {}) => planSymbolKeyBackfill({
  symbolIndex, projectRoot: root, projectTag, client: h.client,
  findMemoriesByKeyTag: h.findMemoriesByKeyTag, ...options,
});

test('returns stable index-only mappings and exact lookup parameters without mutation tools', async () => {
  const keys = [
    'javascript|src/z.mjs|function|local|zed|0',
    key,
  ];
  const h = harness({
    [tag(key)]: [row('memory-a')],
    [tag(keys[0])]: [row('memory-z', [tag(keys[0]), projectTag])],
  });
  const result = await plan(index(Object.fromEntries(keys.map((k) => [k, { filePath: k === key ? 'src/a.mjs' : 'src/z.mjs' }]))), h);
  assert.deepEqual(h.queries, keys.map(tag).sort());
  assert.deepEqual(result.mappings.map(({ id, symbolKey }) => ({ id, symbolKey })), [
    { id: 'memory-a', symbolKey: key },
    { id: 'memory-z', symbolKey: keys[0] },
  ]);
  assert.equal(result.coverage.scope, 'known-index-keys-only');
  assert.equal(result.coverage.complete, true);
  assert.deepEqual(result.skips, []);
  assert.equal(JSON.stringify(result).includes('attach_symbol'), false);
});

test('normalizes Windows separators and ignores .worktrees and .planning by path segment', async () => {
  const win = 'javascript|src\\app\\main.mjs|function|local|main|0';
  const work = 'javascript|.worktrees\\branch\\x.mjs|function|local|x|0';
  const similar = 'javascript|.worktrees-extra/x.mjs|function|local|x|0';
  const planning = 'javascript|src/.planning/cache.mjs|function|local|p|0';
  const keys = [win, work, similar, planning];
  const h = harness(Object.fromEntries(keys.map((k) => [tag(k), [row(k, [tag(k), projectTag])]])));
  const result = await plan(index(Object.fromEntries(keys.map((k) => [k, { filePath: k.split('|')[1] }]))), h);
  assert.deepEqual(result.mappings.map((m) => m.symbolKey), [similar, win].sort());
  assert.deepEqual(result.skips.map((s) => s.reason).sort(), ['ignored-path', 'ignored-path']);
});

test('skips absolute, drive-rooted, and traversal paths', async () => {
  const paths = ['/outside/a.mjs', 'C:\\outside\\b.mjs', '../escape.mjs'];
  const keys = paths.map((p, i) => `javascript|${p}|function|local|n${i}|0`);
  const h = harness();
  const result = await plan(index(Object.fromEntries(keys.map((k) => [k, { filePath: k.split('|')[1] }]))), h);
  assert.equal(h.queries.length, 0);
  assert.equal(result.mappings.length, 0);
  assert.equal(result.skips.length, keys.length);
  assert.ok(result.skips.every((s) => s.reason === 'unsafe-path'));
});

test('collision groups include ignored keys and skip every colliding key', async () => {
  const excluded = 'javascript|src/.planning/foo.mjs|function|local|same|0';
  const eligible = 'javascript|src/planning/foo.mjs|function|local|same|0';
  const h = harness();
  const result = await plan(index({ [excluded]: {}, [eligible]: {} }), h);
  assert.equal(h.queries.length, 0);
  assert.equal(result.mappings.length, 0);
  assert.equal(result.skips.filter((s) => s.reason === 'key-tag-collision').length, 2);
});

test('unknown tagged memories are explicitly outside index-only coverage', async () => {
  const h = harness({ 'key:symbol:unknown': [row('unknown', ['key:symbol:unknown', projectTag])] });
  const result = await plan(index(), h);
  assert.deepEqual(h.queries, [tag(key)]);
  assert.equal(result.coverage.scope, 'known-index-keys-only');
  assert.equal(result.coverage.unknownTagsSearched, false);
  assert.equal(result.coverage.unknownTaggedMemories, 'excluded-not-queried');
  assert.equal(result.mappings.length, 0);
});

test('unexpected rows without exact key tag and mismatched project tags are skipped', async () => {
  const h = harness({ [tag(key)]: [
    row('missing-key-tag', [projectTag]),
    row('wrong-project', [tag(key), 'project:other']),
    row('unscoped', [tag(key)]),
  ] });
  const result = await plan(index(), h);
  assert.deepEqual(result.mappings, []);
  assert.deepEqual(result.skips.map(({ id, reason }) => ({ id, reason })), [
    { id: 'missing-key-tag', reason: 'missing-exact-key-tag' },
    { id: 'unscoped', reason: 'project-tag-mismatch' },
    { id: 'wrong-project', reason: 'project-tag-mismatch' },
  ]);
});

test('requires one exact project tag and rejects mixed or multiple symbol tags', async () => {
  const otherKey = 'javascript|src/b.mjs|function|local|beta|0';
  const h = harness({ [tag(key)]: [
    row('mixed', [tag(key), projectTag, 'project:other']),
    row('two-keys', [tag(key), tag(otherKey), projectTag]),
    row('duplicate-project', [tag(key), projectTag, projectTag]),
  ] });
  const result = await plan(index(), h);
  assert.equal(result.mappings.length, 0);
  assert.deepEqual(result.skips.map(({ id, reason }) => ({ id, reason })), [
    { id: 'two-keys', reason: 'missing-exact-key-tag' },
    { id: 'duplicate-project', reason: 'project-tag-mismatch' },
    { id: 'mixed', reason: 'project-tag-mismatch' },
  ]);
});

test('reports capped lookups as truncated and never claims complete coverage', async () => {
  const h = harness({ [tag(key)]: Array.from({ length: 100 }, (_, i) => row(`m${i}`)) });
  const result = await plan(index(), h);
  assert.equal(result.mappings.length, 0);
  assert.deepEqual(result.skips, [{ symbolKey: key, reason: 'lookup-truncated', lookupTag: tag(key), returned: 100, limit: 100 }]);
  assert.equal(result.coverage.complete, false);
});

test('reports prelinked, conflicting, and invalid-id rows without attaching', async () => {
  const otherKey = 'javascript|src/b.mjs|function|local|beta|0';
  const h = harness({ [tag(key)]: [
    row('same', [tag(key), projectTag], { symbol_key: key }),
    row('conflict', [tag(key), projectTag], { symbol_key: otherKey }),
    row('', [tag(key), projectTag]),
  ] });
  const result = await plan(index(), h);
  assert.deepEqual(result.mappings, []);
  assert.deepEqual(result.skips.map(({ id, reason }) => ({ id, reason })), [
    { id: 'same', reason: 'already-linked' },
    { id: 'conflict', reason: 'conflicting-symbol-key' },
    { id: undefined, reason: 'invalid-memory-id' },
  ]);
});

test('supports consistent camel-case linkage but rejects conflicting representations', async () => {
  const h = harness({ [tag(key)]: [
    row('camel', [tag(key), projectTag], { symbolKey: key }),
    row('inconsistent', [tag(key), projectTag], { symbol_key: key, symbolKey: 'different' }),
  ] });
  const result = await plan(index(), h);
  assert.equal(result.skips.length, 2);
  assert.deepEqual(result.skips.map((s) => s.reason).sort(), ['already-linked', 'conflicting-symbol-key']);
});

test('duplicate IDs fail closed when one row is already linked, in either query order', async () => {
  const second = 'javascript|src/b.mjs|function|local|beta|0';
  for (const [firstKey, secondKey] of [[key, second], [second, key]]) {
    const responses = {
      [tag(key)]: [row('duplicate', [tag(key), projectTag], { symbol_key: key })],
      [tag(second)]: [row('duplicate', [tag(second), projectTag])],
    };
    const result = await plan(index({ [firstKey]: {}, [secondKey]: {} }), harness(responses));
    assert.deepEqual(result.mappings, []);
    assert.deepEqual(result.skips.filter((skip) => skip.reason === 'duplicate-memory-id'), [
      { symbolKey: key, reason: 'duplicate-memory-id', id: 'duplicate' },
      { symbolKey: second, reason: 'duplicate-memory-id', id: 'duplicate' },
    ]);
  }
});

test('duplicate IDs within one lookup group are reported and never mapped', async () => {
  const h = harness({ [tag(key)]: [row('same'), row('same')] });
  const result = await plan(index(), h);
  assert.deepEqual(result.mappings, []);
  assert.deepEqual(result.skips.filter((skip) => skip.reason === 'duplicate-memory-id'), [
    { symbolKey: key, reason: 'duplicate-memory-id', id: 'same' },
  ]);
});

test('accepts literal one-character and space-containing project tags exactly', async () => {
  const h = harness({ [tag(key)]: [row('memory-a', [tag(key), 'project:a'])] });
  const oneCharacter = await plan(index(), h, { projectTag: 'project:a' });
  assert.deepEqual(oneCharacter.mappings.map((mapping) => mapping.id), ['memory-a']);

  const spaced = 'project:my project';
  const exact = await plan(index(), harness({ [tag(key)]: [row('memory-space', [tag(key), spaced])] }), { projectTag: spaced });
  assert.deepEqual(exact.mappings.map((mapping) => mapping.id), ['memory-space']);
  const mismatched = await plan(index(), harness({ [tag(key)]: [row('memory-space', [tag(key), 'project:my  project'])] }), { projectTag: spaced });
  assert.deepEqual(mismatched.skips.map(({ id, reason }) => ({ id, reason })), [
    { id: 'memory-space', reason: 'project-tag-mismatch' },
  ]);
});

test('validates index and nonempty project tag before querying', async () => {
  const h = harness();
  for (const symbolIndex of [null, [], 'bad']) {
    await assert.rejects(plan(symbolIndex, h), /symbolIndex/);
  }
  await assert.rejects(plan(index(), h, { projectTag: '' }), /projectTag/);
  await assert.rejects(plan(index(), h, { projectTag: 'project:' }), /projectTag/);
  await assert.rejects(plan(index(), h, { projectTag: 'project:   ' }), /projectTag/);
  await assert.rejects(plan(index(), h, { projectTag: 'not-a-project-tag' }), /projectTag/);
  assert.equal(h.queries.length, 0);
});

test('propagates lookup failures rather than claiming complete dry-run results', async () => {
  const h = harness(new Error('search failed'));
  await assert.rejects(plan(index(), h), /search failed/);
  const invalidJson = harness();
  invalidJson.findMemoriesByKeyTag = async () => { throw new SyntaxError('invalid JSON'); };
  await assert.rejects(plan(index(), invalidJson), /invalid JSON/);
});

test('propagates MCP isError and malformed JSON from the existing exact-tag search helper', async () => {
  for (const response of [
    { isError: true, content: [{ type: 'text', text: 'backend rejected search' }] },
    { content: [{ type: 'text', text: '{not json' }] },
  ]) {
    const client = { async callTool() { return response; } };
    await assert.rejects(planSymbolKeyBackfill({ symbolIndex: index(), projectTag, client }), /backend rejected search|JSON/);
  }
});

test('validates canonical C# seven-part symbol keys', async () => {
  const csharp = 'csharp|src\\Thing.cs|Acme|Thing|method|Run|()';
  const h = harness({ [tag(csharp)]: [row('csharp-memory', [tag(csharp), projectTag])] });
  const result = await plan(index({ [csharp]: { filePath: 'src\\Thing.cs' } }), h);
  assert.deepEqual(result.mappings.map((m) => m.symbolKey), [csharp]);
  const malformed = 'csharp|src/Thing.cs|too|few|parts';
  const malformedResult = await plan(index({ [malformed]: { filePath: 'src/Thing.cs' } }), harness());
  assert.equal(malformedResult.mappings.length, 0);
  assert.equal(malformedResult.skips[0].reason, 'invalid-symbol-key');
});

// Application-path contracts are tested with temporary project roots and fake MCP clients only.
async function projectFixture({ slug = 'sample', indexData = { [key]: {} } } = {}) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-symbol-backfill-'));
  await mkdir(join(projectRoot, '.planning', 'project-memory-context', 'enrichment'), { recursive: true });
  await writeFile(join(projectRoot, '.planning', 'project-memory-context', 'enrichment', 'symbol-index.json'), JSON.stringify(indexData));
  await writeFile(join(projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: { 'agent-memory': { command: 'fake', args: [], env: {} } } }));
  return { projectRoot, slug, cleanup: () => rm(projectRoot, { recursive: true, force: true }) };
}

function cliDeps(client, extras = {}) {
  const events = [];
  return {
    events,
    deps: {
      env: { PMC_PROJECT_SLUG: 'sample' },
      connect: async (server) => {
        events.push(['connect', server]);
        return { client, close: async () => events.push(['close']) };
      },
      log: (line) => events.push(['log', String(line)]),
      errLog: (line) => events.push(['error', String(line)]),
      ...extras,
    },
  };
}

test('CLI help and invalid arguments return before loading project config or connecting MCP', async () => {
  const h = cliDeps({});
  let code = await backfillMain(['--help'], h.deps);
  assert.equal(code, 0);
  for (const args of [['--aply'], ['--project-slug'], ['--project-slug', ''], ['one', 'two'], ['--unknown']]) {
    code = await backfillMain(args, h.deps);
    assert.equal(code, 1, args.join(' '));
  }
  assert.equal(h.events.filter(([kind]) => kind === 'connect').length, 0);
});

test('missing and malformed symbol indexes fail before MCP setup', async () => {
  const missingRoot = await mkdtemp(join(tmpdir(), 'pmc-symbol-backfill-missing-'));
  const fixture = await projectFixture();
  const h = cliDeps({});
  try {
    const missingCode = await backfillMain([missingRoot], h.deps);
    assert.equal(missingCode, 1);
    await writeFile(join(fixture.projectRoot, '.planning', 'project-memory-context', 'enrichment', 'symbol-index.json'), '[]');
    const malformedCode = await backfillMain([fixture.projectRoot], h.deps);
    assert.equal(malformedCode, 1);
    assert.equal(h.events.filter(([kind]) => kind === 'connect').length, 0);
  } finally {
    await rm(missingRoot, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test('connectAgentMemory supports injected MCP client and stdio transport factories', async () => {
  const { connectAgentMemory } = await import('../cli/backfill-symbol-keys.mjs');
  const calls = [];
  class FakeTransport {
    constructor(options) { calls.push(['transport', options]); }
    async close() { calls.push(['transport-close']); }
  }
  class FakeClient {
    constructor(options) { calls.push(['client', options]); }
    async connect(transport) { this.transport = transport; calls.push(['client-connect']); }
    async close() { calls.push(['client-close']); await this.transport.close(); }
  }
  const connection = await connectAgentMemory({ command: 'fake-server', args: ['--stdio'], env: { CUSTOM: 'value' } }, {
    ClientImpl: FakeClient,
    StdioClientTransportImpl: FakeTransport,
  });
  await connection.close();
  assert.equal(calls[0][0], 'transport');
  assert.equal(calls[0][1].command, 'fake-server');
  assert.deepEqual(calls[0][1].args, ['--stdio']);
  assert.equal(calls[0][1].env.CUSTOM, 'value');
  assert.deepEqual(calls.slice(-2).map(([kind]) => kind), ['client-close', 'transport-close']);
});

test('CLI starts the stdio MCP command in the resolved target project root', async () => {
  const fixture = await projectFixture();
  let transportOptions;
  class FakeTransport { constructor(options) { transportOptions = options; } async close() {} }
  class FakeClient { async connect() {} async close() {} async callTool() { return { content: [{ text: JSON.stringify({ results: [] }) }] }; } }
  const h = cliDeps({});
  try {
    await backfillMain([fixture.projectRoot], { ...h.deps, connect: undefined, ClientImpl: FakeClient, StdioClientTransportImpl: FakeTransport });
    assert.equal(transportOptions.cwd, resolve(fixture.projectRoot));
    assert.notEqual(transportOptions.cwd, process.cwd());
  } finally { await fixture.cleanup(); }
});

test('connect failure closes transport and preserves the original connection error', async () => {
  const calls = [];
  class FakeTransport { async close() { calls.push('transport-close'); } }
  class FakeClient { async connect() { throw new Error('connect failed'); } }
  const { connectAgentMemory } = await import('../cli/backfill-symbol-keys.mjs');
  await assert.rejects(connectAgentMemory({ command: 'fake' }, { ClientImpl: FakeClient, StdioClientTransportImpl: FakeTransport }), /connect failed/);
  assert.deepEqual(calls, ['transport-close']);
});

test('CLI defaults to dry-run and closes its MCP connection after exact-tag queries', async () => {
  const fixture = await projectFixture();
  const calls = [];
  const client = { async callTool(request) {
    calls.push(request);
    return { content: [{ text: JSON.stringify({ results: [{ memory: row('legacy') }] }) }] };
  } };
  const h = cliDeps(client);
  h.deps.env = {};
  try {
    const code = await backfillMain([fixture.projectRoot], h.deps);
    assert.equal(code, 0);
    assert.deepEqual(calls.map(({ name }) => name), ['search']);
    assert.deepEqual(calls[0].arguments.tags, [tag(key)]);
    const output = JSON.parse(h.events.find(([kind]) => kind === 'log')[1]);
    assert.equal(output.dryRun, true);
    assert.equal(output.projectTag, `project:${basename(fixture.projectRoot)}`);
    assert.deepEqual(h.events.at(-1), ['close']);
  } finally { await fixture.cleanup(); }
});

test('CLI applies only a freshly planned complete mapping and reports applied count', async () => {
  const fixture = await projectFixture();
  const calls = [];
  const client = { async callTool(request) {
    calls.push(request);
    return request.name === 'search'
      ? { content: [{ text: JSON.stringify({ results: [{ memory: row('legacy', [tag(key), 'project:Exact Slug']) }] }) }] }
      : { content: [{ text: '{}'}] };
  } };
  const h = cliDeps(client);
  try {
    const code = await backfillMain([fixture.projectRoot, '--apply', '--project-slug', 'Exact Slug'], h.deps);
    assert.equal(code, 0);
    assert.deepEqual(calls.map(({ name }) => name), ['search', 'attach_symbol']);
    assert.deepEqual(calls[1].arguments, { memory_id: 'legacy', symbol_key: key });
    const output = JSON.parse(h.events.find(([kind]) => kind === 'log')[1]);
    assert.equal(output.applied, 1);
    assert.equal(output.failed, 0);
    assert.equal(output.projectTag, 'project:Exact Slug');
  } finally { await fixture.cleanup(); }
});

test('a capped later lookup aborts all mappings, including a valid earlier mapping and repeated ID', async () => {
  const second = 'javascript|src/b.mjs|function|local|beta|0';
  const fixture = await projectFixture({ indexData: { [key]: {}, [second]: {} } });
  const calls = [];
  const client = { async callTool(request) {
    calls.push(request);
    if (request.name !== 'search') return { content: [{ text: '{}' }] };
    const lookupTag = request.arguments.tags[0];
    const results = lookupTag === tag(key)
      ? [{ memory: row('shared', [tag(key), projectTag]) }]
      : Array.from({ length: 100 }, (_, i) => ({ memory: row(i === 0 ? 'shared' : `m${i}`, [tag(second), projectTag]) }));
    return { content: [{ text: JSON.stringify({ results }) }] };
  } };
  const h = cliDeps(client);
  try {
    const code = await backfillMain([fixture.projectRoot, '--apply'], h.deps);
    assert.equal(code, 1);
    assert.deepEqual(calls.map(({ name }) => name), ['search', 'search']);
    const output = JSON.parse(h.events.find(([kind]) => kind === 'log')[1]);
    assert.equal(output.coverage.complete, false);
    assert.equal(output.mappings.some(({ id }) => id === 'shared'), true);
    assert.equal(output.applied, 0);
    assert.equal(output.failed, 0);
    assert.match(h.events.find(([kind]) => kind === 'error')[1], /incomplete/i);
  } finally { await fixture.cleanup(); }
});

test('MCP close failure is reported without distorting applied counts', async () => {
  const fixture = await projectFixture();
  const client = { async callTool(request) {
    return request.name === 'search'
      ? { content: [{ text: JSON.stringify({ results: [{ memory: row('attached') }] }) }] }
      : { content: [{ text: '{}' }] };
  } };
  const h = cliDeps(client, { connect: async () => ({ client, close: async () => { throw new Error('close failed'); } }) });
  try {
    const code = await backfillMain([fixture.projectRoot, '--apply'], h.deps);
    assert.equal(code, 0);
    const output = JSON.parse(h.events.find(([kind]) => kind === 'log')[1]);
    assert.equal(output.applied, 1);
    assert.deepEqual(output.appliedIds, ['attached']);
    assert.equal(output.failed, 0);
    assert.match(h.events.find(([kind]) => kind === 'error')[1], /cleanup failed: close failed/);
  } finally { await fixture.cleanup(); }
});

test('owned SQLite v7 fixture is read by the actual symbol reader and rendered by get-context main', async () => {
  const fixture = await projectFixture();
  const symbolKey = 'ts|src/alpha.ts|function|exported|alpha|0';
  const memoryBase = join(fixture.projectRoot, '.planning', 'project-memory-context', 'memory-db');
  const dbPath = `${memoryBase}.db`;
  const db = new DatabaseSync(dbPath);
  let reader;
  const originalCwd = process.cwd();
  const originalLog = console.log;
  const output = [];
  try {
    db.exec(`CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      symbol_key TEXT
    )`);
    db.prepare('INSERT INTO memories (id, content, created_at, symbol_key) VALUES (?, ?, ?, ?)')
      .run('sqlite-memory', 'Owned SQLite fixture record: alpha context', '2026-01-01T00:00:00.000Z', symbolKey);
    db.close();
    reader = createSqliteSymbolReader(dbPath);
    const readback = (await reader.getBySymbol(symbolKey))[0].content;
    assert.equal(readback, 'Owned SQLite fixture record: alpha context');
    assert.equal(readback.includes('Semantic Memory'), false);
    reader.close();
    reader = null;

    await mkdir(join(fixture.projectRoot, '.planning', 'project-memory-context', 'enrichment'), { recursive: true });
    await mkdir(join(fixture.projectRoot, '.planning', 'project-memory-context', 'graph'), { recursive: true });
    await writeFile(join(fixture.projectRoot, '.planning', 'project-memory-context', 'install.json'), '{}');
    await writeFile(join(fixture.projectRoot, '.planning', 'project-memory-context', 'enrichment', 'symbol-index.json'), JSON.stringify({ [symbolKey]: { graphNodeId: 'alpha-node' } }));
    await writeFile(join(fixture.projectRoot, '.planning', 'project-memory-context', 'enrichment', 'worklist.json'), JSON.stringify([{ symbolKey, name: 'alpha', filePath: 'src/alpha.ts', kind: 'function' }]));
    await writeFile(join(fixture.projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: { 'agent-memory': { env: { MEMORY_DB_PATH: memoryBase } } } }));
    process.chdir(fixture.projectRoot);
    console.log = (...args) => output.push(args.join(' '));
    const code = await contextMain(['symbol', 'alpha']);
    assert.equal(code, 0);
    assert.ok(!output.join('\n').includes('Semantic Memory from owned SQLite fixture'));
    assert.ok(output.join('\n').includes('Summary\n- Symbol: alpha (function)\nTarget\n  mode: symbol'));
    assert.ok(output.join('\n').includes('Semantic Memory\n- Owned SQLite fixture record: alpha context'));
  } finally {
    console.log = originalLog;
    process.chdir(originalCwd);
    reader?.close();
    await fixture.cleanup();
  }
});

test('CLI stops on a middle mutation failure and reports only the actual prior successful ID', async () => {
  const second = 'javascript|src/b.mjs|function|local|beta|0';
  const third = 'javascript|src/c.mjs|function|local|gamma|0';
  const fixture = await projectFixture({ indexData: { [key]: {}, [second]: {}, [third]: {} } });
  const calls = [];
  const client = { async callTool(request) {
    calls.push(request);
    if (request.name === 'search') {
      const symbolKey = [key, second, third].find((candidate) => request.arguments.tags[0] === tag(candidate));
      const id = symbolKey === key ? 'first' : symbolKey === second ? 'middle-fail' : 'third';
      return { content: [{ text: JSON.stringify({ results: [{ memory: row(id, [tag(symbolKey), projectTag]) }] }) }] };
    }
    if (request.arguments.memory_id === 'middle-fail') return { isError: true, content: [{ text: 'backend denied attach' }] };
    return { content: [{ text: '{}'}] };
  } };
  const h = cliDeps(client);
  try {
    const code = await backfillMain([fixture.projectRoot, '--apply'], h.deps);
    assert.equal(code, 1);
    assert.deepEqual(calls.filter(({ name }) => name === 'attach_symbol').map(({ arguments: args }) => args.memory_id), ['first', 'middle-fail']);
    const output = JSON.parse(h.events.find(([kind]) => kind === 'log')[1]);
    assert.equal(output.applied, 1);
    assert.equal(output.failed, 1);
    assert.deepEqual(output.appliedIds, ['first']);
    assert.equal(output.failedId, 'middle-fail');
    assert.equal(output.error, 'backend denied attach');
    assert.deepEqual(h.events.at(-1), ['close']);
  } finally { await fixture.cleanup(); }
});
