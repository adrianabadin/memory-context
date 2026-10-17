import test from 'node:test';
import assert from 'node:assert/strict';

import { computeNarrativeHash, hashCalleeSummaries, hashSymbol } from '../src/hash.mjs';

// N5A (F3.5 / S11): pure narrative fingerprint helpers.
// Formula (v3.md 48, verbatim): narrativeHash = h(code, signature, role,
// calleeSummaryHashes, promptVersion). Caller metadata, name, facts, graph
// node IDs and hash-version ambient metadata are deliberately not inputs.

const BASE_INPUTS = Object.freeze({
  code: 'export function a(x) {\n  return b(x);\n}\n',
  signature: 'a(x: number): number',
  role: { role: 'extractor', layer: 'core', confidence: 0.8, evidence: ['suffix'] },
  calleeSummaryHashes: { 'js|src/b.mjs|function|exported|b|0': 'c1' },
  promptVersion: 'v2',
});

// ── computeNarrativeHash ────────────────────────────────────────────

test('computeNarrativeHash is deterministic for identical inputs', async () => {
  const a = await computeNarrativeHash({ ...BASE_INPUTS });
  const b = await computeNarrativeHash({ ...BASE_INPUTS });
  assert.equal(a, b);
  assert.ok(typeof a === 'string' && a.length > 0);
});

test('every one of the five formula inputs changes the fingerprint', async () => {
  const base = await computeNarrativeHash({ ...BASE_INPUTS });
  const variants = [
    { ...BASE_INPUTS, code: BASE_INPUTS.code + '\n' },
    { ...BASE_INPUTS, signature: 'a(x: string): string' },
    { ...BASE_INPUTS, role: { ...BASE_INPUTS.role, layer: 'service' } },
    { ...BASE_INPUTS, calleeSummaryHashes: { 'js|src/b.mjs|function|exported|b|0': 'c2' } },
    { ...BASE_INPUTS, promptVersion: 'v3' },
  ];
  for (const variant of variants) {
    const hash = await computeNarrativeHash(variant);
    assert.notEqual(hash, base, `changed input must change the fingerprint: ${JSON.stringify(variant)}`);
  }
});

test('role object key insertion order does not change the fingerprint', async () => {
  const reorderedRole = { evidence: BASE_INPUTS.role.evidence, confidence: 0.8, role: 'extractor', layer: 'core' };
  const a = await computeNarrativeHash({ ...BASE_INPUTS });
  const b = await computeNarrativeHash({ ...BASE_INPUTS, role: reorderedRole });
  assert.equal(a, b);
});

test('callee hash pair order does not change the fingerprint', async () => {
  const pairs = [
    { symbolKey: 'js|src/b.mjs|function|exported|b|0', hash: 'c1' },
    { symbolKey: 'js|src/c.mjs|function|exported|c|0', hash: 'c2' },
  ];
  const a = await computeNarrativeHash({ ...BASE_INPUTS, calleeSummaryHashes: pairs });
  const b = await computeNarrativeHash({ ...BASE_INPUTS, calleeSummaryHashes: [pairs[1], pairs[0]] });
  assert.equal(a, b);
});

test('callee hash object map and pair array forms are equivalent', async () => {
  const map = { 'js|src/b.mjs|function|exported|b|0': 'c1', 'js|src/c.mjs|function|exported|c|0': 'c2' };
  const pairs = [
    { symbolKey: 'js|src/c.mjs|function|exported|c|0', hash: 'c2' },
    { symbolKey: 'js|src/b.mjs|function|exported|b|0', hash: 'c1' },
  ];
  const a = await computeNarrativeHash({ ...BASE_INPUTS, calleeSummaryHashes: map });
  const b = await computeNarrativeHash({ ...BASE_INPUTS, calleeSummaryHashes: pairs });
  assert.equal(a, b);
});

test('inputs are JSON-separated: concatenated boundary shifts change the fingerprint', async () => {
  const codeSignatureSplit = await computeNarrativeHash({ ...BASE_INPUTS, code: 'ab', signature: 'c' });
  const codeSignatureShifted = await computeNarrativeHash({ ...BASE_INPUTS, code: 'a', signature: 'bc' });
  assert.notEqual(codeSignatureSplit, codeSignatureShifted);

  const calleeBoundarySplit = await computeNarrativeHash({
    ...BASE_INPUTS,
    calleeSummaryHashes: [{ symbolKey: 'a', hash: 'bc' }],
  });
  const calleeBoundaryShifted = await computeNarrativeHash({
    ...BASE_INPUTS,
    calleeSummaryHashes: [{ symbolKey: 'ab', hash: 'c' }],
  });
  assert.notEqual(calleeBoundarySplit, calleeBoundaryShifted);
});

