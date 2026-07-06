// tools/project-memory-context/tests/watch-runtime.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { createWatchRuntime } from '../cli/watch.mjs';
import { readWatchPidRecord } from '../src/watcher-lifecycle.mjs';
import { readWatchPending } from '../src/watch-debounce.mjs';

const QUIET = 5 * 60 * 1000;

async function makeRuntime({ nowMs, refreshCalls }) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-watch-runtime-'));
  const clock = { value: nowMs };
  const runtime = createWatchRuntime({
    projectRoot,
    startedAt: new Date(nowMs).toISOString(),
    deps: {
      now: () => clock.value,
      pid: 7777,
      refreshContext: async (root, options) => {
        refreshCalls.push({ root, options });
      },
    },
  });
  return { projectRoot, clock, runtime };
}

test('onFsEvent records watched files and persists pending; ignores unwatched', async () => {
  const refreshCalls = [];
  const { projectRoot, runtime } = await makeRuntime({ nowMs: 1_000_000, refreshCalls });

  await runtime.onFsEvent('src/foo.mjs');
  await runtime.onFsEvent('node_modules/x/y.mjs'); // ignored by shouldWatch
  await runtime.onFsEvent('README.txt');            // not a watched extension
  await runtime.onFsEvent(null);                    // fs.watch can emit null

  assert.deepEqual(runtime.getPending(), { 'src/foo.mjs': 1_000_000 });
  assert.deepEqual(await readWatchPending(projectRoot), { 'src/foo.mjs': 1_000_000 });
  await rm(projectRoot, { recursive: true, force: true });
});

test('tick writes heartbeat to pid record even with nothing pending', async () => {
  const refreshCalls = [];
  const { projectRoot, clock, runtime } = await makeRuntime({ nowMs: 1_000_000, refreshCalls });

  const result = await runtime.tick();
  assert.equal(result.refreshed, false);

  const record = await readWatchPidRecord(projectRoot);
  assert.equal(record.pid, 7777);
  assert.equal(resolve(record.projectRoot), resolve(projectRoot));
  assert.equal(record.lastHeartbeat, new Date(clock.value).toISOString());
  assert.equal(refreshCalls.length, 0);
  await rm(projectRoot, { recursive: true, force: true });
});

test('tick triggers refresh only when a pending file has been quiet >= 5min', async () => {
  const refreshCalls = [];
  const { projectRoot, clock, runtime } = await makeRuntime({ nowMs: 1_000_000, refreshCalls });

  await runtime.onFsEvent('src/foo.mjs'); // changed at t=1,000,000
  clock.value += QUIET - 1;
  assert.equal((await runtime.tick()).refreshed, false); // 1ms early

  clock.value += 1;
  const result = await runtime.tick();
  assert.equal(result.refreshed, true);
  assert.equal(refreshCalls.length, 1);
  assert.deepEqual(refreshCalls[0].options, { enrich: true });
  // quiet file consumed
  assert.deepEqual(runtime.getPending(), {});
  assert.deepEqual(await readWatchPending(projectRoot), {});
  await rm(projectRoot, { recursive: true, force: true });
});

test('hot file does not block quiet file, stays pending for next cycle', async () => {
  const refreshCalls = [];
  const { projectRoot, clock, runtime } = await makeRuntime({ nowMs: 1_000_000, refreshCalls });

  await runtime.onFsEvent('src/quiet.mjs');
  clock.value += QUIET - 30_000;
  await runtime.onFsEvent('src/hot.mjs'); // touched 30s before quiet.mjs matures
  clock.value += 30_000;

  const result = await runtime.tick();
  assert.equal(result.refreshed, true);
  // hot.mjs survives, quiet.mjs consumed
  assert.deepEqual(Object.keys(runtime.getPending()), ['src/hot.mjs']);
  await rm(projectRoot, { recursive: true, force: true });
});

test('file re-modified while refresh runs is NOT consumed', async () => {
  const refreshCalls = [];
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-watch-runtime-'));
  const clock = { value: 1_000_000 };
  let runtimeRef;
  const runtime = createWatchRuntime({
    projectRoot,
    startedAt: new Date(clock.value).toISOString(),
    deps: {
      now: () => clock.value,
      pid: 7777,
      refreshContext: async () => {
        // Simulate a re-modification arriving mid-refresh
        clock.value += 1000;
        await runtimeRef.onFsEvent('src/foo.mjs');
      },
    },
  });
  runtimeRef = runtime;

  await runtime.onFsEvent('src/foo.mjs');
  clock.value += QUIET;
  const result = await runtime.tick();
  assert.equal(result.refreshed, true);
  // foo.mjs was re-touched during refresh → must remain pending with new timestamp
  assert.deepEqual(Object.keys(runtime.getPending()), ['src/foo.mjs']);
  await rm(projectRoot, { recursive: true, force: true });
});

test('tick never overlaps refreshes and refresh errors keep pending intact', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-watch-runtime-'));
  const clock = { value: 1_000_000 };
  let resolveRefresh;
  let calls = 0;
  const runtime = createWatchRuntime({
    projectRoot,
    startedAt: new Date(clock.value).toISOString(),
    deps: {
      now: () => clock.value,
      pid: 7777,
      refreshContext: () => {
        calls += 1;
        return new Promise((res) => { resolveRefresh = res; });
      },
    },
  });

  await runtime.onFsEvent('src/foo.mjs');
  clock.value += QUIET;
  const first = runtime.tick();           // starts refresh, stays in-flight
  const second = await runtime.tick();    // must skip: refresh in progress
  assert.equal(second.refreshed, false);
  assert.equal(calls, 1);
  resolveRefresh();
  await first;

  // Error path: failing refresh leaves pending for retry on next tick
  const refreshCalls = [];
  const failing = createWatchRuntime({
    projectRoot,
    startedAt: new Date(clock.value).toISOString(),
    deps: {
      now: () => clock.value,
      pid: 7777,
      refreshContext: async () => { refreshCalls.push(1); throw new Error('boom'); },
    },
  });
  await failing.onFsEvent('src/bar.mjs');
  clock.value += QUIET;
  const result = await failing.tick();
  assert.equal(result.refreshed, false);
  assert.equal(refreshCalls.length, 1);
  assert.deepEqual(Object.keys(failing.getPending()), ['src/bar.mjs']);
  await rm(projectRoot, { recursive: true, force: true });
});

test('setPending seeds inherited pending from a previous run', async () => {
  const refreshCalls = [];
  const { projectRoot, clock, runtime } = await makeRuntime({ nowMs: 1_000_000, refreshCalls });
  runtime.setPending({ 'src/old.mjs': 1_000_000 - QUIET });
  const result = await runtime.tick();
  assert.equal(result.refreshed, true);
  assert.equal(refreshCalls.length, 1);
  await rm(projectRoot, { recursive: true, force: true });
});
