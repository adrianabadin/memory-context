import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSymbolDelta } from '../src/symbol-delta.mjs';

test('computeSymbolDelta identifies new, stale, removed, and unchanged symbols', () => {
  const currentSymbols = [
    { symbolKey: 'js_src_app_mjs_function_exported_handleRequest_2', filePath: 'src/app.mjs', codeHash: 'h1' },
    { symbolKey: 'js_src_app_mjs_function_exported_parseInput_1', filePath: 'src/app.mjs', codeHash: 'h2_new' },
    { symbolKey: 'js_src_utils_mjs_function_exported_format_1', filePath: 'src/utils.mjs', codeHash: 'h3' },
  ];

  const existingWorklist = [
    { symbolKey: 'js_src_app_mjs_function_exported_handleRequest_2', filePath: 'src/app.mjs', codeHash: 'h1', status: 'enriched', memoryId: 'mem-1' },
    { symbolKey: 'js_src_app_mjs_function_exported_parseInput_1', filePath: 'src/app.mjs', codeHash: 'h2_old', status: 'enriched', memoryId: 'mem-2' },
    { symbolKey: 'js_src_removed_mjs_function_exported_oldFunc_1', filePath: 'src/removed.mjs', codeHash: 'h4', status: 'enriched', memoryId: 'mem-3' },
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
