/**
 * Tests for the --stale-only flag behaviour in enrich-queue.mjs.
 *
 * Verifies that selectWorkItems correctly narrows (or keeps) the work set
 * based on the staleOnly flag, without touching any filesystem or network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { selectWorkItems } from '../cli/enrich-queue.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeWorklist() {
  return [
    { symbolKey: 'a', name: 'A', status: 'pending' },
    { symbolKey: 'b', name: 'B', status: 'stale' },
    { symbolKey: 'c', name: 'C', status: 'stale' },
    { symbolKey: 'd', name: 'D', status: 'enriched' },
    { symbolKey: 'e', name: 'E', status: 'already_enriched' },
    { symbolKey: 'f', name: 'F', status: 'error' },
  ];
}

// ---------------------------------------------------------------------------
// Default mode (staleOnly = false): selects pending + stale
// ---------------------------------------------------------------------------

test('selectWorkItems default: includes pending and stale symbols', () => {
  const result = selectWorkItems(makeWorklist(), false);
  assert.deepEqual(result.map(s => s.symbolKey), ['a', 'b', 'c']);
});

test('selectWorkItems default: excludes enriched, already_enriched, and error symbols', () => {
  const result = selectWorkItems(makeWorklist(), false);
  assert.ok(!result.find(s => s.status === 'enriched'));
  assert.ok(!result.find(s => s.status === 'already_enriched'));
  assert.ok(!result.find(s => s.status === 'error'));
});

test('selectWorkItems default (no arg): same as staleOnly=false', () => {
  const withArg = selectWorkItems(makeWorklist(), false);
  const noArg = selectWorkItems(makeWorklist());
  assert.deepEqual(withArg.map(s => s.symbolKey), noArg.map(s => s.symbolKey));
});

// ---------------------------------------------------------------------------
// --stale-only mode: only stale symbols, pending is skipped
// ---------------------------------------------------------------------------

test('selectWorkItems staleOnly: includes only stale symbols', () => {
  const result = selectWorkItems(makeWorklist(), true);
  assert.deepEqual(result.map(s => s.symbolKey), ['b', 'c']);
});

test('selectWorkItems staleOnly: skips pending symbols', () => {
  const result = selectWorkItems(makeWorklist(), true);
  assert.ok(!result.find(s => s.status === 'pending'));
});

test('selectWorkItems staleOnly: excludes enriched, already_enriched, and error symbols', () => {
  const result = selectWorkItems(makeWorklist(), true);
  assert.ok(!result.find(s => s.status === 'enriched'));
  assert.ok(!result.find(s => s.status === 'already_enriched'));
  assert.ok(!result.find(s => s.status === 'error'));
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('selectWorkItems staleOnly: returns empty array when no stale symbols', () => {
  const worklist = [
    { symbolKey: 'a', status: 'pending' },
    { symbolKey: 'b', status: 'enriched' },
  ];
  const result = selectWorkItems(worklist, true);
  assert.equal(result.length, 0);
});

test('selectWorkItems default: returns empty array when no pending or stale symbols', () => {
  const worklist = [
    { symbolKey: 'a', status: 'enriched' },
    { symbolKey: 'b', status: 'already_enriched' },
  ];
  const result = selectWorkItems(worklist, false);
  assert.equal(result.length, 0);
});

test('selectWorkItems: handles empty worklist gracefully', () => {
  assert.equal(selectWorkItems([], false).length, 0);
  assert.equal(selectWorkItems([], true).length, 0);
});
