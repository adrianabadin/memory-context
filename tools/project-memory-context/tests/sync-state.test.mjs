import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, readFile } from 'node:fs/promises';

import {
  buildSyncState,
  writeSyncState,
  readSyncState,
  deriveSyncState,
} from '../src/sync-state.mjs';

let counter = 0;
function tmp(label) {
  return join(tmpdir(), `pmc-sync-state-test-${++counter}-${label}`);
}

test('buildSyncState shapes input correctly', () => {
  const input = {
    status: 'running',
    pid: 1234,
    startedAt: '2026-07-09T12:00:00.000Z',
    heartbeatAt: '2026-07-09T12:01:00.000Z',
    summary: { synced: 5, pending: 2 },
  };

  const state = buildSyncState(input);

  assert.deepEqual(state, {
    status: 'running',
    pid: 1234,
    startedAt: '2026-07-09T12:00:00.000Z',
    heartbeatAt: '2026-07-09T12:01:00.000Z',
    finishedAt: null,
    lastError: null,
    summary: {
      synced: 5,
      errors: 0,
      pending: 2,
    },
  });
});

test('writeSyncState writes atomically with temp file and rename', async () => {
  const dir = tmp('atomic');
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, 'sync-state.json');

  const mkdirCalls = [];
  const writeFileCalls = [];
  const renameCalls = [];

  const deps = {
    mkdir: async (p, opts) => { mkdirCalls.push({ p, opts }); return mkdir(p, opts); },
    writeFile: async (p, c, opts) => { writeFileCalls.push({ p, c, opts }); },
    rename: async (src, dst) => { renameCalls.push({ src, dst }); },
  };

  const state = {
    status: 'finished',
    pid: 100,
    startedAt: '2026-07-09T12:00:00.000Z',
    heartbeatAt: '2026-07-09T12:01:00.000Z',
  };

  await writeSyncState(filePath, state, deps);

  assert.equal(writeFileCalls.length, 1);
  assert.equal(writeFileCalls[0].p, `${filePath}.tmp`);
  assert.equal(renameCalls.length, 1);
  assert.equal(renameCalls[0].src, `${filePath}.tmp`);
  assert.equal(renameCalls[0].dst, filePath);

  await rm(dir, { recursive: true, force: true });
});

test('writeSyncState handles EPERM/EEXIST rename race with retry', async () => {
  const dir = tmp('race');
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, 'sync-state.json');

  let renameAttempts = 0;
  const deps = {
    mkdir: async () => {},
    writeFile: async () => {},
    rename: async (src, dst) => {
      renameAttempts++;
      if (renameAttempts === 1) {
        const err = new Error('EPERM: operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
    },
  };

  const state = {
    status: 'idle',
    pid: 200,
    startedAt: '2026-07-09T12:00:00.000Z',
    heartbeatAt: '2026-07-09T12:01:00.000Z',
  };

  await writeSyncState(filePath, state, deps);
  assert.equal(renameAttempts, 2);

  await rm(dir, { recursive: true, force: true });
});

test('readSyncState reads valid state and returns null on ENOENT', async () => {
  const dir = tmp('read');
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, 'sync-state.json');

  // Test ENOENT
  const state1 = await readSyncState(filePath);
  assert.equal(state1, null);

  // Test valid read
  const state = {
    status: 'running',
    pid: 300,
    startedAt: '2026-07-09T12:00:00.000Z',
    heartbeatAt: '2026-07-09T12:01:00.000Z',
  };
  await writeSyncState(filePath, state);

  const state2 = await readSyncState(filePath);
  assert.deepEqual(state2.status, 'running');
  assert.deepEqual(state2.pid, 300);

  await rm(dir, { recursive: true, force: true });
});

test('writeSyncState retries mkdir+rename on ENOENT during rename', async () => {
  const dir = tmp('enoent-rename');
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, 'sync-state.json');

  let mkdirCalls = 0;
  let renameAttempts = 0;

  const deps = {
    mkdir: async (p, opts) => { mkdirCalls++; return mkdir(p, opts); },
    writeFile: async () => {},
    rename: async (src, dst) => {
      renameAttempts++;
      if (renameAttempts === 1) {
        const err = new Error('ENOENT: no such file or directory');
        err.code = 'ENOENT';
        throw err;
      }
    },
  };

  const state = {
    status: 'finished',
    pid: 400,
  };

  await writeSyncState(filePath, state, deps);
  assert.equal(renameAttempts, 2);
  assert.ok(mkdirCalls >= 2);

  await rm(dir, { recursive: true, force: true });
});

test('deriveSyncState handles running, stalled, finished, failed and idle states', () => {
  const now = '2026-07-09T12:05:00.000Z';

  const state1 = deriveSyncState({
    status: 'running',
    pid: 123,
    startedAt: '2026-07-09T12:00:00.000Z',
    heartbeatAt: '2026-07-09T12:04:00.000Z',
    summary: { synced: 5, errors: 0, pending: 1 }
  }, now);
  assert.equal(state1.state, 'running');

  const state2 = deriveSyncState({
    status: 'running',
    pid: 123,
    startedAt: '2026-07-09T12:00:00.000Z',
    heartbeatAt: '2026-07-09T11:59:00.000Z',
  }, now);
  assert.equal(state2.state, 'stalled');

  const state3 = deriveSyncState({
    status: 'finished',
    pid: 123,
  }, now);
  assert.equal(state3.state, 'finished');

  const state4 = deriveSyncState({
    status: 'failed',
    pid: 123,
    lastError: 'some error',
  }, now);
  assert.equal(state4.state, 'failed');
  assert.equal(state4.runtime.lastError, 'some error');
});
