import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEmptyRefreshState,
  updateRefreshStateEntry,
  shouldRefreshProjectContext,
} from '../src/refresh-state.mjs';

test('createEmptyRefreshState returns empty tracked files and memories', () => {
  assert.deepEqual(createEmptyRefreshState(), {
    trackedFiles: {},
    memoryHashes: {},
    updatedAt: null,
  });
});

test('updateRefreshStateEntry stores file hash', () => {
  const state = updateRefreshStateEntry(createEmptyRefreshState(), 'package.json', 'abc');
  assert.equal(state.trackedFiles['package.json'], 'abc');
});

test('shouldRefreshProjectContext returns true when hash changes', () => {
  const state = updateRefreshStateEntry(createEmptyRefreshState(), 'package.json', 'abc');
  assert.equal(shouldRefreshProjectContext(state, 'package.json', 'xyz'), true);
  assert.equal(shouldRefreshProjectContext(state, 'package.json', 'abc'), false);
});
