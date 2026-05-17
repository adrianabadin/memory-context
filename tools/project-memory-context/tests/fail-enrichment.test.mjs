import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ensureProjectMemoryContextDirs,
  readJsonArtifact,
  writeJsonArtifact,
} from '../src/artifacts.mjs';
import { recordEnrichmentFailure } from '../src/fail-enrichment.mjs';

test('recordEnrichmentFailure marks worklist entry as error and appends failures log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-failure-'));
  const dirs = await ensureProjectMemoryContextDirs(root);

  await writeJsonArtifact(join(dirs.enrichment, 'worklist.json'), [
    {
      symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
      status: 'pending',
      memoryId: null,
    },
  ]);

  await recordEnrichmentFailure({
    projectRoot: root,
    symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
    error: 'ia-local returned no report operation',
    failedAt: '2026-05-15T18:10:00Z',
  });

  const worklist = await readJsonArtifact(join(dirs.enrichment, 'worklist.json'));
  const failures = await readJsonArtifact(join(dirs.enrichment, 'failures.json'));

  assert.equal(worklist[0].status, 'error');
  assert.equal(worklist[0].error, 'ia-local returned no report operation');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].symbolKey, 'ts|src/user.ts|function|exported|getUser|1');
});
