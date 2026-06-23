import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  runDrain,
  acquireLock,
  releaseLock,
  readQueueBatch,
  readQueueFiles,
  withRetry,
  processEntry,
} from '../cli/capture-drain.mjs';

// ── Temp project root fixture ────────────────────────────────────────────
function makeRoot() {
  const root = join(tmpdir(), `pmc-drain-test-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, '.opencode'), { recursive: true });
  return root;
}

function clean(root) {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}

function queuePathOf(root) {
  return join(root, '.opencode', 'pmc-capture-queue.jsonl');
}

function lockPathOf(root) {
  return join(root, '.opencode', 'pmc-capture-drain.lock');
}

function writeLines(filePath, objs) {
  const dir = join(filePath, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const content = objs.map((o) => JSON.stringify(o)).join('\n') + (objs.length ? '\n' : '');
  writeFileSync(filePath, content);
}

// ── In-memory mock LedgerStore (no SQLite) ───────────────────────────────
function createMockStore({ failFirstN = 0, method = 'storeSessionPrompt' } = {}) {
  const calls = {
    initialize: 0,
    setSessionContext: [],
    storeSessionPrompt: [],
    storeSessionResponse: [],
    storeSessionToolCall: [],
    close: 0,
  };
  let attempts = 0;
  const store = {
    initialize: async () => {
      calls.initialize++;
    },
    setSessionContext: (sessionId, projectId) => {
      calls.setSessionContext.push({ sessionId, projectId });
    },
    getSessionContext: () => null,
    storeSessionPrompt: async (sessionId, rawPrompt) => {
      if (method === 'storeSessionPrompt' && attempts++ < failFirstN) {
        throw new Error('SQLITE_BUSY: transient');
      }
      calls.storeSessionPrompt.push({ sessionId, rawPrompt });
      return { id: `p${calls.storeSessionPrompt.length}`, sessionId, rawPrompt };
    },
    storeSessionResponse: async (sessionId, promptId, fullResponse) => {
      if (method === 'storeSessionResponse' && attempts++ < failFirstN) {
        throw new Error('SQLITE_BUSY: transient');
      }
      calls.storeSessionResponse.push({ sessionId, promptId, fullResponse });
      return { id: `r${calls.storeSessionResponse.length}` };
    },
    storeSessionToolCall: async (params) => {
      if (method === 'storeSessionToolCall' && attempts++ < failFirstN) {
        throw new Error('SQLITE_BUSY: transient');
      }
      calls.storeSessionToolCall.push(params);
      return { id: `t${calls.storeSessionToolCall.length}` };
    },
    close: () => {
      calls.close++;
    },
  };
  return { store, calls };
}

// ── Test 1: Lock acquisition, release, and runDrain early-exit when held ─
test('T-007 #1: acquireLock creates lock with PID; second acquire refuses; release removes it', async () => {
  const root = makeRoot();
  const lockPath = lockPathOf(root);
  try {
    // Fresh acquire succeeds and writes the PID.
    const got = acquireLock(lockPath, { pid: 12345, kill: () => true });
    assert.equal(got, true);
    assert.equal(existsSync(lockPath), true);
    assert.equal(readFileSync(lockPath, 'utf8'), '12345');

    // Second acquire while the holder is alive → refused.
    const got2 = acquireLock(lockPath, { pid: 99999, kill: () => true });
    assert.equal(got2, false);

    // Release removes the lock file.
    releaseLock(lockPath);
    assert.equal(existsSync(lockPath), false);

    // After release, acquire works again.
    const got3 = acquireLock(lockPath, { pid: 22222, kill: () => true });
    assert.equal(got3, true);
    releaseLock(lockPath);
  } finally {
    clean(root);
  }
});

test('T-007 #1b: runDrain exits with exitReason "locked" and does not touch the queue when the lock is held', async () => {
  const root = makeRoot();
  const qPath = queuePathOf(root);
  const lockPath = lockPathOf(root);
  writeLines(qPath, [{ type: 'prompt', ts: 1, sessionId: 's', projectId: 'p', content: 'x' }]);
  // Pre-hold the lock with a live PID.
  writeFileSync(lockPath, '77777');
  let storeFactoryCalled = false;
  try {
    const result = await runDrain(root, {
      kill: () => true, // holder is alive
      storeFactory: async () => {
        storeFactoryCalled = true;
        return createMockStore().store;
      },
      now: () => 0,
      sleep: async () => {},
    });
    assert.equal(result.exitReason, 'locked');
    assert.equal(result.processed, 0);
    assert.equal(storeFactoryCalled, false, 'store must not be created when lock is held');
    // Queue untouched.
    const lines = readFileSync(qPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
  } finally {
    clean(root);
  }
});

// ── Test 2: readQueueBatch parses JSONL, batches max 100, rotated oldest-first ─
test('T-007 #2: readQueueBatch reads up to 100 entries and leaves the file unchanged', () => {
  const root = makeRoot();
  const qPath = queuePathOf(root);
  try {
    const entries = Array.from({ length: 150 }, (_, i) => ({ type: 'prompt', ts: i, content: `m${i}` }));
    writeLines(qPath, entries);

    const batch = readQueueBatch(qPath, 100);
    assert.equal(batch.length, 100);
    assert.equal(batch[0].content, 'm0');
    assert.equal(batch[99].content, 'm99');

    // File is NOT modified by a pure read.
    const remaining = readFileSync(qPath, 'utf8').trim().split('\n');
    assert.equal(remaining.length, 150);
  } finally {
    clean(root);
  }
});

test('T-007 #2b: readQueueBatch reads rotated files oldest-first, then the live queue', () => {
  const root = makeRoot();
  const qPath = queuePathOf(root);
  try {
    // Two rotated archives (timestamp in filename) + the live queue.
    writeLines(join(root, '.opencode', 'pmc-capture-queue.1000.jsonl'), [
      { type: 'prompt', ts: 1, content: 'rot-old' },
    ]);
    writeLines(join(root, '.opencode', 'pmc-capture-queue.2000.jsonl'), [
      { type: 'prompt', ts: 2, content: 'rot-new' },
    ]);
    writeLines(qPath, [{ type: 'prompt', ts: 3, content: 'live' }]);

    const batch = readQueueBatch(qPath, 100);
    assert.equal(batch.length, 3);
    assert.equal(batch[0].content, 'rot-old');
    assert.equal(batch[1].content, 'rot-new');
    assert.equal(batch[2].content, 'live');
  } finally {
    clean(root);
  }
});

// ── Test 3: processEntry dispatch + runDrain calls store methods and truncates ─
test('T-007 #3: processEntry dispatches prompt/tool_call/response to the correct store method', async () => {
  const { store, calls } = createMockStore();

  await processEntry(store, { type: 'prompt', sessionId: 's1', projectId: 'p1', content: 'hello' });
  await processEntry(store, {
    type: 'tool_call',
    sessionId: 's2',
    projectId: 'p2',
    toolName: 'shell',
    argsSafe: '{"cmd":"ls"}',
    resultSummary: 'ok',
    durationMs: 5,
    importance: 'normal',
  });
  await processEntry(store, {
    type: 'response',
    sessionId: 's3',
    projectId: 'p3',
    promptId: 'prompt-9',
    fullResponse: 'assistant reply',
  });

  assert.equal(calls.storeSessionPrompt.length, 1);
  assert.deepEqual(calls.storeSessionPrompt[0], { sessionId: 's1', rawPrompt: 'hello' });

  assert.equal(calls.storeSessionToolCall.length, 1);
  assert.equal(calls.storeSessionToolCall[0].sessionId, 's2');
  assert.equal(calls.storeSessionToolCall[0].toolName, 'shell');
  assert.equal(calls.storeSessionToolCall[0].argsSafe, '{"cmd":"ls"}');
  assert.equal(calls.storeSessionToolCall[0].resultSummary, 'ok');
  assert.equal(calls.storeSessionToolCall[0].importance, 'normal');

  assert.equal(calls.storeSessionResponse.length, 1);
  assert.deepEqual(calls.storeSessionResponse[0], {
    sessionId: 's3',
    promptId: 'prompt-9',
    fullResponse: 'assistant reply',
  });
});

test('T-007 #3b: runDrain processes a full queue, calls store methods, and truncates the queue', async () => {
  const root = makeRoot();
  const qPath = queuePathOf(root);
  try {
    const { store, calls } = createMockStore();
    writeLines(qPath, [
      { type: 'prompt', ts: 1, sessionId: 's', projectId: 'p', content: 'a' },
      { type: 'tool_call', ts: 2, sessionId: 's', projectId: 'p', toolName: 't', argsSafe: '{}', resultSummary: 'r', importance: 'normal' },
      { type: 'response', ts: 3, sessionId: 's', projectId: 'p', promptId: 'p1', fullResponse: 'resp' },
    ]);

    let clock = 0;
    const result = await runDrain(root, {
      storeFactory: async () => store,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      pollIntervalMs: 5_000,
      idleTimeoutMs: 30_000,
    });

    assert.equal(result.processed, 3);
    assert.equal(result.exitReason, 'idle');
    assert.equal(calls.storeSessionPrompt.length, 1);
    assert.equal(calls.storeSessionToolCall.length, 1);
    assert.equal(calls.storeSessionResponse.length, 1);
    // setSessionContext was called for each entry.
    assert.equal(calls.setSessionContext.length, 3);
    // Store was closed on exit.
    assert.equal(calls.close, 1);
    // Queue is empty after processing.
    assert.equal(existsSync(qPath), false);
  } finally {
    clean(root);
  }
});

test('T-007 #3c: runDrain batches max 100 per cycle across 150 entries', async () => {
  const root = makeRoot();
  const qPath = queuePathOf(root);
  try {
    const { store, calls } = createMockStore();
    const entries = Array.from({ length: 150 }, (_, i) => ({
      type: 'prompt',
      ts: i,
      sessionId: 's',
      projectId: 'p',
      content: `m${i}`,
    }));
    writeLines(qPath, entries);

    let clock = 0;
    const result = await runDrain(root, {
      storeFactory: async () => store,
      batchSize: 100,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      pollIntervalMs: 5_000,
      idleTimeoutMs: 30_000,
    });

    assert.equal(result.processed, 150);
    assert.equal(calls.storeSessionPrompt.length, 150);
    assert.equal(existsSync(qPath), false);
  } finally {
    clean(root);
  }
});

// ── Test 4: withRetry — 3x retries with exponential backoff (100, 200, 400) ─
test('T-007 #4: withRetry retries transient failures with backoff 100/200/400 then succeeds', async () => {
  const sleeps = [];
  let attempts = 0;
  const fn = async () => {
    attempts++;
    if (attempts < 3) throw new Error('SQLITE_BUSY');
    return 'done';
  };
  const out = await withRetry(fn, {
    retries: 3,
    backoff: [100, 200, 400],
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(out, 'done');
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [100, 200]);
});

test('T-007 #4b: withRetry exhausts 3 retries (4 attempts) with backoff 100/200/400 then throws', async () => {
  const sleeps = [];
  let attempts = 0;
  const fn = async () => {
    attempts++;
    throw new Error('SQLITE_BUSY persistent');
  };
  await assert.rejects(
    withRetry(fn, { retries: 3, backoff: [100, 200, 400], sleep: async (ms) => { sleeps.push(ms); } }),
    /SQLITE_BUSY persistent/,
  );
  assert.equal(attempts, 4);
  assert.deepEqual(sleeps, [100, 200, 400]);
});

test('T-007 #4c: runDrain retries a transient store failure via backoff and still processes the entry', async () => {
  const root = makeRoot();
  const qPath = queuePathOf(root);
  try {
    const { store, calls } = createMockStore({ failFirstN: 2, method: 'storeSessionPrompt' });
    const sleeps = [];
    writeLines(qPath, [{ type: 'prompt', ts: 1, sessionId: 's', projectId: 'p', content: 'retry-me' }]);
    let clock = 0;

    const result = await runDrain(root, {
      storeFactory: async () => store,
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      pollIntervalMs: 5_000,
      idleTimeoutMs: 30_000,
    });

    assert.equal(result.processed, 1);
    assert.equal(calls.storeSessionPrompt.length, 1);
    // Two failures → two backoff sleeps (100, 200) before the successful third
    // attempt. Subsequent sleeps are the idle poll interval, not backoff.
    assert.deepEqual(sleeps.slice(0, 2), [100, 200]);
  } finally {
    clean(root);
  }
});

// ── Test 5: runDrain exits cleanly when queue empty + idle for 30s ────────
test('T-007 #5: runDrain exits with exitReason "idle" when queue is empty and idle for 30s', async () => {
  const root = makeRoot();
  const qPath = queuePathOf(root);
  try {
    const { store } = createMockStore();
    // No queue file at all.
    let clock = 1000;
    const sleeps = [];

    const result = await runDrain(root, {
      storeFactory: async () => store,
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      pollIntervalMs: 5_000,
      idleTimeoutMs: 30_000,
    });

    assert.equal(result.exitReason, 'idle');
    assert.equal(result.processed, 0);
    // The drainer polled until the 30s idle threshold was reached.
    assert.ok(sleeps.length >= 1, 'drainer must poll while idle before exiting');
    assert.ok(clock >= 1000 + 30_000, 'simulated clock advanced past the 30s idle threshold');
  } finally {
    clean(root);
  }
});

// ── T-009 REFACTOR: Windows resilience + error-path cleanup ──────────────

test('T-009 #1: lock is released when storeFactory throws (error exit path)', async () => {
  const root = makeRoot();
  const lockPath = lockPathOf(root);
  try {
    await assert.rejects(
      runDrain(root, {
        storeFactory: async () => { throw new Error('DB open failed'); },
        now: () => 0,
        sleep: async () => {},
      }),
      /DB open failed/,
    );
    assert.equal(existsSync(lockPath), false, 'lock MUST be released on the error path');
  } finally {
    clean(root);
  }
});

test('T-009 #2: lock is released and the queue is preserved when a store call persistently fails', async () => {
  const root = makeRoot();
  const qPath = queuePathOf(root);
  const lockPath = lockPathOf(root);
  writeLines(qPath, [{ type: 'prompt', ts: 1, sessionId: 's', projectId: 'p', content: 'doomed' }]);
  try {
    const { store } = createMockStore({ failFirstN: 99, method: 'storeSessionPrompt' });
    await assert.rejects(
      runDrain(root, {
        storeFactory: async () => store,
        now: () => 0,
        sleep: async () => {},
        retries: 3,
        backoff: [1, 1, 1],
      }),
      /SQLITE_BUSY: transient/,
    );
    assert.equal(existsSync(lockPath), false, 'lock released after persistent failure');
    // The unprocessed entry MUST remain in the queue for the next drain run.
    const lines = readFileSync(qPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).content, 'doomed');
  } finally {
    clean(root);
  }
});

test('T-009 #3: atomic rewrite leaves no .tmp file behind after a successful drain', async () => {
  const root = makeRoot();
  const qPath = queuePathOf(root);
  try {
    const { store } = createMockStore();
    writeLines(qPath, [{ type: 'prompt', ts: 1, sessionId: 's', projectId: 'p', content: 'x' }]);
    let clock = 0;
    await runDrain(root, {
      storeFactory: async () => store,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      pollIntervalMs: 5_000,
      idleTimeoutMs: 30_000,
    });
    const leftover = readdirSync(join(root, '.opencode')).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftover, [], 'no .tmp file must remain after atomic rewrite');
    assert.equal(existsSync(qPath), false, 'empty queue file removed after drain');
  } finally {
    clean(root);
  }
});

test('T-009 #4: rotated-file matching is resilient to platform path separators in queuePath', () => {
  const root = makeRoot();
  // Build the queue path with path.join so it uses the native separator
  // (backslashes on Windows). Matching must be filename-based, not path-based.
  const qPath = join(root, '.opencode', 'pmc-capture-queue.jsonl');
  try {
    writeLines(join(root, '.opencode', 'pmc-capture-queue.1500.jsonl'), [
      { type: 'prompt', ts: 1, content: 'rot' },
    ]);
    writeLines(qPath, [{ type: 'prompt', ts: 2, content: 'live' }]);

    const batch = readQueueBatch(qPath, 100);
    assert.equal(batch.length, 2);
    assert.equal(batch[0].content, 'rot');
    assert.equal(batch[1].content, 'live');
  } finally {
    clean(root);
  }
});

test('T-009 #5: releaseLock is a no-op when the lock file is already gone', () => {
  const root = makeRoot();
  const lockPath = lockPathOf(root);
  try {
    // No lock file created — release must not throw.
    assert.doesNotThrow(() => releaseLock(lockPath));
    assert.equal(existsSync(lockPath), false);
  } finally {
    clean(root);
  }
});

