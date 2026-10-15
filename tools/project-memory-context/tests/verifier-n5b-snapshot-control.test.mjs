import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotNarrativeContext } from '../src/cards/narrative-cache.mjs';

test('S11 B1 independent owned snapshot preserves Set keys, nested role and caller mutability', () => {
  const key = 'js|src/a.js|function|exported|a|1';
  const input = {
    symbolKeys: new Set([key]),
    signature: 'a(x)',
    role: { evidence: [{ value: 'before' }] },
    callees: [{ key, summary: 'before' }],
  };
  const expected = structuredClone(input);
  const owned = snapshotNarrativeContext(input);
  assert.deepEqual(input, expected);
  assert.deepEqual(owned, expected);
  assert.notEqual(owned.symbolKeys, input.symbolKeys);
  assert.notEqual(owned.role.evidence[0], input.role.evidence[0]);
  for (const value of [input, input.role, input.role.evidence, input.callees, input.callees[0]]) {
    assert.equal(Object.isFrozen(value), false);
  }
  input.symbolKeys.clear();
  input.signature = 'a(changed)';
  input.role.evidence[0].value = 'after';
  input.callees[0].summary = 'after';
  assert.deepEqual(owned, expected);
  owned.callees[0].summary = 'owned edit';
  assert.equal(input.callees[0].summary, 'after');
});
