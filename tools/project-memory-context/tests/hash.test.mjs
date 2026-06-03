import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';

import { hashSymbol, hashFile, HASH_VERSION } from '../src/hash.mjs';
import { loadHashStore, saveHashStore } from '../src/file-hash-store.mjs';
import { computeSymbolDelta } from '../src/symbol-delta.mjs';

// ── hashSymbol ──────────────────────────────────────────────────────

test('hashSymbol returns a non-empty string', async () => {
  const result = await hashSymbol('abc');
  assert.ok(typeof result === 'string');
  assert.ok(result.length > 0);
});

test('hashSymbol is deterministic', async () => {
  const a = await hashSymbol('abc');
  const b = await hashSymbol('abc');
  assert.equal(a, b);
});

test('hashSymbol produces different hashes for different inputs', async () => {
  const a = await hashSymbol('abc');
  const b = await hashSymbol('def');
  assert.notEqual(a, b);
});

// ── hashFile ────────────────────────────────────────────────────────

test('hashFile differentiates content', async () => {
  const a = await hashFile('abc');
  const b = await hashFile('');
  assert.notEqual(a, b);
});

// ── HASH_VERSION ────────────────────────────────────────────────────

test('HASH_VERSION is xxh3-1', () => {
  assert.equal(HASH_VERSION, 'xxh3-1');
});

// ── loadHashStore version gate ──────────────────────────────────────

const TMP = join(process.env.TEMP || '/tmp', 'pmc-hash-test-' + Date.now());

test('loadHashStore with different hashVersion returns {}', async () => {
  await mkdir(TMP, { recursive: true });
  const storePath = join(TMP, 'hash-store.json');
  await writeFile(storePath, JSON.stringify({
    hashVersion: 'sha256-1',
    hashes: { 'app.ts': 'oldhash' },
    updatedAt: new Date().toISOString(),
  }), 'utf-8');

  const result = await loadHashStore(storePath);
  assert.deepEqual(result, {});

  await rm(TMP, { recursive: true, force: true });
});

test('loadHashStore with matching hashVersion returns hashes', async () => {
  await mkdir(TMP, { recursive: true });
  const storePath = join(TMP, 'hash-store.json');
  const hashes = { 'app.ts': 'somehash' };
  await saveHashStore(storePath, hashes);

  const result = await loadHashStore(storePath);
  assert.deepEqual(result, hashes);

  await rm(TMP, { recursive: true, force: true });
});

// ── computeSymbolDelta hashVersion gate ────────────────────────────

test('computeSymbolDelta: symbol with different hashVersion goes to unchanged (silent re-hash)', () => {
  const currentSymbols = [
    { symbolKey: 'js_src_foo_mjs_function_exported_foo_0', filePath: 'src/foo.mjs', codeHash: 'newxxh3hash', hashVersion: HASH_VERSION },
  ];
  const existingWorklist = [
    { symbolKey: 'js_src_foo_mjs_function_exported_foo_0', filePath: 'src/foo.mjs', codeHash: 'oldsha1hash', hashVersion: 'sha1-old', status: 'enriched', memoryId: 'mem-1' },
  ];

  const delta = computeSymbolDelta(currentSymbols, existingWorklist);

  assert.equal(delta.stale.length, 0, 'should not be stale when hashVersion differs');
  assert.equal(delta.unchanged.length, 1, 'should be in unchanged (silent re-hash)');
  assert.equal(delta.unchanged[0].codeHash, 'newxxh3hash', 'codeHash should be updated to new XXH3 hash');
  assert.equal(delta.unchanged[0].hashVersion, HASH_VERSION, 'hashVersion should be updated');
});

test('computeSymbolDelta: matching hashVersion with different codeHash goes to stale', () => {
  const currentSymbols = [
    { symbolKey: 'js_src_bar_mjs_function_exported_bar_0', filePath: 'src/bar.mjs', codeHash: 'newxxh3hash', hashVersion: HASH_VERSION },
  ];
  const existingWorklist = [
    { symbolKey: 'js_src_bar_mjs_function_exported_bar_0', filePath: 'src/bar.mjs', codeHash: 'differentxxh3hash', hashVersion: HASH_VERSION, status: 'enriched', memoryId: 'mem-2' },
  ];

  const delta = computeSymbolDelta(currentSymbols, existingWorklist);

  assert.equal(delta.stale.length, 1, 'should be stale when same hashVersion but different codeHash');
  assert.equal(delta.stale[0].staleReason, 'code-hash-changed');
  assert.equal(delta.unchanged.length, 0);
});
