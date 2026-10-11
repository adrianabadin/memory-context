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

test('computeFileHashes skips .planning, .worktrees, graphify-out, and .graphify_*.json', async () => {
  await mkdir(TMP, { recursive: true });
  await mkdir(join(TMP, 'src'), { recursive: true });
  await writeFile(join(TMP, 'src', 'app.ts'), 'const x = 1;');
  await mkdir(join(TMP, '.worktrees', 'wt'), { recursive: true });
  await writeFile(join(TMP, '.worktrees', 'wt', 'leak.ts'), 'const x = 2;');
  await mkdir(join(TMP, '.opencode'), { recursive: true });
  await writeFile(join(TMP, '.opencode', 'plugin.ts'), 'const x = 2.5;');
  await mkdir(join(TMP, '.planning'), { recursive: true });
  await writeFile(join(TMP, '.planning', 'plan.ts'), 'const x = 3;');
  await mkdir(join(TMP, 'graphify-out'), { recursive: true });
  await writeFile(join(TMP, 'graphify-out', 'out.ts'), 'const x = 4;');
  await writeFile(join(TMP, '.graphify_custom.ts'), 'const x = 5;');

  const hashes = await computeFileHashes(TMP);
  assert.deepEqual(Object.keys(hashes), ['src/app.ts']);

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
