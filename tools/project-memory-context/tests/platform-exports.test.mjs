import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import * as platform from '../src/platform.mjs';

test('platform.mjs exports required public functions and behaves deterministically', () => {
  assert.equal(typeof platform.detectAgentType, 'function');
  assert.equal(typeof platform.detectSetupAgentType, 'function');
  assert.equal(typeof platform.normalizeProjectPath, 'function');

  // Assert deterministic values & behaviors for exports
  assert.equal(platform.normalizeProjectPath('foo\\bar/baz'), 'foo/bar/baz');
  assert.equal(platform.normalizeProjectPath(''), '');
  assert.equal(platform.isAgentInstructionFile('path/to/AGENTS.md'), true);
  assert.equal(platform.isAgentInstructionFile('path/to/other.txt'), false);

  const tempDir = mkdtempSync(join(tmpdir(), 'pmc-platform-test-'));
  try {
    assert.equal(platform.detectAgentType(tempDir), 'generic');

    mkdirSync(join(tempDir, '.opencode'));
    assert.equal(platform.detectAgentType(tempDir), 'opencode');

    assert.equal(platform.detectSetupAgentType(tempDir, { requestedAgent: 'cursor' }), 'cursor');
    assert.equal(platform.detectSetupAgentType(tempDir, { exists: () => false }), 'opencode');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
