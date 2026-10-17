import test from 'node:test';
import assert from 'node:assert/strict';

const key = (name) => `ts|src/worker.ts|function|exported|${name}|0`;
const edge = (source, target, relation = 'calls') => ({ source: { id: key(source) }, target: { id: key(target) }, relation });
const load = () => import('../src/cards/batch-pool.mjs');
const orderLoad = () => import('../src/cards/order.mjs');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    if (predicate()) return;
    await new Promise((onIdle) => setImmediate(onIdle));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

const drain = () => new Promise((onIdle) => setImmediate(onIdle));

test('S12 bounded pool caps active callbacks at 1, 2 and 8 and fills every slot before any completion', async () => {
  const { runNarrativePool } = await load();
  for (const concurrency of [1, 2, 8]) {
    const keys = Array.from({ length: 8 }, (_, index) => key(`iso${index}`));
    const deferreds = new Map(keys.map((symbolKey) => [symbolKey, deferred()]));
    let active = 0;
    let peak = 0;
    let completed = 0;
    const run = (symbolKey) => {
      active += 1;
      peak = Math.max(peak, active);
      return deferreds.get(symbolKey).promise.then((value) => {
        active -= 1;
        completed += 1;
        return value;
      });
    };
    const pool = runNarrativePool({ symbolKeys: keys, edges: [], concurrency, run });
    const expected = Math.min(concurrency, keys.length);
    await waitFor(() => active === expected, `initial fill at concurrency ${concurrency}`);
    assert.equal(active, expected);
    assert.equal(completed, 0, 'every slot must be busy before any job completes (overlap proof)');
    for (const symbolKey of keys) {
      deferreds.get(symbolKey).resolve(symbolKey);
      await waitFor(() => active > 0 || completed === keys.length, `refill at concurrency ${concurrency}`);
      assert.ok(peak <= concurrency, `peak ${peak} must stay within ${concurrency}`);
    }
    const results = await pool;
    assert.equal(peak, expected, `the pool must actually reach ${concurrency} active callbacks`);
    assert.equal(active, 0);
    assert.deepEqual(results.map((entry) => entry.key), keys);
    assert.ok(results.every((entry) => entry.status === 'fulfilled' && entry.value === entry.key));
  }
});

