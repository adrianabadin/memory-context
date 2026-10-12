import test from 'node:test';
import assert from 'node:assert/strict';
import { planSymbolKeyBackfill } from '../cli/backfill-symbol-keys.mjs';

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
