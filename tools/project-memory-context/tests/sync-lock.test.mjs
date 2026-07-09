import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, readFile } from 'node:fs/promises';

import { SyncLock, SYNC_LOCK_STALE_MS } from '../src/sync-lock.mjs';

let counter = 0;
function tmp(label) {
  return join(tmpdir(), `pmc-sync-lock-test-${++counter}-${label}`);
}

test('SyncLock acquires when no lock file exists', async () => {
  const dir = tmp('acquire-empty');
  await mkdir(dir, { recursive: true });
  const lockFilePath = join(dir, 'sync.lock');

  const lock = new SyncLock(lockFilePath);
  const acquired = await lock.acquire(100);

  assert.equal(acquired, true);

  // Check state on disk
  const content = await readFile(lockFilePath, 'utf8');
  const data = JSON.parse(content);
  assert.equal(data.pid, 100);
  assert.ok(data.startedAt);
  assert.equal(data.heartbeatAt, data.startedAt);

  await rm(dir, { recursive: true, force: true });
});

test('SyncLock skips acquisition when existing lock is alive and fresh', async () => {
  const dir = tmp('skip-live');
  await mkdir(dir, { recursive: true });
  const lockFilePath = join(dir, 'sync.lock');

  // Pre-seed a fresh lock file
  const baseTime = Date.now();
  const lockData = {
    pid: 999,
    startedAt: new Date(baseTime - 1000).toISOString(),
    heartbeatAt: new Date(baseTime - 1000).toISOString(),
  };

  const lock = new SyncLock(lockFilePath, {
    isPidAlive: (pid) => pid === 999,
    now: () => baseTime,
  });

  // Write pre-seeded lock
  await lock.writeLockAtomically(lockData);

  const acquired = await lock.acquire(100);
  assert.equal(acquired, false);

  // Lock file on disk should remain untouched
  const content = await readFile(lockFilePath, 'utf8');
  const data = JSON.parse(content);
  assert.equal(data.pid, 999);

  await rm(dir, { recursive: true, force: true });
});

test('SyncLock takes over when PID is dead', async () => {
  const dir = tmp('takeover-dead');
  await mkdir(dir, { recursive: true });
  const lockFilePath = join(dir, 'sync.lock');

  const baseTime = Date.now();
  const lockData = {
    pid: 999,
    startedAt: new Date(baseTime - 1000).toISOString(),
    heartbeatAt: new Date(baseTime - 1000).toISOString(),
  };

  const lock = new SyncLock(lockFilePath, {
    isPidAlive: (pid) => false, // Dead process!
    now: () => baseTime,
  });

  await lock.writeLockAtomically(lockData);

  const acquired = await lock.acquire(100);
  assert.equal(acquired, true);

  // Lock file on disk should be updated to pid 100
  const content = await readFile(lockFilePath, 'utf8');
  const data = JSON.parse(content);
  assert.equal(data.pid, 100);

  await rm(dir, { recursive: true, force: true });
});

test('SyncLock takes over when heartbeat is stale', async () => {
  const dir = tmp('takeover-stale');
  await mkdir(dir, { recursive: true });
  const lockFilePath = join(dir, 'sync.lock');

  const baseTime = Date.now();
  const lockData = {
    pid: 999,
    startedAt: new Date(baseTime - SYNC_LOCK_STALE_MS - 1000).toISOString(),
    heartbeatAt: new Date(baseTime - SYNC_LOCK_STALE_MS - 1000).toISOString(), // Stale!
  };

  const lock = new SyncLock(lockFilePath, {
    isPidAlive: (pid) => true, // Still alive but heartbeat is stale
    now: () => baseTime,
  });

  await lock.writeLockAtomically(lockData);

  const acquired = await lock.acquire(100);
  assert.equal(acquired, true);

  // Lock file on disk should be updated to pid 100
  const content = await readFile(lockFilePath, 'utf8');
  const data = JSON.parse(content);
  assert.equal(data.pid, 100);

  await rm(dir, { recursive: true, force: true });
});

test('SyncLock release deletes the file', async () => {
  const dir = tmp('release');
  await mkdir(dir, { recursive: true });
  const lockFilePath = join(dir, 'sync.lock');

  const lock = new SyncLock(lockFilePath);
  await lock.acquire(100);

  await lock.release();

  // File should not exist
  await assert.rejects(readFile(lockFilePath, 'utf8'));

  await rm(dir, { recursive: true, force: true });
});
