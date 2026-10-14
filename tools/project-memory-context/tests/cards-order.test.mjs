import test from 'node:test';
import assert from 'node:assert/strict';

const key = (name) => `ts|src/worker.ts|function|exported|${name}|0`;
const edge = (source, target, relation = 'calls') => ({ source: { id: key(source) }, target: { id: key(target) }, relation });
const load = () => import('../src/cards/order.mjs');

test('S8 call chain emits callees before callers and preserves isolated symbols', async () => {
  const { orderNarratives } = await load();
  assert.deepEqual(orderNarratives({ symbolKeys: ['a', 'b', 'c', 'd'].map(key), edges: [edge('a', 'b'), edge('b', 'c')] }),
    [['c'], ['b'], ['a'], ['d']].map((batch) => batch.map(key)));
});

test('S8 cycles form one SCC batch; dependencies of the cycle are earlier', async () => {
  const { orderNarratives } = await load();
  const result = orderNarratives({ symbolKeys: ['a', 'b', 'c', 'd'].map(key),
    edges: [edge('a', 'b'), edge('b', 'a'), edge('b', 'c'), edge('d', 'a')] });
  assert.deepEqual(result, [['c'], ['a', 'b'], ['d']].map((batch) => batch.map(key)));
});

test('S8 shared callees, duplicate edges and self calls never duplicate symbols', async () => {
  const { orderNarratives } = await load();
  const edges = [edge('a', 'c'), edge('b', 'c'), edge('a', 'c'), edge('c', 'c')];
  const result = orderNarratives({ symbolKeys: ['a', 'b', 'c'].map(key), edges });
  assert.deepEqual(result, [['c'], ['a'], ['b']].map((batch) => batch.map(key)));
});

test('S8 non-call relations and endpoints outside the supplied graph do not create dependency batches', async () => {
  const { orderNarratives } = await load();
  assert.deepEqual(orderNarratives({ symbolKeys: ['a', 'b'].map(key),
    edges: [edge('a', 'b', 'imports'), edge('a', 'missing'), edge('missing', 'b')] }), [[key('a')], [key('b')]]);
  assert.deepEqual(orderNarratives({ symbolKeys: [], edges: [] }), []);
});

test('S8 ordering is deterministic across graph/edge permutations and does not mutate inputs', async () => {
  const { orderNarratives } = await load();
  const symbolKeys = ['d', 'c', 'b', 'a'].map(key);
  const edges = [edge('d', 'a'), edge('b', 'a'), edge('a', 'b'), edge('b', 'c')];
  const before = JSON.stringify({ symbolKeys, edges });
  const expected = orderNarratives({ symbolKeys, edges });
  for (const item of edges) { Object.freeze(item.source); Object.freeze(item.target); Object.freeze(item); }
  Object.freeze(symbolKeys); Object.freeze(edges);
  assert.deepEqual(orderNarratives({ symbolKeys, edges }), expected);
  assert.deepEqual(orderNarratives({ symbolKeys: [...symbolKeys].reverse(), edges: [...edges].reverse() }), expected);
  assert.equal(JSON.stringify({ symbolKeys, edges }), before);
});

test('S8 deep call chains are planned without recursive stack overflow', async () => {
  const { orderNarratives } = await load();
  const names = Array.from({ length: 3000 }, (_, index) => String(index).padStart(4, '0'));
  const result = orderNarratives({ symbolKeys: names.map(key),
    edges: names.slice(0, -1).map((name, index) => edge(name, names[index + 1])) });
  assert.equal(result.length, names.length);
  assert.deepEqual(result[0], [key(names.at(-1))]);
  assert.deepEqual(result.at(-1), [key(names[0])]);
});

test('S8 malformed graph options/endpoints and duplicate keys reject rather than selecting a winner', async () => {
  const { orderNarratives } = await load();
  for (const input of [null, [], { symbolKeys: [key('a')], typo: true },
    { symbolKeys: [key('a'), key('a')] }, { symbolKeys: [null] }, { symbolKeys: [key('a')], edges: null },
    { symbolKeys: [key('a')], edges: [{ relation: 'calls', source: 'raw', target: { id: key('a') } }] },
    { symbolKeys: [key('a')], edges: [{ relation: 'calls', source: { id: key('a'), symbolKey: key('other') }, target: { id: key('a') } }] },
  ]) assert.throws(() => orderNarratives(input), TypeError);
});
