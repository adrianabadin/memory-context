import test from 'node:test';
import assert from 'node:assert/strict';

import { WATCHDOG_GUARD_STALE_MS, shouldSkipWatchdogStart } from '../cli/enrich-watchdog.mjs';

const NOW = Date.parse('2026-06-09T10:00:00.000Z');
const fresh = new Date(NOW - 10_000).toISOString();
const stale = new Date(NOW - WATCHDOG_GUARD_STALE_MS - 1).toISOString();

function opts(overrides = {}) {
  return { now: NOW, selfPid: 100, isPidAlive: () => true, ...overrides };
}

test('skips start when another live watchdog is running with fresh heartbeat', () => {
  const state = { status: 'running', pid: 200, heartbeatAt: fresh };
  assert.equal(shouldSkipWatchdogStart(state, opts()), true);
});

test('does not skip when no state, not running, own pid, dead pid, or stale heartbeat', () => {
  assert.equal(shouldSkipWatchdogStart(null, opts()), false);
  assert.equal(shouldSkipWatchdogStart({ status: 'finished', pid: 200, heartbeatAt: fresh }, opts()), false);
  assert.equal(shouldSkipWatchdogStart({ status: 'running', pid: 100, heartbeatAt: fresh }, opts()), false);
  assert.equal(
    shouldSkipWatchdogStart({ status: 'running', pid: 200, heartbeatAt: fresh }, opts({ isPidAlive: () => false })),
    false,
  );
  assert.equal(shouldSkipWatchdogStart({ status: 'running', pid: 200, heartbeatAt: stale }, opts()), false);
  assert.equal(shouldSkipWatchdogStart({ status: 'running', pid: 200 }, opts()), false); // missing heartbeat
});
