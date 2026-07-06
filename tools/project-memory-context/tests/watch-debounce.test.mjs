// tools/project-memory-context/tests/watch-debounce.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  WATCH_QUIET_MS,
  getWatchPendingPath,
  partitionQuiet,
  readWatchPending,
  recordChange,
  writeWatchPending,
} from '../src/watch-debounce.mjs';

test('WATCH_QUIET_MS is 5 minutes', () => {
  assert.equal(WATCH_QUIET_MS, 5 * 60 * 1000);
});

test('recordChange adds and updates timestamps immutably', () => {
  const p1 = recordChange({}, 'src/a.mjs', 1000);
  const p2 = recordChange(p1, 'src/b.mjs', 2000);
  const p3 = recordChange(p2, 'src/a.mjs', 3000);
  assert.deepEqual(p1, { 'src/a.mjs': 1000 });
  assert.deepEqual(p3, { 'src/a.mjs': 3000, 'src/b.mjs': 2000 });
  // immutability
  assert.deepEqual(p2, { 'src/a.mjs': 1000, 'src/b.mjs': 2000 });
});

test('partitionQuiet separates files quiet >= quietMs from hot files', () => {
  const now = 10 * 60 * 1000; // t=10min
  const pending = {
    'src/quiet.mjs': now - WATCH_QUIET_MS,       // exactly 5min quiet → quiet
    'src/older.mjs': now - WATCH_QUIET_MS - 1,   // >5min quiet → quiet
    'src/hot.mjs': now - 1000,                   // 1s ago → hot
  };
  const { quiet, hot } = partitionQuiet(pending, now);
  assert.deepEqual(
    quiet.sort((a, b) => a[0].localeCompare(b[0])),
    [['src/older.mjs', now - WATCH_QUIET_MS - 1], ['src/quiet.mjs', now - WATCH_QUIET_MS]],
  );
  assert.deepEqual(hot, { 'src/hot.mjs': now - 1000 });
});

test('partitionQuiet with empty pending returns empty results', () => {
  const { quiet, hot } = partitionQuiet({}, 12345);
  assert.deepEqual(quiet, []);
  assert.deepEqual(hot, {});
});

test('writeWatchPending + readWatchPending round-trip; read tolerates missing/corrupt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-watch-debounce-'));
  assert.deepEqual(await readWatchPending(root), {});
  await writeWatchPending(root, { 'src/a.mjs': 111 });
  assert.deepEqual(await readWatchPending(root), { 'src/a.mjs': 111 });
  await writeFile(getWatchPendingPath(root), '{broken', 'utf8');
  assert.deepEqual(await readWatchPending(root), {});
  await rm(root, { recursive: true, force: true });
});

test('writeWatchPending leaves no temp file behind (atomic rename)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-watch-debounce-'));
  await writeWatchPending(root, { 'src/a.mjs': 1 });
  assert.equal(existsSync(`${getWatchPendingPath(root)}.tmp`), false);
  assert.deepEqual(await readWatchPending(root), { 'src/a.mjs': 1 });
  await rm(root, { recursive: true, force: true });
});

// Windows race: mkdir resolves but dir is not yet visible for rename on first attempt.
// writeWatchPending must retry mkdir+rename once on ENOENT from rename.
test('writeWatchPending retries mkdir+rename on ENOENT (Windows race simulation)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-watch-debounce-'));
  let mkdirCalls = 0;
  let renameCalls = 0;

  // mkdir succeeds every time
  const mkdirImpl = async (p, opts) => {
    mkdirCalls++;
    const { mkdir: realMkdir } = await import('node:fs/promises');
    return realMkdir(p, opts);
  };

  // rename fails ENOENT on first call, succeeds on second
  const renameImpl = async (src, dst) => {
    renameCalls++;
    if (renameCalls === 1) {
      const err = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      throw err;
    }
    const { rename: realRename } = await import('node:fs/promises');
    return realRename(src, dst);
  };

  await writeWatchPending(root, { 'src/a.mjs': 99 }, { mkdir: mkdirImpl, rename: renameImpl });

  assert.ok(renameCalls >= 2, `rename should be called at least twice; was ${renameCalls}`);
  assert.ok(mkdirCalls >= 2, `mkdir should be called at least twice on retry; was ${mkdirCalls}`);
  assert.deepEqual(await readWatchPending(root), { 'src/a.mjs': 99 });
  await rm(root, { recursive: true, force: true });
});
