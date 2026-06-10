import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  WATCH_HEARTBEAT_INTERVAL_MS,
  WATCH_HEARTBEAT_STALE_MS,
  getWatchPidPath,
  isPidAlive,
  isWatcherAlive,
  readWatchPidRecord,
  removeWatchPidFile,
  writeWatchPidRecord,
} from '../src/watcher-lifecycle.mjs';

async function makeTempRoot() {
  return mkdtemp(join(tmpdir(), 'pmc-watch-lifecycle-'));
}

test('getWatchPidPath points inside .planning state dir', async () => {
  const root = await makeTempRoot();
  assert.equal(
    getWatchPidPath(root),
    join(root, '.planning', 'project-memory-context', 'state', 'watch.pid'),
  );
  await rm(root, { recursive: true, force: true });
});

test('writeWatchPidRecord + readWatchPidRecord round-trip', async () => {
  const root = await makeTempRoot();
  const record = {
    pid: 4242,
    projectRoot: resolve(root),
    startedAt: '2026-06-09T10:00:00.000Z',
    lastHeartbeat: '2026-06-09T10:05:00.000Z',
  };
  await writeWatchPidRecord(root, record);
  assert.deepEqual(await readWatchPidRecord(root), record);
  await rm(root, { recursive: true, force: true });
});

test('readWatchPidRecord returns null on missing or corrupt file', async () => {
  const root = await makeTempRoot();
  assert.equal(await readWatchPidRecord(root), null);
  await writeWatchPidRecord(root, { pid: 1, projectRoot: root, startedAt: 'x', lastHeartbeat: 'x' });
  // Corrupt it manually
  const { writeFile } = await import('node:fs/promises');
  await writeFile(getWatchPidPath(root), 'not-json', 'utf8');
  assert.equal(await readWatchPidRecord(root), null);
  await rm(root, { recursive: true, force: true });
});

test('removeWatchPidFile is idempotent', async () => {
  const root = await makeTempRoot();
  await removeWatchPidFile(root); // no file: must not throw
  await writeWatchPidRecord(root, { pid: 1, projectRoot: root, startedAt: 'x', lastHeartbeat: 'x' });
  await removeWatchPidFile(root);
  assert.equal(existsSync(getWatchPidPath(root)), false);
  await rm(root, { recursive: true, force: true });
});

test('isPidAlive: own pid alive, absurd pid dead, garbage input dead', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(999999999), false);
  assert.equal(isPidAlive(null), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(0), false);
});

test('isWatcherAlive: alive only when pid alive AND projectRoot matches AND heartbeat fresh', async () => {
  const root = await makeTempRoot();
  const nowMs = Date.parse('2026-06-09T10:00:00.000Z');
  const fresh = new Date(nowMs - 10_000).toISOString();
  const stale = new Date(nowMs - WATCH_HEARTBEAT_STALE_MS - 1).toISOString();
  const base = { pid: 4242, projectRoot: resolve(root), startedAt: fresh, lastHeartbeat: fresh };
  const aliveDeps = { now: nowMs, isPidAlive: () => true };

  assert.equal(isWatcherAlive(base, root, aliveDeps), true);
  // pid dead
  assert.equal(isWatcherAlive(base, root, { now: nowMs, isPidAlive: () => false }), false);
  // projectRoot mismatch (PID reuse by another project's watcher)
  assert.equal(isWatcherAlive({ ...base, projectRoot: join(root, 'other') }, root, aliveDeps), false);
  // heartbeat stale (hung watcher)
  assert.equal(isWatcherAlive({ ...base, lastHeartbeat: stale }, root, aliveDeps), false);
  // missing record
  assert.equal(isWatcherAlive(null, root, aliveDeps), false);
  // missing heartbeat field
  assert.equal(isWatcherAlive({ ...base, lastHeartbeat: undefined }, root, aliveDeps), false);
  await rm(root, { recursive: true, force: true });
});

test('heartbeat constants: 30s interval, 90s staleness (3x)', () => {
  assert.equal(WATCH_HEARTBEAT_INTERVAL_MS, 30_000);
  assert.equal(WATCH_HEARTBEAT_STALE_MS, 90_000);
});
