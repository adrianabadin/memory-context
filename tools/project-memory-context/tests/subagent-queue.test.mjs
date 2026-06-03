import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendSubagentQueue,
  loadSubagentQueue,
  claimNextPending,
  markSubagentDone,
  markSubagentError,
  summarizeSubagentQueue,
} from '../src/subagent-queue.mjs';

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), 'pmc-subagent-queue-test-'));
}

test('appendSubagentQueue creates queue file with pending entry', async () => {
  const dir = await makeTempDir();
  try {
    const entry = await appendSubagentQueue(dir, {
      symbolKey: 'js|src/foo.mjs|function|exported|foo|0',
      name: 'foo',
      filePath: 'src/foo.mjs',
      language: 'js',
      kind: 'function',
      tokenCount: 12345,
      prompt: 'Explain function foo',
      queuedAt: '2026-01-01T00:00:00.000Z',
    });

    assert.ok(entry.id, 'should have an id');
    assert.equal(entry.status, 'pending');
    assert.equal(entry.symbolKey, 'js|src/foo.mjs|function|exported|foo|0');
    assert.equal(entry.tokenCount, 12345);
    assert.equal(entry.prompt, 'Explain function foo');
    assert.equal(entry.memoryId, null);

    const queue = await loadSubagentQueue(dir);
    assert.equal(queue.entries.length, 1);
    assert.equal(queue.entries[0].id, entry.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('appendSubagentQueue accumulates multiple entries', async () => {
  const dir = await makeTempDir();
  try {
    await appendSubagentQueue(dir, { symbolKey: 'sym1', name: 'sym1', filePath: 'f.mjs', language: 'js', kind: 'function', prompt: 'p1' });
    await appendSubagentQueue(dir, { symbolKey: 'sym2', name: 'sym2', filePath: 'f.mjs', language: 'js', kind: 'function', prompt: 'p2' });

    const queue = await loadSubagentQueue(dir);
    assert.equal(queue.entries.length, 2);
    assert.equal(queue.entries[0].symbolKey, 'sym1');
    assert.equal(queue.entries[1].symbolKey, 'sym2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('claimNextPending transitions first pending entry to in_progress', async () => {
  const dir = await makeTempDir();
  try {
    const added = await appendSubagentQueue(dir, { symbolKey: 'sym1', name: 'sym1', filePath: 'f.mjs', language: 'js', kind: 'function', prompt: 'p1' });

    const claimed = await claimNextPending(dir);
    assert.equal(claimed.id, added.id);
    assert.equal(claimed.status, 'in_progress');
    assert.ok(claimed.claimedAt);

    const queue = await loadSubagentQueue(dir);
    assert.equal(queue.entries[0].status, 'in_progress');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('claimNextPending returns null when queue is empty', async () => {
  const dir = await makeTempDir();
  try {
    const result = await claimNextPending(dir);
    assert.equal(result, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('claimNextPending skips non-pending entries', async () => {
  const dir = await makeTempDir();
  try {
    await appendSubagentQueue(dir, { symbolKey: 'sym1', name: 'sym1', filePath: 'f.mjs', language: 'js', kind: 'function', prompt: 'p1' });
    await appendSubagentQueue(dir, { symbolKey: 'sym2', name: 'sym2', filePath: 'f.mjs', language: 'js', kind: 'function', prompt: 'p2' });

    // Claim first, then mark done
    const first = await claimNextPending(dir);
    await markSubagentDone(dir, first.id, { memoryId: 'queue-sym1' });

    // Next claim should get sym2
    const second = await claimNextPending(dir);
    assert.equal(second.symbolKey, 'sym2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('markSubagentDone sets status done and memoryId', async () => {
  const dir = await makeTempDir();
  try {
    const added = await appendSubagentQueue(dir, { symbolKey: 'sym1', name: 'sym1', filePath: 'f.mjs', language: 'js', kind: 'function', prompt: 'p1' });
    await claimNextPending(dir);

    const done = await markSubagentDone(dir, added.id, { memoryId: 'queue-sym1' });
    assert.equal(done.status, 'done');
    assert.equal(done.memoryId, 'queue-sym1');
    assert.ok(done.doneAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('markSubagentError sets status error and error message', async () => {
  const dir = await makeTempDir();
  try {
    const added = await appendSubagentQueue(dir, { symbolKey: 'sym1', name: 'sym1', filePath: 'f.mjs', language: 'js', kind: 'function', prompt: 'p1' });

    const errored = await markSubagentError(dir, added.id, 'subagent timed out');
    assert.equal(errored.status, 'error');
    assert.equal(errored.error, 'subagent timed out');
    assert.ok(errored.errorAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('markSubagentDone throws for unknown entry id', async () => {
  const dir = await makeTempDir();
  try {
    await assert.rejects(
      () => markSubagentDone(dir, 'nonexistent-id'),
      /entry not found/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('summarizeSubagentQueue counts by status', async () => {
  const dir = await makeTempDir();
  try {
    const e1 = await appendSubagentQueue(dir, { symbolKey: 'sym1', name: 'sym1', filePath: 'f.mjs', language: 'js', kind: 'function', prompt: 'p1' });
    const e2 = await appendSubagentQueue(dir, { symbolKey: 'sym2', name: 'sym2', filePath: 'f.mjs', language: 'js', kind: 'function', prompt: 'p2' });
    const e3 = await appendSubagentQueue(dir, { symbolKey: 'sym3', name: 'sym3', filePath: 'f.mjs', language: 'js', kind: 'function', prompt: 'p3' });

    await claimNextPending(dir); // sym1 → in_progress
    await markSubagentDone(dir, e1.id);
    await claimNextPending(dir); // sym2 → in_progress (still in_progress)
    await markSubagentError(dir, e2.id, 'oops');
    // sym3 stays pending

    const queue = await loadSubagentQueue(dir);
    const summary = summarizeSubagentQueue(queue);

    assert.deepEqual(summary, { total: 3, pending: 1, in_progress: 0, done: 1, error: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadSubagentQueue returns empty queue when file does not exist', async () => {
  const dir = await makeTempDir();
  try {
    const queue = await loadSubagentQueue(dir);
    assert.deepEqual(queue, { entries: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