test('caller metadata and ambient symbol fields never affect the fingerprint', async () => {
  // The five S11 inputs are extracted by the caller; callers/facts/names/IDs
  // are not parameters of the formula, so symbol context changes are immune.
  const symbolA = {
    ...BASE_INPUTS,
    symbolKey: 'js|src/a.mjs|function|exported|a|0',
    callers: [{ name: 'main', role: 'cli-command' }],
    facts: { q1: 'unchanged-by-callers' },
    graphNodeId: 1,
    codeHash: 'h1',
  };
  const symbolB = {
    ...BASE_INPUTS,
    symbolKey: 'js|src/a.mjs|function|exported|a|0',
    callers: [{ name: 'other', role: 'mcp-tool' }],
    facts: { q1: 'still-unchanged' },
    graphNodeId: 99,
    codeHash: 'h2',
  };
  const extract = (s) => ({
    code: s.code,
    signature: s.signature,
    role: s.role,
    calleeSummaryHashes: s.calleeSummaryHashes,
    promptVersion: s.promptVersion,
  });
  const a = await computeNarrativeHash(extract(symbolA));
  const b = await computeNarrativeHash(extract(symbolB));
  assert.equal(a, b);
});

test('null signature is valid and differs from the empty-string signature', async () => {
  const nullSignature = await computeNarrativeHash({ ...BASE_INPUTS, signature: null });
  const emptySignature = await computeNarrativeHash({ ...BASE_INPUTS, signature: '' });
  assert.notEqual(nullSignature, emptySignature);
  assert.ok(typeof nullSignature === 'string' && nullSignature.length > 0);
});

test('null role is valid and differs from an object role', async () => {
  const nullRole = await computeNarrativeHash({ ...BASE_INPUTS, role: null });
  const objectRole = await computeNarrativeHash({ ...BASE_INPUTS });
  assert.notEqual(nullRole, objectRole);
});

// ── B1 regression: valid JSON role data with own __proto__ keys ─────

test('JSON role own __proto__ key is preserved as fingerprint content', async () => {
  const role = JSON.parse('{"__proto__":{"role":"service"}}');
  const before = JSON.stringify(role);
  const withProtoKey = await computeNarrativeHash({ ...BASE_INPUTS, role });
  const withEmptyRole = await computeNarrativeHash({ ...BASE_INPUTS, role: {} });
  assert.notEqual(withProtoKey, withEmptyRole, 'an own __proto__ key is valid JSON data and must affect the fingerprint');
  assert.equal(JSON.stringify(role), before, 'role input must not be mutated');
  assert.equal(Object.keys(role).length, 1, 'probe precondition: JSON.parse produces one own key');
});

test('JSON role own __proto__ key at a nested path is preserved as fingerprint content', async () => {
  const nested = JSON.parse('{"layer":{"__proto__":{"role":"service"}}}');
  const withNestedProtoKey = await computeNarrativeHash({ ...BASE_INPUTS, role: nested });
  const withNestedEmpty = await computeNarrativeHash({ ...BASE_INPUTS, role: { layer: {} } });
  assert.notEqual(withNestedProtoKey, withNestedEmpty, 'nested own __proto__ keys must also survive canonicalization');
});

test('ordinary fingerprint serialization is byte-stable across the canonicalization fix', async () => {
  // Literal captured from the pre-fix candidate (HEAD 3888b75 + N5A) for this
  // exact ordinary input; the B1 fix must not change ordinary serialized output.
  const ordinary = {
    code: 'return b();',
    signature: 'a(x)',
    role: { role: 'extractor', layer: 'core', confidence: 0.8, evidence: ['suffix'] },
    calleeSummaryHashes: { 'k|b|0': 'c1' },
    promptVersion: 'v2',
  };
  assert.equal(await computeNarrativeHash(ordinary), '1ef00ad89b212f33');
});

test('missing or malformed formula inputs reject with TypeError and leave inputs unchanged', async () => {
  const missingCode = { ...BASE_INPUTS };
  delete missingCode.code;
  await assert.rejects(() => computeNarrativeHash(missingCode), TypeError);

  await assert.rejects(() => computeNarrativeHash({ ...BASE_INPUTS, code: 42 }), TypeError);
  await assert.rejects(() => computeNarrativeHash({ ...BASE_INPUTS, signature: 42 }), TypeError);
  await assert.rejects(() => computeNarrativeHash({ ...BASE_INPUTS, promptVersion: '' }), TypeError);
  await assert.rejects(() => computeNarrativeHash({ ...BASE_INPUTS, promptVersion: 2 }), TypeError);
  await assert.rejects(
    () => computeNarrativeHash({ ...BASE_INPUTS, calleeSummaryHashes: [{ symbolKey: 'k', hash: '' }] }),
    TypeError,
  );
  await assert.rejects(
    () => computeNarrativeHash({ ...BASE_INPUTS, calleeSummaryHashes: [{ symbolKey: 'k', hash: 7 }] }),
    TypeError,
  );
  await assert.rejects(
    () => computeNarrativeHash({ ...BASE_INPUTS, calleeSummaryHashes: [{ symbolKey: '', hash: 'h' }] }),
    TypeError,
  );
  await assert.rejects(() => computeNarrativeHash({ ...BASE_INPUTS, role: { confidence: Number.NaN } }), TypeError);
  const circular = { role: 'extractor' };
  circular.self = circular;
  await assert.rejects(() => computeNarrativeHash({ ...BASE_INPUTS, role: circular }), TypeError);

  const untouched = { ...BASE_INPUTS, role: { ...BASE_INPUTS.role }, calleeSummaryHashes: { ...BASE_INPUTS.calleeSummaryHashes } };
  await computeNarrativeHash(untouched);
  assert.deepEqual(untouched, { ...BASE_INPUTS, role: { ...BASE_INPUTS.role }, calleeSummaryHashes: { ...BASE_INPUTS.calleeSummaryHashes } });
});

