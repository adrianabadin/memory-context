import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSymbolDelta } from '../src/symbol-delta.mjs';
import { HASH_VERSION } from '../src/hash.mjs';

test('computeSymbolDelta identifies new, stale, removed, and unchanged symbols', () => {
  const currentSymbols = [
    { symbolKey: 'js_src_app_mjs_function_exported_handleRequest_2', filePath: 'src/app.mjs', codeHash: 'h1', hashVersion: HASH_VERSION },
    { symbolKey: 'js_src_app_mjs_function_exported_parseInput_1', filePath: 'src/app.mjs', codeHash: 'h2_new', hashVersion: HASH_VERSION },
    { symbolKey: 'js_src_utils_mjs_function_exported_format_1', filePath: 'src/utils.mjs', codeHash: 'h3', hashVersion: HASH_VERSION },
  ];

  const existingWorklist = [
    { symbolKey: 'js_src_app_mjs_function_exported_handleRequest_2', filePath: 'src/app.mjs', codeHash: 'h1', hashVersion: HASH_VERSION, status: 'enriched', memoryId: 'mem-1' },
    { symbolKey: 'js_src_app_mjs_function_exported_parseInput_1', filePath: 'src/app.mjs', codeHash: 'h2_old', hashVersion: HASH_VERSION, status: 'enriched', memoryId: 'mem-2' },
    { symbolKey: 'js_src_removed_mjs_function_exported_oldFunc_1', filePath: 'src/removed.mjs', codeHash: 'h4', hashVersion: HASH_VERSION, status: 'enriched', memoryId: 'mem-3' },
  ];

  const delta = computeSymbolDelta(currentSymbols, existingWorklist);

  assert.equal(delta.new.length, 1);
  assert.equal(delta.new[0].symbolKey, 'js_src_utils_mjs_function_exported_format_1');
  assert.equal(delta.new[0].status, 'pending');

  assert.equal(delta.stale.length, 1);
  assert.equal(delta.stale[0].symbolKey, 'js_src_app_mjs_function_exported_parseInput_1');
  assert.equal(delta.stale[0].staleReason, 'code-hash-changed');
  assert.equal(delta.stale[0].memoryId, 'mem-2');

  assert.equal(delta.removed.length, 1);
  assert.equal(delta.removed[0].symbolKey, 'js_src_removed_mjs_function_exported_oldFunc_1');

  assert.equal(delta.unchanged.length, 1);
  assert.equal(delta.unchanged[0].symbolKey, 'js_src_app_mjs_function_exported_handleRequest_2');
  assert.equal(delta.unchanged[0].memoryId, 'mem-1');
});

test('computeSymbolDelta returns empty deltas for empty inputs', () => {
  const delta = computeSymbolDelta([], []);
  assert.equal(delta.new.length, 0);
  assert.equal(delta.stale.length, 0);
  assert.equal(delta.removed.length, 0);
  assert.equal(delta.unchanged.length, 0);
});

// ── legacy preservation controls (no current narrativeHash) ────────
// N5A must keep the old codeHash/hashVersion behavior byte-for-byte when
// the current symbol does not opt in, even when the stored entry already
// carries a narrativeHash from earlier runs.

test('existing narrativeHash without a current one never forces staleness (legacy unchanged)', () => {
  const currentSymbols = [
    { symbolKey: 'js_src_app_mjs_function_exported_handleRequest_2', filePath: 'src/app.mjs', codeHash: 'h1', hashVersion: HASH_VERSION },
  ];
  const existingWorklist = [
    {
      symbolKey: 'js_src_app_mjs_function_exported_handleRequest_2',
      filePath: 'src/app.mjs',
      codeHash: 'h1',
      hashVersion: HASH_VERSION,
      status: 'enriched',
      memoryId: 'mem-1',
      narrativeHash: 'old-narrative-hash',
    },
  ];

  const delta = computeSymbolDelta(currentSymbols, existingWorklist);

  assert.equal(delta.stale.length, 0);
  assert.equal(delta.unchanged.length, 1);
  assert.equal(delta.unchanged[0].status, 'enriched', 'accepted status must survive legacy unchanged');
  assert.equal(delta.unchanged[0].memoryId, 'mem-1');
  assert.deepEqual(Object.keys(delta.unchanged[0]).sort(), ['codeHash', 'filePath', 'hashVersion', 'memoryId', 'narrativeHash', 'status', 'symbolKey', 'verifiedAt']);
});

