import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldIgnoreDir, IGNORED_DIRS, ALLOWED_HIDDEN_DIRS_NAMES } from '../src/walk-ignores.mjs';

test('shouldIgnoreDir ignores always-ignored names (hidden or not)', () => {
  for (const name of IGNORED_DIRS) {
    assert.equal(shouldIgnoreDir(name), true, `expected ${name} to be ignored`);
  }
});

test('shouldIgnoreDir ignores hidden directories by default', () => {
  assert.equal(shouldIgnoreDir('.git'), true);
  assert.equal(shouldIgnoreDir('.worktrees'), true);
  assert.equal(shouldIgnoreDir('.planning'), true);
  assert.equal(shouldIgnoreDir('.next'), true);
  assert.equal(shouldIgnoreDir('.vscode'), true);
  assert.equal(shouldIgnoreDir('.idea'), true);
  assert.equal(shouldIgnoreDir('.playwright-mcp'), true);
});

test('shouldIgnoreDir explicitly ignores .worktrees and .planning in IGNORED_DIRS', () => {
  assert.equal(IGNORED_DIRS.has('.worktrees'), true, 'expected .worktrees in IGNORED_DIRS');
  assert.equal(IGNORED_DIRS.has('.planning'), true, 'expected .planning in IGNORED_DIRS');
  assert.equal(ALLOWED_HIDDEN_DIRS_NAMES.has('.planning'), false, 'expected .planning not in ALLOWED_HIDDEN_DIRS_NAMES');
});

test('shouldIgnoreDir keeps allowlisted hidden directories', () => {
  for (const name of ALLOWED_HIDDEN_DIRS_NAMES) {
    assert.equal(shouldIgnoreDir(name), false, `expected ${name} to be kept`);
  }
});

test('shouldIgnoreDir keeps regular project directories', () => {
  assert.equal(shouldIgnoreDir('src'), false);
  assert.equal(shouldIgnoreDir('tests'), false);
  assert.equal(shouldIgnoreDir('tools'), false);
  assert.equal(shouldIgnoreDir('docs'), false);
});

test('shouldIgnoreDir ignores nested hidden directory names', () => {
  assert.equal(shouldIgnoreDir('.foo'), true);
});