// ── hashCalleeSummaries ─────────────────────────────────────────────

test('callee summary hashes cover exact summary bytes including whitespace and empty text', async () => {
  const texts = ['x', ' x', 'x ', 'x\n', ''];
  const hashes = await Promise.all(texts.map((t) => hashCalleeSummaries({ 'js|src/b.mjs|function|exported|b|0': t })));
  const distinct = new Set(hashes.map((h) => h['js|src/b.mjs|function|exported|b|0']));
  assert.equal(distinct.size, texts.length, 'each distinct summary text must hash distinctly');
  for (const h of hashes) {
    assert.ok(typeof h['js|src/b.mjs|function|exported|b|0'] === 'string' && h['js|src/b.mjs|function|exported|b|0'].length > 0);
  }
});

test('callee summary hash output is sorted and input-order independent', async () => {
  const forward = [
    { symbolKey: 'js|src/a.mjs|function|exported|a|0', summaryText: 'sum-a' },
    { symbolKey: 'js|src/b.mjs|function|exported|b|0', summaryText: 'sum-b' },
  ];
  const reversed = [forward[1], forward[0]];
  const a = await hashCalleeSummaries(forward);
  const b = await hashCalleeSummaries(reversed);
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a), Object.keys(a).slice().sort(), 'output keys must be sorted for deterministic serialization');
});

test('identical duplicate callee entries collapse and conflicting duplicates reject', async () => {
  const key = 'js|src/b.mjs|function|exported|b|0';
  const collapsed = await hashCalleeSummaries([
    { symbolKey: key, summaryText: 'same text' },
    { symbolKey: key, summaryText: 'same text' },
  ]);
  assert.deepEqual(Object.keys(collapsed), [key]);

  const conflicting = [
    { symbolKey: key, summaryText: 'text one' },
    { symbolKey: key, summaryText: 'text two' },
  ];
  await assert.rejects(() => hashCalleeSummaries(conflicting), TypeError, 'conflicting duplicates must not silently pick an array winner');
});

test('callee summary text changes alter only the relevant hash pair', async () => {
  const keyA = 'js|src/a.mjs|function|exported|a|0';
  const keyB = 'js|src/b.mjs|function|exported|b|0';
  const before = await hashCalleeSummaries({ [keyA]: 'summary-a', [keyB]: 'summary-b' });
  const after = await hashCalleeSummaries({ [keyA]: 'summary-a', [keyB]: 'summary-b-changed' });
  assert.equal(after[keyA], before[keyA], 'unchanged summary text must keep its hash');
  assert.notEqual(after[keyB], before[keyB], 'changed summary text must change its hash');

  const fingerprintBefore = await computeNarrativeHash({ ...BASE_INPUTS, calleeSummaryHashes: before });
  const fingerprintAfter = await computeNarrativeHash({ ...BASE_INPUTS, calleeSummaryHashes: after });
  assert.notEqual(fingerprintAfter, fingerprintBefore);
});

test('callee summary hash results are stable plain hash-engine outputs', async () => {
  const pairs = await hashCalleeSummaries({ 'js|src/b.mjs|function|exported|b|0': 'abc' });
  assert.equal(pairs['js|src/b.mjs|function|exported|b|0'], await hashSymbol('abc'));
});

test('malformed callee summary inputs reject with TypeError and leave inputs unchanged', async () => {
  await assert.rejects(() => hashCalleeSummaries(null), TypeError);
  await assert.rejects(() => hashCalleeSummaries(undefined), TypeError);
  await assert.rejects(() => hashCalleeSummaries('text'), TypeError);
  await assert.rejects(() => hashCalleeSummaries({ key: 42 }), TypeError);
  await assert.rejects(() => hashCalleeSummaries([{ symbolKey: 'k' }]), TypeError);
  await assert.rejects(() => hashCalleeSummaries([{ summaryText: 't' }]), TypeError);
  await assert.rejects(() => hashCalleeSummaries(['not-a-pair']), TypeError);

  const input = { 'js|src/b.mjs|function|exported|b|0': 'summary text' };
  const snapshot = structuredClone(input);
  await hashCalleeSummaries(input);
  assert.deepEqual(input, snapshot, 'callee summary input must not be mutated');
});

test('empty callee summary input produces an empty hash map', async () => {
  assert.deepEqual(await hashCalleeSummaries({}), {});
  assert.deepEqual(await hashCalleeSummaries([]), {});
});