test('hashVersion migration stays a silent baseline when only the stored entry has narrativeHash', () => {
  const currentSymbols = [
    { symbolKey: 'js_src_foo_mjs_function_exported_foo_0', filePath: 'src/foo.mjs', codeHash: 'newxxh3hash', hashVersion: HASH_VERSION },
  ];
  const existingWorklist = [
    {
      symbolKey: 'js_src_foo_mjs_function_exported_foo_0',
      filePath: 'src/foo.mjs',
      codeHash: 'oldsha1hash',
      hashVersion: 'sha1-old',
      status: 'enriched',
      memoryId: 'mem-9',
      narrativeHash: 'old-narrative-hash',
    },
  ];

  const delta = computeSymbolDelta(currentSymbols, existingWorklist);

  assert.equal(delta.stale.length, 0, 'migration must not become stale through stored-only narrativeHash');
  assert.equal(delta.unchanged.length, 1);
  assert.equal(delta.unchanged[0].codeHash, 'newxxh3hash');
  assert.equal(delta.unchanged[0].hashVersion, HASH_VERSION);
  assert.equal(delta.unchanged[0].memoryId, 'mem-9');
});

test('current narrativeHash null keeps exact legacy codeHash semantics', () => {
  const currentSymbols = [
    { symbolKey: 'js_src_app_mjs_function_exported_handleRequest_2', filePath: 'src/app.mjs', codeHash: 'h1', hashVersion: HASH_VERSION, narrativeHash: null },
  ];
  const existingWorklist = [
    {
      symbolKey: 'js_src_app_mjs_function_exported_handleRequest_2',
      filePath: 'src/app.mjs',
      codeHash: 'h1',
      hashVersion: HASH_VERSION,
      status: 'enriched',
      memoryId: 'mem-1',
      narrativeHash: 'stored-hash-differs',
    },
  ];

  const delta = computeSymbolDelta(currentSymbols, existingWorklist);

  assert.equal(delta.stale.length, 0, 'null narrativeHash is not an opt-in');
  assert.equal(delta.unchanged.length, 1);
  assert.equal(delta.unchanged[0].memoryId, 'mem-1');
});

test('new symbols keep old pending semantics while carrying a current narrativeHash', () => {
  const currentSymbols = [
    {
      symbolKey: 'js_src_utils_mjs_function_exported_format_1',
      filePath: 'src/utils.mjs',
      codeHash: 'h3',
      hashVersion: HASH_VERSION,
      narrativeHash: 'fp-1',
    },
  ];

  const delta = computeSymbolDelta(currentSymbols, []);

  assert.equal(delta.new.length, 1);
  assert.equal(delta.new[0].status, 'pending');
  assert.equal(delta.new[0].memoryId, null);
  assert.equal(delta.new[0].graphNodeId, null);
  assert.equal(delta.new[0].hashVersion, HASH_VERSION);
  assert.equal(delta.new[0].narrativeHash, 'fp-1', 'current fingerprint flows through the new entry spread');
});

// ── opt-in narrativeHash invalidation (current symbol supplies hash) ─

test('current narrativeHash absent from the stored entry goes stale with narrative-hash-changed', () => {
  const currentSymbols = [
    { symbolKey: 'js_src_app_mjs_function_exported_parseInput_1', filePath: 'src/app.mjs', codeHash: 'h2_new', hashVersion: HASH_VERSION, narrativeHash: 'fp-new' },
  ];
  const existingWorklist = [
    {
      symbolKey: 'js_src_app_mjs_function_exported_parseInput_1',
      filePath: 'src/app.mjs',
      codeHash: 'h2_new',
      hashVersion: HASH_VERSION,
      status: 'enriched',
      memoryId: 'mem-2',
      graphNodeId: 'node-7',
    },
  ];

  const delta = computeSymbolDelta(currentSymbols, existingWorklist);

  assert.equal(delta.stale.length, 1);
  assert.equal(delta.unchanged.length, 0);
  assert.equal(delta.stale[0].staleReason, 'narrative-hash-changed');
  assert.equal(delta.stale[0].status, 'stale');
  assert.equal(delta.stale[0].memoryId, 'mem-2', 'accepted memoryId must be retained');
  assert.equal(delta.stale[0].graphNodeId, 'node-7', 'accepted graphNodeId must be retained');
  assert.equal(delta.stale[0].codeHash, 'h2_new', 'current fields must be present on the stale entry');
  assert.equal(delta.stale[0].narrativeHash, 'fp-new');
});