test('S12 caller starts only after every callee settles while independent branches share slots', async () => {
  const { runNarrativePool } = await load();
  const keys = ['a', 'b', 'c', 'd'].map(key);
  const deferreds = new Map(keys.map((symbolKey) => [symbolKey, deferred()]));
  const started = [];
  let active = 0;
  const run = (symbolKey) => {
    started.push(symbolKey);
    active += 1;
    return deferreds.get(symbolKey).promise.then((value) => {
      active -= 1;
      return value;
    });
  };
  const pool = runNarrativePool({
    symbolKeys: keys,
    edges: [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')],
    concurrency: 4,
    run,
  });
  await waitFor(() => started.length === 1, 'leaf starts first');
  assert.deepEqual(started, [key('d')]);
  deferreds.get(key('d')).resolve('done:d');
  await waitFor(() => started.length === 3, 'independent branches start together');
  assert.deepEqual(started, [key('d'), key('b'), key('c')]);
  assert.equal(active, 2, 'the two sibling callees occupy separate slots simultaneously');
  deferreds.get(key('b')).resolve('done:b');
  await waitFor(() => active === 1, 'b settles while c keeps running');
  await drain();
  assert.equal(started.length, 3, 'the caller waits for the still-running sibling callee');
  assert.ok(!started.includes(key('a')));
  deferreds.get(key('c')).resolve('done:c');
  await waitFor(() => started.length === 4, 'caller starts after both callees settle');
  assert.equal(started.at(-1), key('a'));
  deferreds.get(key('a')).resolve('done:a');
  const results = await pool;
  assert.deepEqual(results.map((entry) => entry.key), [key('d'), key('b'), key('c'), key('a')]);
  assert.ok(results.every((entry) => entry.status === 'fulfilled'));
});

test('S12 SCC members run exactly once in one pass while the upstream caller waits for the whole cycle', async () => {
  const { runNarrativePool } = await load();
  const keys = ['a', 'b', 'c'].map(key);
  const deferreds = new Map(keys.map((symbolKey) => [symbolKey, deferred()]));
  const started = [];
  const invocations = new Map(keys.map((symbolKey) => [symbolKey, 0]));
  const run = (symbolKey) => {
    started.push(symbolKey);
    invocations.set(symbolKey, invocations.get(symbolKey) + 1);
    return deferreds.get(symbolKey).promise;
  };
  const pool = runNarrativePool({
    symbolKeys: keys,
    edges: [edge('a', 'b'), edge('b', 'a'), edge('b', 'b'), edge('c', 'a')],
    concurrency: 4,
    run,
  });
  await waitFor(() => started.length === 2, 'both cycle members start in one pass');
  assert.deepEqual(started, [key('a'), key('b')]);
  deferreds.get(key('a')).resolve('done:a');
  await drain();
  assert.equal(started.length, 2, 'the caller must not start while a cycle member is unsettled');
  assert.ok(!started.includes(key('c')));
  deferreds.get(key('b')).resolve('done:b');
  await waitFor(() => started.length === 3, 'caller starts after the cycle settles');
  assert.equal(started.at(-1), key('c'));
  deferreds.get(key('c')).resolve('done:c');
  const results = await pool;
  assert.deepEqual(results.map((entry) => entry.key), [key('a'), key('b'), key('c')]);
  for (const symbolKey of keys) assert.equal(invocations.get(symbolKey), 1, `${symbolKey} runs exactly once`);
  assert.deepEqual(results.map((entry) => entry.value), ['done:a', 'done:b', 'done:c']);
});

test('S12 results keep the N2 canonical SCC/member order regardless of completion order', async () => {
  const { runNarrativePool } = await load();
  const { orderNarratives } = await orderLoad();
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  const symbolKeys = names.map(key);
  const edges = [edge('a', 'b'), edge('b', 'c')];
  const deferreds = new Map(symbolKeys.map((symbolKey) => [symbolKey, deferred()]));
  const started = [];
  const run = (symbolKey) => {
    started.push(symbolKey);
    return deferreds.get(symbolKey).promise;
  };
  const pool = runNarrativePool({ symbolKeys, edges, concurrency: 4, run });
  await waitFor(() => started.length === 4, 'leaf and isolates dispatch together');
  for (const name of ['f', 'e', 'd', 'c']) {
    deferreds.get(key(name)).resolve(`done:${name}`);
    await drain();
  }
  await waitFor(() => started.length === 5, 'next caller dispatches');
  deferreds.get(key('b')).resolve('done:b');
  await waitFor(() => started.length === 6, 'root caller dispatches');
  deferreds.get(key('a')).resolve('done:a');
  const results = await pool;
  assert.deepEqual(results.map((entry) => entry.key), [key('c'), key('b'), key('a'), key('d'), key('e'), key('f')]);
  assert.deepEqual(results.map((entry) => entry.key), orderNarratives({ symbolKeys, edges }).flat());
  assert.deepEqual(results.map((entry) => entry.value), ['done:c', 'done:b', 'done:a', 'done:d', 'done:e', 'done:f']);
  assert.ok(results.every((entry) => entry.status === 'fulfilled'));
});

test('S12 callback failures settle per key, independent jobs keep completing and the caller barrier releases', async () => {
  const { runNarrativePool } = await load();
  const keys = ['a', 'b', 'c', 'd', 'e'].map(key);
  const errorB = new Error('callee failed');
  const errorC = new Error('synchronous throw');
  const errorD = new Error('rejected promise');
  const deferredB = deferred();
  const started = [];
  const run = (symbolKey) => {
    started.push(symbolKey);
    if (symbolKey === key('b')) return deferredB.promise;
    if (symbolKey === key('c')) throw errorC;
    if (symbolKey === key('d')) return Promise.reject(errorD);
    if (symbolKey === key('e')) return Promise.resolve('done:e');
    return Promise.resolve('done:a');
  };
  const pool = runNarrativePool({ symbolKeys: keys, edges: [edge('a', 'b')], concurrency: 4, run });
  await waitFor(() => started.length === 4, 'leaf batches dispatch together');
  assert.deepEqual(started, [key('b'), key('c'), key('d'), key('e')]);
  await drain();
  deferredB.reject(errorB);
  await waitFor(() => started.includes(key('a')), 'caller dispatches after the failed callee settles');
  const results = await pool;
  assert.deepEqual(results.map((entry) => entry.key), [key('b'), key('a'), key('c'), key('d'), key('e')]);
  const byKey = new Map(results.map((entry) => [entry.key, entry]));
  assert.equal(byKey.get(key('b')).status, 'rejected');
  assert.equal(byKey.get(key('b')).reason, errorB, 'the original error object is preserved by reference');
  assert.equal(byKey.get(key('c')).status, 'rejected');
  assert.equal(byKey.get(key('c')).reason, errorC, 'synchronous throws become rejected settled results');
  assert.equal(byKey.get(key('d')).status, 'rejected');
  assert.equal(byKey.get(key('d')).reason, errorD);
  for (const symbolKey of [key('b'), key('c'), key('d')]) {
    assert.ok(!('value' in byKey.get(symbolKey)), 'a failure never fabricates a success value');
  }
  assert.equal(byKey.get(key('a')).status, 'fulfilled');
  assert.equal(byKey.get(key('a')).value, 'done:a');
  assert.equal(byKey.get(key('e')).status, 'fulfilled');
  assert.equal(byKey.get(key('e')).value, 'done:e', 'independent jobs still complete');
});

test('S12 a 3000-symbol chain settles iteratively without stack overflow', async () => {
  const { runNarrativePool } = await load();
  const { orderNarratives } = await orderLoad();
  const names = Array.from({ length: 3000 }, (_, index) => String(index).padStart(4, '0'));
  const symbolKeys = names.map(key);
  const edges = names.slice(0, -1).map((name, index) => edge(name, names[index + 1]));
  const results = await runNarrativePool({
    symbolKeys,
    edges,
    concurrency: 8,
    run: (symbolKey) => Promise.resolve(symbolKey),
  });
  assert.equal(results.length, names.length);
  assert.deepEqual(results.map((entry) => entry.key), orderNarratives({ symbolKeys, edges }).flat());
  assert.equal(results[0].key, key(names.at(-1)));
  assert.equal(results.at(-1).key, key(names[0]));
  assert.ok(results.every((entry) => entry.status === 'fulfilled'));
});

test('S12 caller inputs stay byte-identical and callback values are kept by reference', async () => {
  const { runNarrativePool } = await load();
  const { orderNarratives } = await orderLoad();
  const symbolKeys = ['b', 'a', 'c'].map(key);
  const edges = [edge('a', 'b'), edge('b', 'c')];
  const before = JSON.stringify({ symbolKeys, edges });
  const produced = { summary: 'kept', nested: { list: [1, 2] } };
  for (const item of edges) {
    Object.freeze(item.source);
    Object.freeze(item.target);
    Object.freeze(item);
  }
  Object.freeze(symbolKeys);
  Object.freeze(edges);
  const results = await runNarrativePool({ symbolKeys, edges, concurrency: 2, run: () => produced });
  assert.equal(JSON.stringify({ symbolKeys, edges }), before, 'inputs are never mutated');
  assert.deepEqual(symbolKeys, ['b', 'a', 'c'].map(key), 'caller key order is untouched');
  assert.ok(results.every((entry) => entry.value === produced), 'callback values are stored by reference');
  assert.deepEqual(results.map((entry) => entry.key), orderNarratives({ symbolKeys, edges }).flat());
});

test('S12 invalid options, graph shapes and concurrency reject before any callback dispatch', async () => {
  const { runNarrativePool } = await load();
  let dispatched = 0;
  const run = () => {
    dispatched += 1;
    return Promise.resolve('x');
  };
  const badInputs = [
    null,
    [],
    'pool',
    { symbolKeys: [key('a')], edges: [], concurrency: 1, run, typo: true },
    { symbolKeys: [key('a')], edges: [], run },
    { symbolKeys: [key('a')], edges: [], concurrency: 0, run },
    { symbolKeys: [key('a')], edges: [], concurrency: -1, run },
    { symbolKeys: [key('a')], edges: [], concurrency: 1.5, run },
    { symbolKeys: [key('a')], edges: [], concurrency: NaN, run },
    { symbolKeys: [key('a')], edges: [], concurrency: Infinity, run },
    { symbolKeys: [key('a')], edges: [], concurrency: '2', run },
    { symbolKeys: [key('a')], edges: [], concurrency: true, run },
    { symbolKeys: [key('a')], edges: [], concurrency: 1 },
    { symbolKeys: [key('a')], edges: [], concurrency: 1, run: 'nope' },
    { symbolKeys: [key('a')], edges: [], concurrency: 1, run: null },
    { symbolKeys: [key('a')], edges: [], concurrency: 1, run, prepareBatch: 'nope' },
    { symbolKeys: [key('a'), key('a')], edges: [], concurrency: 1, run },
    { symbolKeys: [key('a')], edges: null, concurrency: 1, run },
    { symbolKeys: null, edges: [], concurrency: 1, run },
    { symbolKeys: [key('a')], edges: [{ relation: 'calls', source: 'raw', target: { id: key('a') } }], concurrency: 1, run },
    { symbolKeys: [key('a')], edges: [{ relation: 'calls', source: { id: key('a'), symbolKey: key('other') }, target: { id: key('a') } }], concurrency: 1, run },
  ];
  for (const input of badInputs) assert.throws(() => runNarrativePool(input), TypeError);
  assert.equal(dispatched, 0, 'rejected input never dispatches a callback');
});

test('S12 empty graphs resolve an empty result without invoking callbacks', async () => {
  const { runNarrativePool } = await load();
  let dispatched = 0;
  const results = await runNarrativePool({
    symbolKeys: [],
    edges: [],
    concurrency: 4,
    run: () => {
      dispatched += 1;
      return Promise.resolve('x');
    },
    prepareBatch: () => {
      dispatched += 1;
      return Promise.resolve();
    },
  });
  assert.deepEqual(results, []);
  assert.equal(dispatched, 0);
});

test('S12 prepareBatch runs exactly once per SCC and finishes before any member dispatch', async () => {
  const { runNarrativePool } = await load();
  const keys = ['a', 'b', 'c', 'd'].map(key);
  const deferreds = new Map(keys.map((symbolKey) => [symbolKey, deferred()]));
  const events = [];
  const prepareCalls = [];
  const prepareGates = [];
  const prepareBatch = (members) => {
    const gate = deferred();
    prepareCalls.push(members.slice());
    prepareGates.push(gate);
    events.push({ type: 'prepare', members: members.slice() });
    return gate.promise;
  };
  const run = (symbolKey) => {
    events.push({ type: 'run', symbolKey });
    return deferreds.get(symbolKey).promise.then((value) => {
      events.push({ type: 'done', symbolKey });
      return value;
    });
  };
  const pool = runNarrativePool({
    symbolKeys: keys,
    edges: [edge('a', 'b'), edge('b', 'a'), edge('c', 'a')],
    concurrency: 4,
    run,
    prepareBatch,
  });
  assert.deepEqual(prepareCalls, [[key('a'), key('b')], [key('d')]], 'each ready SCC prepares exactly once');
  assert.deepEqual(events.map((event) => event.type), ['prepare', 'prepare'], 'no member dispatches before preparation');
  prepareGates[0].resolve();
  await waitFor(() => events.filter((event) => event.type === 'run').length === 2, 'cycle members dispatch after their prepare resolves');
  assert.deepEqual(events.filter((event) => event.type === 'run').map((event) => event.symbolKey), [key('a'), key('b')]);
  prepareGates[1].resolve();
  await waitFor(() => events.some((event) => event.type === 'run' && event.symbolKey === key('d')), 'isolate dispatches after its prepare resolves');
  deferreds.get(key('a')).resolve('done:a');
  deferreds.get(key('b')).resolve('done:b');
  await waitFor(() => prepareCalls.length === 3, 'caller prepares after its whole SCC settles');
  assert.deepEqual(prepareCalls[2], [key('c')]);
  const prepareIndex = (symbolKey) => events.findIndex((event) => event.type === 'prepare' && event.members.includes(symbolKey));
  const doneIndex = (symbolKey) => events.findIndex((event) => event.type === 'done' && event.symbolKey === symbolKey);
  assert.ok(prepareIndex(key('c')) > doneIndex(key('a')), 'caller preparation follows the settled callee');
  assert.ok(prepareIndex(key('c')) > doneIndex(key('b')), 'caller preparation follows the settled cycle');
  prepareGates[2].resolve();
  await waitFor(() => events.some((event) => event.type === 'run' && event.symbolKey === key('c')), 'caller dispatches after its prepare resolves');
  deferreds.get(key('c')).resolve('done:c');
  deferreds.get(key('d')).resolve('done:d');
  const results = await pool;
  assert.deepEqual(results.map((entry) => entry.key), [key('a'), key('b'), key('c'), key('d')]);
  assert.deepEqual(results.map((entry) => entry.value), ['done:a', 'done:b', 'done:c', 'done:d']);
  assert.equal(prepareCalls.length, 3, 'exactly one preparation per SCC');
});

test('S12 a rejected prepareBatch settles its SCC members honestly and still releases callers', async () => {
  const { runNarrativePool } = await load();
  const keys = ['a', 'b', 'c'].map(key);
  const prepareError = new Error('fresh context failed');
  const started = [];
  let prepareCalls = 0;
  const results = await runNarrativePool({
    symbolKeys: keys,
    edges: [edge('a', 'b'), edge('b', 'a'), edge('c', 'a')],
    concurrency: 4,
    run: (symbolKey) => {
      started.push(symbolKey);
      return Promise.resolve(`done:${symbolKey}`);
    },
    prepareBatch: () => {
      prepareCalls += 1;
      return prepareCalls === 1 ? Promise.reject(prepareError) : Promise.resolve();
    },
  });
  const byKey = new Map(results.map((entry) => [entry.key, entry]));
  assert.equal(prepareCalls, 2, 'the caller still prepares after its failed callee SCC settles');
  assert.deepEqual(started, [key('c')], 'cycle members never run, but the caller is not deadlocked');
  for (const symbolKey of [key('a'), key('b')]) {
    const entry = byKey.get(symbolKey);
    assert.equal(entry.status, 'rejected');
    assert.equal(entry.reason, prepareError, 'the original preparation error is preserved by reference');
    assert.ok(!('value' in entry), 'a failed preparation never fabricates a success value');
  }
  assert.equal(byKey.get(key('c')).status, 'fulfilled');
  assert.equal(byKey.get(key('c')).value, `done:${key('c')}`);
  assert.deepEqual(results.map((entry) => entry.key), [key('a'), key('b'), key('c')]);
});
