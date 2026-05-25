import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';

import {
  computeFileHashes,
  loadHashStore,
  saveHashStore,
  detectChangedFiles,
} from '../src/file-hash-store.mjs';

const TMP = join(process.env.TEMP || '/tmp', 'pmc-hash-store-test');

test('computeFileHashes hashes tracked source files', async () => {
  await mkdir(TMP, { recursive: true });
  await writeFile(join(TMP, 'app.ts'), 'const x = 1;');
  await writeFile(join(TMP, 'util.js'), 'export function add(a, b) { return a + b; }');
  await writeFile(join(TMP, 'ignore.txt'), 'not tracked');

  const hashes = await computeFileHashes(TMP);
  assert.ok(hashes['app.ts']);
  assert.ok(hashes['util.js']);
  assert.equal(hashes['ignore.txt'], undefined);

  await rm(TMP, { recursive: true });
});

test('detectChangedFiles finds new, modified, and removed files', async () => {
  const previous = { 'a.ts': 'hash1', 'b.ts': 'hash2', 'c.ts': 'hash3' };
  const current = { 'a.ts': 'hash1', 'b.ts': 'hash2_changed', 'd.ts': 'hash4' };

  const delta = detectChangedFiles(previous, current);
  assert.deepEqual(delta.added, ['d.ts']);
  assert.deepEqual(delta.modified, ['b.ts']);
  assert.deepEqual(delta.removed, ['c.ts']);
  assert.deepEqual(delta.unchanged, ['a.ts']);
});

test('saveHashStore and loadHashStore round-trip', async () => {
  await mkdir(TMP, { recursive: true });
  const storePath = join(TMP, 'hash-store.json');
  const hashes = { 'app.ts': 'abc123', 'util.js': 'def456' };

  await saveHashStore(storePath, hashes);
  const loaded = await loadHashStore(storePath);

  assert.deepEqual(loaded, hashes);
  await rm(TMP, { recursive: true });
});