test('changed narrativeHash goes stale even when codeHash matches', () => {
  const currentSymbols = [
    { symbolKey: 'js_src_app_mjs_function_exported_parseInput_1', filePath: 'src/app.mjs', codeHash: 'h2', hashVersion: HASH_VERSION, narrativeHash: 'fp-v2' },
  ];
  const existingWorklist = [
    {
      symbolKey: 'js_src_app_mjs_function_exported_parseInput_1',
      filePath: 'src/app.mjs',
      codeHash: 'h2',
      hashVersion: HASH_VERSION,
      status: 'enriched',
      memoryId: 'mem-2',
      graphNodeId: 'node-7',
      narrativeHash: 'fp-v1',
    },
  ];

  const delta = computeSymbolDelta(currentSymbols, existingWorklist);

  assert.equal(delta.stale.length, 1);
  assert.equal(delta.stale[0].staleReason, 'narrative-hash-changed');
  assert.equal(delta.stale[0].memoryId, 'mem-2');
  assert.equal(delta.stale[0].graphNodeId, 'node-7');
});

test('matching narrativeHash is unchanged carrying current fingerprint metadata without clobbering accepted fields', () => {
  const currentSymbols = [
    { symbolKey: 'js_src_app_mjs_function_exported_handleRequest_2', filePath: 'src/app.mjs', codeHash: 'h1-current', hashVersion: HASH_VERSION, narrativeHash: 'fp-same' },
  ];
  const existingWorklist = [
    {
      symbolKey: 'js_src_app_mjs_function_exported_handleRequest_2',
      filePath: 'src/app.mjs',
      codeHash: 'h1-stored',
      hashVersion: HASH_VERSION,
      status: 'enriched',
      memoryId: 'mem-1',
      graphNodeId: 'node-3',
      semanticSummary: 'kept summary',
      narrativeHash: 'fp-same',
    },
  ];

  const delta = computeSymbolDelta(currentSymbols, existingWorklist);

  assert.equal(delta.unchanged.length, 1);
  assert.equal(delta.stale.length, 0);
  assert.equal(delta.unchanged[0].codeHash, 'h1-current', 'current codeHash must be carried');
  assert.equal(delta.unchanged[0].hashVersion, HASH_VERSION);
  assert.equal(delta.unchanged[0].narrativeHash, 'fp-same');
  assert.equal(delta.unchanged[0].status, 'enriched', 'accepted status must not be clobbered');
  assert.equal(delta.unchanged[0].memoryId, 'mem-1');
  assert.equal(delta.unchanged[0].graphNodeId, 'node-3');
  assert.equal(delta.unchanged[0].semanticSummary, 'kept summary');
  assert.ok(typeof delta.unchanged[0].verifiedAt === 'string' && delta.unchanged[0].verifiedAt.length > 0);
});

test('hashVersion migration cannot mask an explicit current narrativeHash change', () => {
  const currentSymbols = [
    { symbolKey: 'js_src_foo_mjs_function_exported_foo_0', filePath: 'src/foo.mjs', codeHash: 'newxxh3hash', hashVersion: HASH_VERSION, narrativeHash: 'fp-current' },
  ];
  const existingWorklist = [
    {
      symbolKey: 'js_src_foo_mjs_function_exported_foo_0',
      filePath: 'src/foo.mjs',
      codeHash: 'oldsha1hash',
      hashVersion: 'sha1-old',
      status: 'enriched',
      memoryId: 'mem-5',
      narrativeHash: 'fp-old',
    },
  ];

  const delta = computeSymbolDelta(currentSymbols, existingWorklist);

  assert.equal(delta.stale.length, 1, 'explicit narrativeHash change must not be swallowed by silent migration');
  assert.equal(delta.unchanged.length, 0);
  assert.equal(delta.stale[0].staleReason, 'narrative-hash-changed');
  assert.equal(delta.stale[0].memoryId, 'mem-5');
  assert.equal(delta.stale[0].hashVersion, HASH_VERSION);
});

test('matching narrativeHash across a hashVersion migration stays unchanged with refreshed hashVersion', () => {
  const currentSymbols = [
    { symbolKey: 'js_src_foo_mjs_function_exported_foo_0', filePath: 'src/foo.mjs', codeHash: 'newxxh3hash', hashVersion: HASH_VERSION, narrativeHash: 'fp-same' },
  ];
  const existingWorklist = [
    {
      symbolKey: 'js_src_foo_mjs_function_exported_foo_0',
      filePath: 'src/foo.mjs',
      codeHash: 'oldsha1hash',
      hashVersion: 'sha1-old',
      status: 'enriched',
      memoryId: 'mem-5',
      narrativeHash: 'fp-same',
    },
  ];

  const delta = computeSymbolDelta(currentSymbols, existingWorklist);

  assert.equal(delta.unchanged.length, 1);
  assert.equal(delta.stale.length, 0);
  assert.equal(delta.unchanged[0].codeHash, 'newxxh3hash');
  assert.equal(delta.unchanged[0].hashVersion, HASH_VERSION);
  assert.equal(delta.unchanged[0].narrativeHash, 'fp-same');
  assert.equal(delta.unchanged[0].memoryId, 'mem-5');
});

