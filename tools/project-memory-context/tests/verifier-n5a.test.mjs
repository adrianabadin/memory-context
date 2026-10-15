import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as hash from '../src/hash.mjs';
import { computeSymbolDelta as delta } from '../src/symbol-delta.mjs';

const input = () => ({ code: 'return 1;', signature: 'f()', role: { role: 'service', evidence: [] }, calleeSummaryHashes: {}, promptVersion: 'v2' });
const sym = (extras = {}) => ({ symbolKey: 'js|src/a.js|function|f|f()', codeHash: 'code', ...extras });
const stored = (extras = {}) => sym({ status: 'done', memoryId: 17, graphNodeId: 'node', hashVersion: hash.HASH_VERSION, summary: 'accepted', ...extras });
const digest = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

test('S11 five inputs, boundaries, exact text and excluded callers', async () => {
  const x = input(), before = JSON.stringify(x), h = await hash.computeNarrativeHash(x);
  for (const patch of [{ code: 'return 2;' }, { signature: null }, { role: null }, { calleeSummaryHashes: { callee: 'h' } }, { promptVersion: 'v3' }]) assert.notEqual(await hash.computeNarrativeHash({ ...x, ...patch }), h);
  assert.equal(await hash.computeNarrativeHash({ ...x, callers: [{ code: 'edited' }], codeHash: 'ignored', graphNodeId: 'ignored', hashVersion: 'ignored' }), h);
  assert.notEqual(await hash.computeNarrativeHash({ ...x, code: 'ab', signature: 'c' }), await hash.computeNarrativeHash({ ...x, code: 'a', signature: 'bc' }));
  assert.equal(JSON.stringify(x), before);
  const values = await Promise.all(['', ' ', 'x', 'x\n', 'x\r\n'].map(async (text) => (await hash.hashCalleeSummaries({ callee: text })).callee));
  assert.equal(new Set(values).size, 5);
  const summaries = await hash.hashCalleeSummaries({ callee: 'Stable summary' });
  const caller = await hash.computeNarrativeHash({ ...x, calleeSummaryHashes: summaries });
  assert.equal(await hash.computeNarrativeHash({ ...x, calleeSummaryHashes: await hash.hashCalleeSummaries([{ symbolKey: 'callee', summaryText: 'Stable summary', code: 'new code', narrative: { behavior: ['new'] } }]) }), caller);
  assert.notEqual(await hash.computeNarrativeHash({ ...x, calleeSummaryHashes: await hash.hashCalleeSummaries({ callee: 'Changed summary' }) }), caller);
});

test('S11 canonical role and pair order, duplicate equivalence, immutable inputs', async () => {
  const x = { ...input(), role: { z: [{ b: 2, a: 1 }], a: true }, calleeSummaryHashes: [{ symbolKey: 'b', hash: '2' }, { symbolKey: 'a', hash: '1' }, { symbolKey: 'a', hash: '1' }] };
  const before = JSON.stringify(x);
  assert.equal(await hash.computeNarrativeHash(x), await hash.computeNarrativeHash({ ...input(), role: { a: true, z: [{ a: 1, b: 2 }] }, calleeSummaryHashes: { a: '1', b: '2' } }));
  assert.equal(JSON.stringify(x), before);
  assert.deepEqual(await hash.hashCalleeSummaries([{ symbolKey: 'a', summaryText: '' }, { symbolKey: 'a', summaryText: '' }]), await hash.hashCalleeSummaries({ a: '' }));
});

test('S11 JSON role own __proto__ key remains fingerprint content', async () => {
  const role = JSON.parse('{"__proto__":{"role":"service"}}');
  const before = JSON.stringify(role);
  assert.notEqual(await hash.computeNarrativeHash({ ...input(), role }), await hash.computeNarrativeHash({ ...input(), role: {} }));
  assert.equal(JSON.stringify(role), before);
});

