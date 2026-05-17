import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ensureProjectMemoryContextDirs, readJsonArtifact, writeJsonArtifact } from '../src/artifacts.mjs';
import { prepareSemanticJobs } from '../src/prepare-semantic-jobs.mjs';

test('prepareSemanticJobs builds jobs only for pending symbols', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-jobs-'));
  const dirs = await ensureProjectMemoryContextDirs(root);
  const sourceDir = join(root, 'src');
  const sourceFile = join(sourceDir, 'user.ts');

  await mkdir(sourceDir, { recursive: true });

  await writeFile(sourceFile, [
    "import { api } from './api';",
    '',
    'export function getUser(id) {',
    '  return api.get(id);',
    '}',
  ].join('\n'));

  await writeJsonArtifact(join(dirs.enrichment, 'worklist.json'), [
    {
      symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
      language: 'ts',
      filePath: 'src/user.ts',
      kind: 'function',
      name: 'getUser',
      range: { startLine: 3, endLine: 5 },
      codeHash: 'hash-a',
      status: 'pending',
      memoryId: null,
      graphNodeId: 'node-1',
    },
    {
      symbolKey: 'ts|src/user.ts|function|local|helper|0',
      language: 'ts',
      filePath: 'src/user.ts',
      kind: 'function',
      name: 'helper',
      range: { startLine: 1, endLine: 1 },
      codeHash: 'hash-b',
      status: 'enriched',
      memoryId: 'mem_1',
      graphNodeId: 'node-2',
    },
  ]);

  const result = await prepareSemanticJobs({ projectRoot: root });
  const jobs = await readJsonArtifact(join(dirs.enrichment, 'semantic-jobs.json'));

  assert.equal(result.count, 1);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].symbolKey, 'ts|src/user.ts|function|exported|getUser|1');
  assert.equal(jobs[0].graphNodeId, 'node-1');
  assert.match(jobs[0].context, /import \{ api \}/);
  assert.match(jobs[0].code, /return api.get/);
});