test('matching narrativeHash with a differing stored codeHash is unchanged carrying the current codeHash', () => {
  const currentSymbols = [
    { symbolKey: 'js_src_app_mjs_function_exported_handleRequest_2', filePath: 'src/app.mjs', codeHash: 'h1-current', hashVersion: HASH_VERSION, narrativeHash: 'fp-same' },
  ];
  const existingWorklist = [
    {
      symbolKey: 'js_src_app_mjs_function_exported_handleRequest_2',
      filePath: 'src/app.mjs',
      codeHash: 'h1-stored-metadata-drift',
      hashVersion: HASH_VERSION,
      status: 'enriched',
      memoryId: 'mem-1',
      narrativeHash: 'fp-same',
    },
  ];

  const delta = computeSymbolDelta(currentSymbols, existingWorklist);

  assert.equal(delta.unchanged.length, 1, 'narrativeHash equality is authoritative in opt-in mode');
  assert.equal(delta.stale.length, 0);
  assert.equal(delta.unchanged[0].codeHash, 'h1-current');
});

test('malformed explicit current narrativeHash rejects with TypeError before any output', () => {
  const currentSymbols = [
    { symbolKey: 'js_src_app_mjs_function_exported_handleRequest_2', filePath: 'src/app.mjs', codeHash: 'h1', hashVersion: HASH_VERSION, narrativeHash: '' },
    { symbolKey: 'js_src_app_mjs_function_exported_parseInput_1', filePath: 'src/app.mjs', codeHash: 'h2', hashVersion: HASH_VERSION, narrativeHash: 42 },
  ];
  const existingWorklist = [
    { symbolKey: 'js_src_app_mjs_function_exported_handleRequest_2', filePath: 'src/app.mjs', codeHash: 'h1', hashVersion: HASH_VERSION, status: 'enriched', memoryId: 'mem-1' },
  ];
  const currentSnapshot = structuredClone(currentSymbols);
  const existingSnapshot = structuredClone(existingWorklist);

  assert.throws(() => computeSymbolDelta(currentSymbols, existingWorklist), TypeError);
  assert.throws(() => computeSymbolDelta([currentSymbols[0]], []), (err) => err instanceof TypeError && /narrativeHash/.test(err.message));
  assert.deepEqual(currentSymbols, currentSnapshot, 'rejected call must not mutate current symbols');
  assert.deepEqual(existingWorklist, existingSnapshot, 'rejected call must not mutate the worklist');
});

test('computeSymbolDelta never mutates its inputs across mixed legacy and opt-in symbols', () => {
  const currentSymbols = [
    { symbolKey: 'js_src_app_mjs_function_exported_handleRequest_2', filePath: 'src/app.mjs', codeHash: 'h1', hashVersion: HASH_VERSION },
    { symbolKey: 'js_src_app_mjs_function_exported_parseInput_1', filePath: 'src/app.mjs', codeHash: 'h2_new', hashVersion: HASH_VERSION, narrativeHash: 'fp-new' },
    { symbolKey: 'js_src_utils_mjs_function_exported_format_1', filePath: 'src/utils.mjs', codeHash: 'h3', hashVersion: HASH_VERSION, narrativeHash: 'fp-brand-new' },
  ];
  const existingWorklist = [
    { symbolKey: 'js_src_app_mjs_function_exported_handleRequest_2', filePath: 'src/app.mjs', codeHash: 'h1', hashVersion: HASH_VERSION, status: 'enriched', memoryId: 'mem-1' },
    { symbolKey: 'js_src_app_mjs_function_exported_parseInput_1', filePath: 'src/app.mjs', codeHash: 'h2_old', hashVersion: HASH_VERSION, status: 'enriched', memoryId: 'mem-2', narrativeHash: 'fp-old' },
    { symbolKey: 'js_src_removed_mjs_function_exported_oldFunc_1', filePath: 'src/removed.mjs', codeHash: 'h4', hashVersion: HASH_VERSION, status: 'enriched', memoryId: 'mem-3' },
  ];
  const currentSnapshot = structuredClone(currentSymbols);
  const existingSnapshot = structuredClone(existingWorklist);

  const delta = computeSymbolDelta(currentSymbols, existingWorklist);

  assert.equal(delta.unchanged.length, 1);
  assert.equal(delta.stale.length, 1);
  assert.equal(delta.stale[0].staleReason, 'narrative-hash-changed');
  assert.equal(delta.new.length, 1);
  assert.equal(delta.removed.length, 1);
  assert.deepEqual(currentSymbols, currentSnapshot);
  assert.deepEqual(existingWorklist, existingSnapshot);
});