test('S11 explicit opt-in delta, migration precedence and accepted fields', () => {
  const current = sym({ narrativeHash: 'now' });
  for (const prior of [stored(), stored({ narrativeHash: 'old' }), stored({ narrativeHash: 'old', hashVersion: 'old' })]) {
    const result = delta([current], [prior]);
    assert.deepEqual(result, { new: [], stale: [{ ...current, status: 'stale', staleReason: 'narrative-hash-changed', memoryId: 17, graphNodeId: 'node', hashVersion: hash.HASH_VERSION }], removed: [], unchanged: [] });
  }
  const prior = stored({ narrativeHash: 'now', codeHash: 'old', hashVersion: 'old' }), result = delta([current], [prior]);
  assert.equal(result.unchanged.length, 1);
  const { verifiedAt, ...accepted } = result.unchanged[0];
  assert.ok(Number.isFinite(Date.parse(verifiedAt)));
  assert.deepEqual(accepted, { ...prior, codeHash: 'code', hashVersion: hash.HASH_VERSION });
  assert.deepEqual(delta([current], []).new, [{ ...current, status: 'pending', memoryId: null, graphNodeId: null, hashVersion: hash.HASH_VERSION }]);
  assert.deepEqual(delta([], [prior]).removed, [prior]);
});

test('S11 rejected calls preserve isolated serialized inputs byte-for-byte', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'n5a-rejected-')), file = join(dir, 'data.json');
  try {
    const run = async (data, fn, message) => {
      const bytes = JSON.stringify(data); writeFileSync(file, bytes); const before = digest(file);
      await assert.rejects(async () => fn(), { name: 'TypeError', message });
      assert.equal(digest(file), before); assert.equal(JSON.stringify(data), bytes);
    };
    for (const value of ['', 0, false, {}, []]) {
      const data = [[sym({ narrativeHash: value })], [stored()]];
      await run(data, () => delta(...data), `narrativeHash must be a non-empty string when supplied for '${sym().symbolKey}'`);
    }
    const pairs = [{ symbolKey: 'callee', hash: 'a' }, { symbolKey: 'callee', hash: 'b' }];
    await run(pairs, () => hash.computeNarrativeHash({ ...input(), calleeSummaryHashes: pairs }), "conflicting duplicate callee hash for 'callee'");
    const summaries = [{ symbolKey: 'callee', summaryText: '' }, { symbolKey: 'callee', summaryText: 'b' }];
    await run(summaries, () => hash.hashCalleeSummaries(summaries), "conflicting duplicate callee summaryText for 'callee'");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S11 legacy full-output and existing hash engine baseline parity', { skip: !process.env.N5A_BASELINE }, async () => {
  const base = process.env.N5A_BASELINE;
  const oldHash = await import(pathToFileURL(join(base, 'tools/project-memory-context/src/hash.mjs')));
  const { computeSymbolDelta: oldDelta } = await import(pathToFileURL(join(base, 'tools/project-memory-context/src/symbol-delta.mjs')));
  assert.equal(hash.HASH_VERSION, oldHash.HASH_VERSION);
  for (const text of ['', ' ', 'return 1;', '\u00e9\n\u03bb', 'x\r\n']) {
    assert.equal(await hash.hashFile(text), await oldHash.hashFile(text));
    for (const signature of ['', 'f()', null]) assert.equal(await hash.hashSymbol(text, signature), await oldHash.hashSymbol(text, signature));
  }
  const RealDate = globalThis.Date;
  globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2026-10-14T00:00:00.000Z'])); } };
  try {
    for (const optout of [{}, { narrativeHash: null }, { narrativeHash: undefined }]) for (const oldNarrative of [{}, { narrativeHash: 'stored-only' }]) for (const version of [hash.HASH_VERSION, 'old']) for (const codeHash of ['code', 'changed']) for (const graphNodeId of ['node', null, undefined]) {
      const current = [sym({ ...optout, codeHash }), sym({ symbolKey: 'new', ...optout })];
      const existing = [stored({ ...oldNarrative, hashVersion: version, graphNodeId }), stored({ symbolKey: 'removed', ...oldNarrative })];
      const before = JSON.stringify([current, existing]);
      assert.deepEqual(delta(current, existing), oldDelta(current, existing));
      assert.equal(JSON.stringify([current, existing]), before);
    }
  } finally { globalThis.Date = RealDate; }
});
