// T-010 RED — Integration tests for the PMC plugin wiring capture hooks +
// session-start runtime + background drainer spawn. All four fail until
// plugin/index.mjs returns { hooks } and spawns capture-drain.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PMCPlugin } from '../plugin/index.mjs';

function makeTmpRoot(label) {
  const root = join(tmpdir(), `pmc-plugin-int-${label}-${process.pid}-${Date.now()}`);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}

function mockRunStartup() {
  const calls = [];
  const fn = async (projectRoot, opts) => {
    calls.push({ projectRoot, opts });
    return { hasPmc: false, projectRoot, warnings: [] };
  };
  fn.calls = calls;
  return fn;
}

function mockSpawn() {
  const calls = [];
  const fn = (command, args, options) => {
    calls.push({ command, args, options });
    return 99999;
  };
  fn.calls = calls;
  return fn;
}

function mockBuildHooks() {
  const calls = [];
  const fn = (sessionId, projectId, queuePath) => {
    calls.push({ sessionId, projectId, queuePath });
    return {
      'chat.message': () => {},
      'tool.execute.after': () => {},
    };
  };
  fn.calls = calls;
  return fn;
}

// Wait up to `timeoutMs` for `predicate()` to return truthy.
async function waitFor(predicate, timeoutMs = 2000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

// Test 1: PMCPlugin() returns { hooks: {...} } AND still runs session-start.
test('PMCPlugin() returns { hooks } with chat.message and tool.execute.after and runs session-start', async () => {
  const root = makeTmpRoot('t1');
  const runStartup = mockRunStartup();
  const spawn = mockSpawn();
  const buildHooks = mockBuildHooks();
  try {
    const result = await PMCPlugin({
      projectRoot: root,
      sessionId: 'sess-1',
      projectId: 'proj-1',
      __testOverrides: { runSessionStartRuntime: runStartup, spawnBackground: spawn, buildHooks },
    });
    assert.ok(result && typeof result === 'object', 'plugin must return an object');
    assert.ok(result.hooks, 'plugin must return a hooks object');
    assert.equal(typeof result.hooks['chat.message'], 'function');
    assert.equal(typeof result.hooks['tool.execute.after'], 'function');
    assert.equal(runStartup.calls.length, 1, 'runSessionStartRuntime must be called once');
    assert.equal(runStartup.calls[0].projectRoot, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Test 2: Plugin spawns capture-drain.mjs in background (detached, no block).
test('PMCPlugin() spawns capture-drain.mjs detached in the background', async () => {
  const root = makeTmpRoot('t2');
  const runStartup = mockRunStartup();
  const spawn = mockSpawn();
  const buildHooks = mockBuildHooks();
  try {
    await PMCPlugin({
      projectRoot: root,
      __testOverrides: { runSessionStartRuntime: runStartup, spawnBackground: spawn, buildHooks },
    });
    assert.equal(spawn.calls.length, 1, 'spawnBackground must be called once for the drainer');
    const { command, args, options } = spawn.calls[0];
    assert.ok(command, 'spawn command must be set (node executable)');
    assert.ok(Array.isArray(args), 'spawn args must be an array');
    const drainerArg = args.find((a) => typeof a === 'string' && a.includes('capture-drain.mjs'));
    assert.ok(drainerArg, 'spawn args must include capture-drain.mjs path');
    assert.ok(args.includes(root), 'spawn args must include the project root');
    assert.equal(options?.cwd, root, 'spawn cwd must be the project root');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Test 3: Hook fires → queue populated (real buildHooks, file within 2s).
test('PMCPlugin() hooks write to the JSONL queue within 2s when fired', async () => {
  const root = makeTmpRoot('t3');
  const runStartup = mockRunStartup();
  const spawn = mockSpawn();
  // Real buildHooks (no override) → real appendToQueue writes to disk.
  const queuePath = join(root, '.opencode', 'pmc-capture-queue.jsonl');
  try {
    const result = await PMCPlugin({
      projectRoot: root,
      sessionId: 'sess-3',
      projectId: 'proj-3',
      __testOverrides: { runSessionStartRuntime: runStartup, spawnBackground: spawn },
    });
    assert.ok(result.hooks, 'hooks must be returned');
    result.hooks['chat.message']({ content: 'integration test prompt', role: 'user' });

    const found = await waitFor(() => existsSync(queuePath) && readFileSync(queuePath, 'utf8').trim().length > 0);
    assert.equal(found, true, 'queue file must exist with content within 2s');
    const lines = readFileSync(queuePath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.type, 'prompt');
    assert.equal(entry.content, 'integration test prompt');
    assert.equal(entry.sessionId, 'sess-3');
    assert.equal(entry.projectId, 'proj-3');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Test 4 (W1): runSessionStartRuntime is invoked alongside capture spawn.
test('PMCPlugin() invokes runSessionStartRuntime AND spawns the drainer together (W1)', async () => {
  const root = makeTmpRoot('t4');
  const runStartup = mockRunStartup();
  const spawn = mockSpawn();
  const buildHooks = mockBuildHooks();
  try {
    await PMCPlugin({
      projectRoot: root,
      sessionId: 'sess-4',
      __testOverrides: { runSessionStartRuntime: runStartup, spawnBackground: spawn, buildHooks },
    });
    assert.equal(runStartup.calls.length, 1, 'session-start runtime must still run (W1)');
    assert.equal(spawn.calls.length, 1, 'drainer spawn must also happen alongside startup (W1)');
    assert.ok(spawn.calls[0].args.find((a) => typeof a === 'string' && a.includes('capture-drain.mjs')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
