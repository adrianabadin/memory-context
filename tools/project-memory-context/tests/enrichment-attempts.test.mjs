import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { appendProviderEvent, withRecordedAttempt } from '../src/enrichment-attempts.mjs';

test('appendProviderEvent appends parseable json lines', async () => {
  const enrichmentDir = await mkdtemp(join(tmpdir(), 'pmc-attempts-'));

  await appendProviderEvent(enrichmentDir, { mode: 'local-model', status: 'failed' });
  await appendProviderEvent(enrichmentDir, { mode: 'cloud-api', status: 'succeeded' });

  const log = await readFile(join(enrichmentDir, 'provider-events.jsonl'), 'utf8');
  const lines = log.trim().split('\n');

  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [
    { mode: 'local-model', status: 'failed' },
    { mode: 'cloud-api', status: 'succeeded' },
  ]);
});

test('withRecordedAttempt appends attempts and updates lastModeUsed', () => {
  const result = withRecordedAttempt(
    { symbolKey: 'ts|src/user.ts|function|exported|getUser|1' },
    { mode: 'cloud-api', status: 'succeeded' },
  );

  assert.deepEqual(result.attempts, [{ mode: 'cloud-api', status: 'succeeded' }]);
  assert.equal(result.lastModeUsed, 'cloud-api');
});
