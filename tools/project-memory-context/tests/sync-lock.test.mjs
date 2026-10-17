import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, readFile, readdir, writeFile, utimes } from 'node:fs/promises';

import { SyncLock, SYNC_LOCK_STALE_MS } from '../src/sync-lock.mjs';

let counter = 0;
function tmp(label) {
  return join(tmpdir(), `pmc-sync-lock-test-${++counter}-${label}`);
}

// Pre-clean so litter from a previously failed run cannot pollute assertions.
async function freshDir(label) {
  const dir = tmp(label);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

async function seedLock(lockFilePath, data) {
  await writeFile(lockFilePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

test('SyncLock acquires when no lock file exists and cleans up its guard', async () => {
  const dir = await freshDir('acquire-empty');
  const lockFilePath = join(dir, 'sync.lock');

  const lock = new SyncLock(lockFilePath);
  const acquired = await lock.acquire(100);

  assert.equal(acquired, true);

  const content = await readFile(lockFilePath, 'utf8');
  const data = JSON.parse(content);
  assert.equal(data.pid, 100);
  assert.ok(data.startedAt);
  assert.equal(data.heartbeatAt, data.startedAt);
  assert.ok(data.token);

  // The transition guard is short-lived and must not linger after success.
  const entries = await readdir(dir);
  assert.ok(!entries.includes('sync.lock.guard'));

  await rm(dir, { recursive: true, force: true });
});

test('SyncLock skips acquisition when existing lock is alive and fresh', async () => {
  const dir = await freshDir('skip-live');
  const lockFilePath = join(dir, 'sync.lock');

  const baseTime = Date.now();
  await seedLock(lockFilePath, {
    pid: 999,
    startedAt: new Date(baseTime - 1000).toISOString(),
    heartbeatAt: new Date(baseTime - 1000).toISOString(),
    token: 'other-token',
  });

  const lock = new SyncLock(lockFilePath, {
    isPidAlive: (pid) => pid === 999,
    now: () => baseTime,
  });

  const acquired = await lock.acquire(100);
  assert.equal(acquired, false);

  const data = JSON.parse(await readFile(lockFilePath, 'utf8'));
  assert.equal(data.pid, 999);

  await rm(dir, { recursive: true, force: true });
});

test('SyncLock takes over when PID is dead', async () => {
  const dir = await freshDir('takeover-dead');
  const lockFilePath = join(dir, 'sync.lock');

  const baseTime = Date.now();
  await seedLock(lockFilePath, {
    pid: 999,
    startedAt: new Date(baseTime - 1000).toISOString(),
    heartbeatAt: new Date(baseTime - 1000).toISOString(),
    token: 'dead-token',
  });

  const lock = new SyncLock(lockFilePath, {
    isPidAlive: () => false,
    now: () => baseTime,
  });

  const acquired = await lock.acquire(100);
  assert.equal(acquired, true);

  const data = JSON.parse(await readFile(lockFilePath, 'utf8'));
  assert.equal(data.pid, 100);

  await rm(dir, { recursive: true, force: true });
});

test('SyncLock does not steal a live owner with a stale heartbeat', async () => {
  const dir = await freshDir('no-steal-live-stale');
  const lockFilePath = join(dir, 'sync.lock');

  const baseTime = Date.now();
  await seedLock(lockFilePath, {
    pid: 999,
    startedAt: new Date(baseTime - SYNC_LOCK_STALE_MS - 1000).toISOString(),
    heartbeatAt: new Date(baseTime - SYNC_LOCK_STALE_MS - 1000).toISOString(),
    token: 'slow-token',
  });

  const lock = new SyncLock(lockFilePath, {
    isPidAlive: (pid) => pid === 999,
    now: () => baseTime,
  });

  const acquired = await lock.acquire(100);
  assert.equal(acquired, false);

  const data = JSON.parse(await readFile(lockFilePath, 'utf8'));
  assert.equal(data.pid, 999);

  await rm(dir, { recursive: true, force: true });
});

test('SyncLock holds for a distinct same-PID instance instead of evicting it', async () => {
  const dir = await freshDir('same-pid-hold');
  const lockFilePath = join(dir, 'sync.lock');

  const baseTime = Date.now();
  await seedLock(lockFilePath, {
    pid: 100,
    startedAt: new Date(baseTime - 1000).toISOString(),
    heartbeatAt: new Date(baseTime - 1000).toISOString(),
    token: 'instance-a',
  });

  const lock = new SyncLock(lockFilePath, {
    isPidAlive: () => true,
    now: () => baseTime,
  });

  const acquired = await lock.acquire(100);
  assert.equal(acquired, false);

  const data = JSON.parse(await readFile(lockFilePath, 'utf8'));
  assert.equal(data.token, 'instance-a');

  await rm(dir, { recursive: true, force: true });
});

test('SyncLock self reacquisition is idempotent when the token matches', async () => {
  const dir = await freshDir('self-reacquire');
  const lockFilePath = join(dir, 'sync.lock');

  const lock = new SyncLock(lockFilePath);
  assert.equal(await lock.acquire(100), true);
  const first = await readFile(lockFilePath, 'utf8');

  assert.equal(await lock.acquire(100), true);
  const second = await readFile(lockFilePath, 'utf8');

  assert.equal(second, first);

  await rm(dir, { recursive: true, force: true });
});

test('SyncLock heartbeat refreshes the owners own lock', async () => {
  const dir = await freshDir('heartbeat-own');
  const lockFilePath = join(dir, 'sync.lock');

  let t = Date.now();
  const lock = new SyncLock(lockFilePath, { now: () => t });
  assert.equal(await lock.acquire(100), true);
  const token = JSON.parse(await readFile(lockFilePath, 'utf8')).token;

  t += 1000;
  assert.equal(await lock.heartbeat(), true);

  const data = JSON.parse(await readFile(lockFilePath, 'utf8'));
  assert.equal(data.pid, 100);
  assert.equal(data.token, token);
  assert.equal(data.heartbeatAt, new Date(t).toISOString());

  await rm(dir, { recursive: true, force: true });
});

test('SyncLock old owner cannot heartbeat or release over a new owners lock', async () => {
  const dir = await freshDir('old-owner');
  const lockFilePath = join(dir, 'sync.lock');

  const baseTime = Date.now();
  const lockA = new SyncLock(lockFilePath, {
    isPidAlive: (pid) => pid === 200,
    now: () => baseTime,
  });
  assert.equal(await lockA.acquire(100), true);

  const lockB = new SyncLock(lockFilePath, {
    isPidAlive: (pid) => pid === 200,
    now: () => baseTime,
  });
  assert.equal(await lockB.acquire(200), true);

  assert.equal(await lockA.heartbeat(), false);
  let data = JSON.parse(await readFile(lockFilePath, 'utf8'));
  assert.equal(data.pid, 200);

  assert.equal(await lockA.release(), false);
  data = JSON.parse(await readFile(lockFilePath, 'utf8'));
  assert.equal(data.pid, 200);

  assert.equal(await lockB.release(), true);
  await assert.rejects(readFile(lockFilePath, 'utf8'));

  await rm(dir, { recursive: true, force: true });
});

test('SyncLock refuses to reclaim a recent corrupt lock', async () => {
  const dir = await freshDir('corrupt-hold');
  const lockFilePath = join(dir, 'sync.lock');

  const truncated = '{"pid": 999, "heart';
  await writeFile(lockFilePath, truncated, 'utf8');

  const lock = new SyncLock(lockFilePath);
  const acquired = await lock.acquire(100);
  assert.equal(acquired, false);

  assert.equal(await readFile(lockFilePath, 'utf8'), truncated);

  await rm(dir, { recursive: true, force: true });
});

test('SyncLock recovers an ancient corrupt lock', async () => {
  const dir = await freshDir('corrupt-reclaim');
  const lockFilePath = join(dir, 'sync.lock');

  await writeFile(lockFilePath, 'garbage', 'utf8');
  const baseTime = Date.now();
  const old = new Date(baseTime - SYNC_LOCK_STALE_MS - 1000);
  await utimes(lockFilePath, old, old);

  const lock = new SyncLock(lockFilePath, { now: () => baseTime });
  const acquired = await lock.acquire(100);
  assert.equal(acquired, true);

  const data = JSON.parse(await readFile(lockFilePath, 'utf8'));
  assert.equal(data.pid, 100);

  await rm(dir, { recursive: true, force: true });
});

test('SyncLock allows exactly one of two simultaneous acquisitions', async () => {
  const dir = await freshDir('simultaneous');
  const lockFilePath = join(dir, 'sync.lock');

  const alive = (pid) => pid === 100 || pid === 200;
  const lockA = new SyncLock(lockFilePath, { isPidAlive: alive });
  const lockB = new SyncLock(lockFilePath, { isPidAlive: alive });

  const [gotA, gotB] = await Promise.all([lockA.acquire(100), lockB.acquire(200)]);

  assert.equal([gotA, gotB].filter(Boolean).length, 1);
  const winner = gotA ? 100 : 200;
  const data = JSON.parse(await readFile(lockFilePath, 'utf8'));
  assert.equal(data.pid, winner);

  await rm(dir, { recursive: true, force: true });
});

test('SyncLock allows exactly one winner when contenders race to reclaim a dead lock', async () => {
  const dir = await freshDir('race-reclaim');
  const lockFilePath = join(dir, 'sync.lock');

  const baseTime = Date.now();
  await seedLock(lockFilePath, {
    pid: 999,
    startedAt: new Date(baseTime - 1000).toISOString(),
    heartbeatAt: new Date(baseTime - 1000).toISOString(),
    token: 'dead-token',
  });

  const alive = (pid) => pid === 200 || pid === 300;
  const lockA = new SyncLock(lockFilePath, { isPidAlive: alive, now: () => baseTime });
  const lockB = new SyncLock(lockFilePath, { isPidAlive: alive, now: () => baseTime });

  const [gotA, gotB] = await Promise.all([lockA.acquire(200), lockB.acquire(300)]);

  assert.equal([gotA, gotB].filter(Boolean).length, 1);
  const winner = gotA ? 200 : 300;
  const data = JSON.parse(await readFile(lockFilePath, 'utf8'));
  assert.equal(data.pid, winner);

  await rm(dir, { recursive: true, force: true });
});

test('SyncLock fails closed when the transition guard is orphaned', async () => {
  const dir = await freshDir('orphan-guard');
  const lockFilePath = join(dir, 'sync.lock');
  await mkdir(`${lockFilePath}.guard`, { recursive: true });

  const lock = new SyncLock(lockFilePath, { guardMaxAttempts: 2, guardDelayMs: 5 });
  await assert.rejects(
    () => lock.acquire(100),
    (err) => /transition guard is held/.test(err.message) && err.message.includes('sync.lock.guard')
  );

  // No auto-steal: the orphaned guard stays for manual recovery and the main
  // lock must not have been created behind the failed transition.
  const entries = await readdir(dir);
  assert.ok(entries.includes('sync.lock.guard'));
  assert.ok(!entries.includes('sync.lock'));

  await rm(dir, { recursive: true, force: true });
});

test('SyncLock.isOwner verifies ownership read-only without touching the lock file', async () => {
  const dir = await freshDir('isowner-own');
  const lockFilePath = join(dir, 'sync.lock');

  const lock = new SyncLock(lockFilePath);
  assert.equal(await lock.acquire(100), true);
  const before = await readFile(lockFilePath, 'utf8');

  assert.equal(await lock.isOwner(), true);

  // The probe is strictly read-only: identical bytes, no guard leftovers.
  const after = await readFile(lockFilePath, 'utf8');
  assert.equal(after, before);
  const entries = await readdir(dir);
  assert.ok(!entries.includes('sync.lock.guard'));

  await rm(dir, { recursive: true, force: true });
});

test('SyncLock.isOwner reports false for superseded, removed, corrupt, or unclaimed locks', async () => {
  const dir = await freshDir('isowner-states');
  const lockFilePath = join(dir, 'sync.lock');
  const baseTime = Date.now();

  // Superseded: a second instance reclaims the dead owner's lock.
  const lockA = new SyncLock(lockFilePath, { isPidAlive: () => false, now: () => baseTime });
  assert.equal(await lockA.acquire(100), true);
  const lockB = new SyncLock(lockFilePath, { isPidAlive: () => false, now: () => baseTime });
  assert.equal(await lockB.acquire(200), true);
  assert.equal(await lockA.isOwner(), false);
  assert.equal(await lockB.isOwner(), true);

  // Record removed under us.
  await rm(lockFilePath, { force: true });
  assert.equal(await lockB.isOwner(), false);

  // Corrupt record: the token can never verify.
  await writeFile(lockFilePath, '{"pid": 200, "tok', 'utf8');
  assert.equal(await lockB.isOwner(), false);

  // Never acquired: nothing to verify.
  assert.equal(await new SyncLock(lockFilePath).isOwner(), false);

  await rm(dir, { recursive: true, force: true });
});

test('SyncLock.isOwner propagates non-ENOENT read errors so callers can fail closed', async () => {
  const dir = await freshDir('isowner-eio');
  const lockFilePath = join(dir, 'sync.lock');

  let failReads = false;
  const lock = new SyncLock(lockFilePath, {
    readFile: async (path, encoding) => {
      if (failReads) {
        const err = new Error(`EIO: unreadable ${path}`);
        err.code = 'EIO';
        throw err;
      }
      return readFile(path, encoding);
    },
  });
  assert.equal(await lock.acquire(100), true);

  failReads = true;
  await assert.rejects(() => lock.isOwner(), /EIO/);

  // The failed probe must not have modified the lock.
  const data = JSON.parse(await readFile(lockFilePath, 'utf8'));
  assert.equal(data.pid, 100);

  await rm(dir, { recursive: true, force: true });
});
