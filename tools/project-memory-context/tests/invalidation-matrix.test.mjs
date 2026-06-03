import test from 'node:test';
import assert from 'node:assert/strict';

import { detectInvalidatedProjectContextKinds } from '../src/invalidation-matrix.mjs';

test('package.json invalidates stack and dependency memories', () => {
  const result = detectInvalidatedProjectContextKinds(['package.json']);
  assert.deepEqual(result.sort(), ['dependencies-summary', 'integrations-summary', 'stack-runtime']);
});

test('declared technical rules file invalidates rules memory', () => {
  const result = detectInvalidatedProjectContextKinds(['.planning/project-memory-context/project-context/declared/technical-rules.json']);
  assert.equal(result.includes('technical-rules'), true);
});

test('declared technical rules file invalidates rules memory for Windows-style paths', () => {
  const result = detectInvalidatedProjectContextKinds(['.planning\\project-memory-context\\project-context\\declared\\technical-rules.json']);
  assert.equal(result.includes('technical-rules'), true);
});

test('detectInvalidatedProjectContextKinds invalidates technical rules for CLAUDE.md', () => {
  const result = detectInvalidatedProjectContextKinds(['CLAUDE.md']);
  assert.deepEqual(result.sort(), ['project-requirements', 'technical-rules']);
});
