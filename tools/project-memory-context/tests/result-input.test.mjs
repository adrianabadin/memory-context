import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadResultInput } from '../src/result-input.mjs';

test('loadResultInput parses inline JSON payloads', async () => {
  const result = await loadResultInput('{"memoryId":"mem_1"}');
  assert.deepEqual(result, { memoryId: 'mem_1' });
});

test('loadResultInput parses @file payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-result-input-'));
  const file = join(root, 'result.json');
  await writeFile(file, '{"memoryId":"mem_2"}', 'utf8');

  const result = await loadResultInput(`@${file}`);
  assert.deepEqual(result, { memoryId: 'mem_2' });
});
