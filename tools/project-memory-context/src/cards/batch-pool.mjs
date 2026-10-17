// Bounded, dependency-aware execution pool over the N2 leaf-first SCC batches.
// Pure scheduling only: caller-supplied callbacks are the sole side effect, and
// this module never touches timers, I/O, providers or shared state.

import { orderNarratives } from './order.mjs';

const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const ALLOWED_OPTIONS = ['symbolKeys', 'edges', 'concurrency', 'run', 'prepareBatch'];

export function runNarrativePool(options) {
  if (!object(options) || Object.keys(options).some((key) => !ALLOWED_OPTIONS.includes(key))) {
    throw new TypeError('Narrative pool accepts only symbolKeys, edges, concurrency, run and prepareBatch');
  }
  const { symbolKeys, edges = [], concurrency, run, prepareBatch } = options;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError('Narrative pool concurrency must be a positive finite integer');
  }
  if (typeof run !== 'function') throw new TypeError('Narrative pool requires a run callback function');
  if (prepareBatch !== undefined && typeof prepareBatch !== 'function') {
    throw new TypeError('Narrative pool prepareBatch must be a function when supplied');
  }
  // orderNarratives validates keys and canonical edge shapes before any dispatch.
  const batches = orderNarratives({ symbolKeys, edges });
  const batchOf = new Map();
  batches.forEach((members, index) => members.forEach((symbolKey) => batchOf.set(symbolKey, index)));

  // Mirror the planner's accepted edge reading (already validated above: calls
  // relations with coherent endpoints, in-graph keys only). This scan never
  // rejects and never re-decides which edges count; intra-SCC edges — cycles and
  // self calls — are dropped so a component can never wait on itself.
  const dependsOn = batches.map(() => new Set());
  const dependents = batches.map(() => []);
  for (const edge of edges) {
    if (edge.relation !== 'calls') continue;
    const caller = batchOf.get(edge.source.id);
    const callee = batchOf.get(edge.target.id);
    if (caller === undefined || callee === undefined || caller === callee) continue;
    if (dependsOn[caller].has(callee)) continue; // dedupe keeps one release per dependency
    dependsOn[caller].add(callee);
    dependents[callee].push(caller);
  }
  return execute(batches, dependsOn, dependents, { concurrency, run, prepareBatch });
}

function execute(batches, dependsOn, dependents, { concurrency, run, prepareBatch }) {
  const position = new Map();
  batches.forEach((members) => members.forEach((symbolKey) => position.set(symbolKey, position.size)));
  const total = position.size;
  if (total === 0) return Promise.resolve([]);

  const results = new Array(total);
  const remainingDeps = dependsOn.map((set) => set.size);
  const remainingMembers = batches.map((members) => members.length);
  // Per-SCC lifecycle: waiting -> queued -> preparing -> prepared -> completed
  // (preparing/prepared are skipped when no prepareBatch is supplied). Every
  // transition is guarded, so a batch is opened, prepared and dispatched exactly
  // once — including synchronous preparation-failure chains re-entering init.
  const phase = batches.map(() => 'waiting');
  // ONE work queue carries both preparation and run items: workers are the only
  // execution site, so preparation and run callbacks share the single global
  // bound of `concurrency` — there is never a second hidden preparation pool.
  const queue = [];
  const waiting = [];
  let settledBatches = 0;
  let drained = false;

  function wake() {
    while (waiting.length) waiting.shift()();
  }

  function openBatch(index) {
    if (phase[index] !== 'waiting') return; // duplicate-open guard (B2)
    phase[index] = 'queued';
    if (prepareBatch === undefined) {
      enqueueRuns(index);
      return;
    }
    queue.push({ type: 'prepare', batch: index });
    wake();
  }

  function enqueueRuns(index) {
    for (const symbolKey of batches[index]) {
      queue.push({ type: 'run', batch: index, symbolKey, index: position.get(symbolKey) });
    }
    wake();
  }

  function settleBatch(index) {
    if (phase[index] === 'completed') return;
    phase[index] = 'completed';
    settledBatches += 1;
    // A settled batch — fulfilled or failed — releases its callers; failure is
    // settlement, never validation, so no successor value is ever fabricated.
    // Readiness here only pushes queue items (iterative, B3): execution happens
    // exclusively in worker loops, so no synchronous chain can recurse (B3) or
    // run callbacks outside a bounded slot (B1).
    for (const caller of dependents[index]) {
      if (--remainingDeps[caller] === 0) openBatch(caller);
    }
    if (settledBatches === batches.length) {
      drained = true;
      wake();
    }
  }

  function record(batch, symbolKey, index, status, payload) {
    results[index] = status === 'fulfilled'
      ? { key: symbolKey, status, value: payload }
      : { key: symbolKey, status, reason: payload };
    if (--remainingMembers[batch] === 0) settleBatch(batch);
  }

  async function executeItem(item) {
    if (item.type === 'prepare') {
      phase[item.batch] = 'preparing';
      try {
        await prepareBatch(batches[item.batch].slice());
        phase[item.batch] = 'prepared';
        enqueueRuns(item.batch);
      } catch (error) {
        // Preparation failure settles every member with the original error
        // before releasing callers — never a fabricated fulfilment.
        for (const symbolKey of batches[item.batch]) {
          record(item.batch, symbolKey, position.get(symbolKey), 'rejected', error);
        }
      }
      return;
    }
    let status = 'fulfilled';
    let payload;
    try {
      payload = await run(item.symbolKey);
    } catch (error) {
      status = 'rejected';
      payload = error;
    }
    record(item.batch, item.symbolKey, item.index, status, payload);
  }

  async function worker() {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) {
        if (drained) return;
        await new Promise((resolve) => waiting.push(resolve));
        continue;
      }
      await executeItem(item);
    }
  }

  for (let index = 0; index < batches.length; index += 1) {
    if (remainingDeps[index] === 0) openBatch(index);
  }
  const workers = [];
  const limit = Math.min(concurrency, total);
  for (let slot = 0; slot < limit; slot += 1) workers.push(worker());

  return (async () => {
    // Workers exit only once every batch has settled, so every already-launched
    // preparation and run callback is awaited before the pool resolves.
    await Promise.all(workers);
    return results;
  })();
}
