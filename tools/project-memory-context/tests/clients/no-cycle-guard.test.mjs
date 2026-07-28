import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkNoCycleInvariants } from '../helpers/no-cycle-guard.mjs';

test('checkNoCycleInvariants passes against real production adapter modules in src/clients/adapters', () => {
  assert.equal(checkNoCycleInvariants(), true);
});

test('checkNoCycleInvariants rejects temp fixture adapter importing registry/platform/template-installer', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pmc-cycle-test-'));
  try {
    for (const forbidden of ['registry.mjs', 'platform.mjs', 'template-installer.mjs']) {
      const badAdapterContent = `// Ignored comment: import '../${forbidden}';\nimport '../${forbidden}';\nexport const bad = {};\n`;
      await writeFile(join(tempDir, 'bad-adapter.mjs'), badAdapterContent, 'utf8');

      assert.throws(
        () => checkNoCycleInvariants(tempDir),
        new RegExp(`violates Invariant 9 by importing ${forbidden.replaceAll('.', '\\.')}`)
      );
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
