import test from 'node:test';
import assert from 'node:assert/strict';

import { detectChangedFilesFromHashes } from '../src/change-detector.mjs';

test('detectChangedFilesFromHashes returns changed and new files', () => {
  const result = detectChangedFilesFromHashes(
    { 'package.json': 'abc', 'README.md': 'old' },
    { 'package.json': 'abc', 'README.md': 'new', 'tsconfig.json': 'zzz' },
  );

  assert.deepEqual(result.sort(), ['README.md', 'tsconfig.json']);
});
