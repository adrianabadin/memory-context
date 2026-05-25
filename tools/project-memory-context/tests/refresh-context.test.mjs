import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { refreshContext } from '../cli/refresh-context.mjs';

const TMP = join(process.env.TEMP || '/tmp', 'pmc-refresh-context-test');

const APP_CODE = `export function handleRequest(req, res) {
  return res.json({ ok: true });
}
`;

test('refreshContext detects new file and updates worklist', async () => {
  await mkdir(join(TMP, 'src'), { recursive: true });
  await mkdir(join(TMP, '.planning', 'project-memory-context', 'enrichment'), { recursive: true });
  await mkdir(join(TMP, '.planning', 'project-memory-context', 'graph'), { recursive: true });

  await writeFile(join(TMP, 'src', 'app.mjs'), APP_CODE);

  const oldHash = '0000000000000000';
  const oldWorklist = [
    {
      symbolKey: 'js|src/app.mjs|function|exported|handleRequest|2',
      filePath: 'src/app.mjs',
      language: 'js',
      kind: 'function',
      name: 'handleRequest',
      exportScope: 'exported',
      arity: 2,
      range: { startLine: 1, endLine: 3 },
      codeHash: oldHash,
      status: 'enriched',
      memoryId: 'mem-old',
      graphNodeId: null,
    },
  ];
  await writeFile(
    join(TMP, '.planning', 'project-memory-context', 'enrichment', 'worklist.json'),
    JSON.stringify(oldWorklist, null, 2),
  );

  await writeFile(
    join(TMP, '.planning', 'project-memory-context', 'enrichment', 'hash-store.json'),
    JSON.stringify({ hashes: {}, updatedAt: new Date().toISOString() }),
  );

  const result = await refreshContext(TMP);

  assert.ok(result.total > 0, 'expected total > 0 since file is new to hash store');

  const worklistRaw = await readFile(
    join(TMP, '.planning', 'project-memory-context', 'enrichment', 'worklist.json'),
    'utf8',
  );
  const worklist = JSON.parse(worklistRaw);
  assert.ok(worklist.length > 0, 'worklist should have entries');

  const sym = worklist.find(
    (e) => e.name === 'handleRequest',
  );
  assert.ok(sym, 'worklist should contain handleRequest');
  assert.equal(sym.status, 'stale', 'symbol should be stale because codeHash changed');

  await rm(TMP, { recursive: true });
});

test('refreshContext returns total=0 when no changes', async () => {
  await mkdir(join(TMP, 'src'), { recursive: true });
  await mkdir(join(TMP, '.planning', 'project-memory-context', 'enrichment'), { recursive: true });
  await mkdir(join(TMP, '.planning', 'project-memory-context', 'graph'), { recursive: true });

  await writeFile(join(TMP, 'src', 'app.mjs'), APP_CODE);

  const hashStorePath = join(TMP, '.planning', 'project-memory-context', 'enrichment', 'hash-store.json');
  const { computeFileHashes } = await import('../src/file-hash-store.mjs');
  const currentHashes = await computeFileHashes(TMP);

  const { saveHashStore } = await import('../src/file-hash-store.mjs');
  await saveHashStore(hashStorePath, currentHashes);

  const result = await refreshContext(TMP);

  assert.equal(result.total, 0, 'no changes expected');

  await rm(TMP, { recursive: true });
});

test('refreshContext marks symbols as removed when file is deleted', async () => {
  await mkdir(join(TMP, 'src'), { recursive: true });
  await mkdir(join(TMP, '.planning', 'project-memory-context', 'enrichment'), { recursive: true });
  await mkdir(join(TMP, '.planning', 'project-memory-context', 'graph'), { recursive: true });

  await writeFile(join(TMP, 'src', 'temp.mjs'), 'export function willBeRemoved() { return 1; }\n');

  // First run: establish the file and symbol
  await writeFile(
    join(TMP, '.planning', 'project-memory-context', 'enrichment', 'hash-store.json'),
    JSON.stringify({ hashes: {}, updatedAt: new Date().toISOString() }),
  );
  await writeFile(
    join(TMP, '.planning', 'project-memory-context', 'enrichment', 'worklist.json'),
    JSON.stringify([]),
  );
  await refreshContext(TMP);

  // Second run: remove the file and detect removed symbols
  await rm(join(TMP, 'src', 'temp.mjs'));
  const result = await refreshContext(TMP);

  assert.equal(result.removed, 1, 'file should be detected as removed');
  assert.ok(result.removedSymbols > 0, 'symbol should be marked as removed');

  await rm(TMP, { recursive: true });
});
