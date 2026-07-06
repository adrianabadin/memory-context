import test from 'node:test';
import assert from 'node:assert/strict';

import { QUEUE_GUARD_STALE_MS, shouldSkipQueueStart } from '../cli/enrich-queue.mjs';

const NOW = Date.parse('2026-06-09T10:00:00.000Z');
const fresh = new Date(NOW - 10_000).toISOString();
const stale = new Date(NOW - QUEUE_GUARD_STALE_MS - 1).toISOString();

function opts(overrides = {}) {
  return { now: NOW, selfPid: 100, isPidAlive: () => true, ...overrides };
}

test('skips start when another live queue is running with fresh heartbeat', () => {
  const state = { status: 'running', pid: 200, heartbeatAt: fresh };
  assert.equal(shouldSkipQueueStart(state, opts()), true);
});

test('does not skip when no state, not running, own pid, dead pid, or stale heartbeat', () => {
  assert.equal(shouldSkipQueueStart(null, opts()), false);
  assert.equal(shouldSkipQueueStart({ status: 'finished', pid: 200, heartbeatAt: fresh }, opts()), false);
  assert.equal(shouldSkipQueueStart({ status: 'running', pid: 100, heartbeatAt: fresh }, opts()), false);
  assert.equal(
    shouldSkipQueueStart({ status: 'running', pid: 200, heartbeatAt: fresh }, opts({ isPidAlive: () => false })),
    false,
  );
  assert.equal(shouldSkipQueueStart({ status: 'running', pid: 200, heartbeatAt: stale }, opts()), false);
  assert.equal(shouldSkipQueueStart({ status: 'running', pid: 200 }, opts()), false); // missing heartbeat
});
