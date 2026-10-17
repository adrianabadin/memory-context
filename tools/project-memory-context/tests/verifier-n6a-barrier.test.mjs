import test from 'node:test';
import assert from 'node:assert/strict';
import { runNarrativePool } from '../src/cards/batch-pool.mjs';

const edge = (a, b) => ({
  relation: 'calls', source: { id: a }, target: { id: b },
});
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

test('S12A mixed slots preserve whole-SCC failure barrier', async () => {
  const symbolKeys = ['caller', 'b', 'a', 'iso1', 'iso2'];
  const edges = [edge('a', 'b'), edge('b', 'a'), edge('caller', 'a')];
  const before = JSON.stringify({ symbolKeys, edges });
  const failure = new Error('controlled a failure');
  const gates = [], preparations = [], jobs = [];
  const settled = new Set();
  const live = { prepare: 0, run: 0 };
  let active = 0, maximum = 0, mixed = false;

  function barrier() {
    assert.ok(settled.has('a') && settled.has('b'),
      'caller waits for BOTH SCC members');
  }

  function hold(kind, key) {
    active++;
    live[kind]++;
    maximum = Math.max(maximum, active);
    mixed ||= live.prepare > 0 && live.run > 0;
    return new Promise((resolve, reject) => gates.push(() => {
      if (kind === 'run' && key === 'a') reject(failure);
      else resolve(key);
    })).finally(() => {
      active--;
      live[kind]--;
      if (kind === 'run') settled.add(key);
    });
  }

  const pending = runNarrativePool({
    symbolKeys, edges, concurrency: 2,
    prepareBatch(members) {
      if (members.includes('caller')) barrier();
      preparations.push([...members]);
      const key = members[0];
      members.reverse();
      return hold('prepare', key);
    },
    run(key) {
      if (key === 'caller') barrier();
      jobs.push(key);
      return hold('run', key);
    },
  });

  await flush();
  while (gates.length) {
    gates.shift()();
    await flush();
  }
  const results = await pending;

  assert.equal(maximum, 2);
  assert.ok(mixed);
  assert.equal(active, 0);
  assert.equal(preparations.length, 4);
  assert.equal(new Set(preparations.map(m => JSON.stringify(m))).size, 4);
  assert.equal(jobs.length, 5);
  assert.equal(new Set(jobs).size, 5);
  assert.equal(results.find(r => r.key === 'a').reason, failure);
  assert.deepEqual(results.map(r => r.key),
    ['a', 'b', 'caller', 'iso1', 'iso2']);
  assert.equal(JSON.stringify({ symbolKeys, edges }), before);
});
