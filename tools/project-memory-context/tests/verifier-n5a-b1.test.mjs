import test from 'node:test';
import assert from 'node:assert/strict';
import { computeNarrativeHash, hashFile } from '../src/hash.mjs';

const base = {
  code: 'return 1;',
  signature: 'f()',
  calleeSummaryHashes: {},
  promptVersion: 'v2',
};

test('S11 B1 sorted own keys survive at root and nested array without mutation or pollution', async () => {
  const beforePrototype = Object.getOwnPropertyDescriptors(Object.prototype);
  for (const [raw, canonical, empty] of [
    [
      '{"z":1,"__proto__":{"role":"service"},"a":2}',
      '{"__proto__":{"role":"service"},"a":2,"z":1}',
      { a: 2, z: 1 },
    ],
    [
      '{"z":[{"z":1,"__proto__":{"role":"service"},"a":2}]}',
      '{"z":[{"__proto__":{"role":"service"},"a":2,"z":1}]}',
      { z: [{ a: 2, z: 1 }] },
    ],
  ]) {
    const role = JSON.parse(raw);
    const before = JSON.stringify(role);
    const expected = await hashFile(JSON.stringify([
      base.code, base.signature, JSON.parse(canonical), [], base.promptVersion,
    ]));
    const actual = await computeNarrativeHash({ ...base, role });
    assert.equal(actual, expected);
    assert.notEqual(actual, await computeNarrativeHash({ ...base, role: empty }));
    assert.equal(JSON.stringify(role), before);
    assert.equal(actual, await computeNarrativeHash({ ...base, role: JSON.parse(canonical) }));
  }
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), beforePrototype);
});

test('S11 B1 correction preserves ordinary literal hash', async () => {
  assert.equal(await computeNarrativeHash({
    code: 'return b();',
    signature: 'a(x)',
    role: { role: 'extractor', layer: 'core', confidence: 0.8, evidence: ['suffix'] },
    calleeSummaryHashes: { 'k|b|0': 'c1' },
    promptVersion: 'v2',
  }), '1ef00ad89b212f33');
});
