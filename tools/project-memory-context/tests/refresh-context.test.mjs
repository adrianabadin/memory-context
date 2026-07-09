import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { HASH_VERSION } from '../src/hash.mjs';

import { refreshContext } from '../cli/refresh-context.mjs';

let counter = 0;
function tmp(label) {
  return join(tmpdir(), `pmc-refresh-context-test-${++counter}-${label}`);
}

const APP_CODE = `export function handleRequest(req, res) {
  return res.json({ ok: true });
}
`;

test('refreshContext detects new file and updates worklist', async () => {
  const T = tmp('detect');
  await mkdir(join(T, 'src'), { recursive: true });
  await mkdir(join(T, '.planning', 'project-memory-context', 'enrichment'), { recursive: true });
  await mkdir(join(T, '.planning', 'project-memory-context', 'graph'), { recursive: true });

  await writeFile(join(T, 'src', 'app.mjs'), APP_CODE);

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
      hashVersion: HASH_VERSION,
      status: 'enriched',
      memoryId: 'mem-old',
      graphNodeId: null,
    },
  ];
  await writeFile(
    join(T, '.planning', 'project-memory-context', 'enrichment', 'worklist.json'),
    JSON.stringify(oldWorklist, null, 2),
  );

  await writeFile(
    join(T, '.planning', 'project-memory-context', 'enrichment', 'hash-store.json'),
    JSON.stringify({ hashes: {}, updatedAt: new Date().toISOString() }),
  );

  const result = await refreshContext(T, {
    // Inject mock spawnBackground so we don't spawn real sync process
    spawnBackground: () => 123,
    open: async () => ({ fd: 1, close: async () => {} }),
  });

  assert.ok(result.total > 0, 'expected total > 0 since file is new to hash store');

  const worklistRaw = await readFile(
    join(T, '.planning', 'project-memory-context', 'enrichment', 'worklist.json'),
    'utf8',
  );
  const worklist = JSON.parse(worklistRaw);
  assert.ok(worklist.length > 0, 'worklist should have entries');

  const sym = worklist.find(
    (e) => e.name === 'handleRequest',
  );
  assert.ok(sym, 'worklist should contain handleRequest');
  assert.equal(sym.status, 'stale', 'symbol should be stale because codeHash changed');

  await rm(T, { recursive: true, force: true });
});

test('refreshContext returns total=0 when no changes', async () => {
  const T = tmp('no-changes');
  await mkdir(join(T, 'src'), { recursive: true });
  await mkdir(join(T, '.planning', 'project-memory-context', 'enrichment'), { recursive: true });
  await mkdir(join(T, '.planning', 'project-memory-context', 'graph'), { recursive: true });

  await writeFile(join(T, 'src', 'app.mjs'), APP_CODE);

  const hashStorePath = join(T, '.planning', 'project-memory-context', 'enrichment', 'hash-store.json');
  const { computeFileHashes } = await import('../src/file-hash-store.mjs');
  const currentHashes = await computeFileHashes(T);

  const { saveHashStore } = await import('../src/file-hash-store.mjs');
  await saveHashStore(hashStorePath, currentHashes);

  const result = await refreshContext(T, {
    spawnBackground: () => 123,
    open: async () => ({ fd: 1, close: async () => {} }),
  });

  assert.equal(result.total, 0, 'no changes expected');

  await rm(T, { recursive: true, force: true });
});

test('refreshContext marks symbols as removed when file is deleted', async () => {
  const T = tmp('removed');
  await mkdir(join(T, 'src'), { recursive: true });
  await mkdir(join(T, '.planning', 'project-memory-context', 'enrichment'), { recursive: true });
  await mkdir(join(T, '.planning', 'project-memory-context', 'graph'), { recursive: true });

  await writeFile(join(T, 'src', 'temp.mjs'), 'export function willBeRemoved() { return 1; }\n');

  await writeFile(
    join(T, '.planning', 'project-memory-context', 'enrichment', 'hash-store.json'),
    JSON.stringify({ hashes: {}, updatedAt: new Date().toISOString() }),
  );
  await writeFile(
    join(T, '.planning', 'project-memory-context', 'enrichment', 'worklist.json'),
    JSON.stringify([]),
  );
  await refreshContext(T, {
    spawnBackground: () => 123,
    open: async () => ({ fd: 1, close: async () => {} }),
  });

  await rm(join(T, 'src', 'temp.mjs'));
  const result = await refreshContext(T, {
    spawnBackground: () => 123,
    open: async () => ({ fd: 1, close: async () => {} }),
  });

  assert.equal(result.removed, 1, 'file should be detected as removed');
  assert.ok(result.removedSymbols > 0, 'symbol should be marked as removed');

  await rm(T, { recursive: true, force: true });
});

test('refreshContext auto-spawns background sync when enrich is false', async () => {
  const T = tmp('auto-spawn');
  await mkdir(join(T, 'src'), { recursive: true });
  await mkdir(join(T, '.planning', 'project-memory-context', 'enrichment'), { recursive: true });
  await mkdir(join(T, '.planning', 'project-memory-context', 'graph'), { recursive: true });

  await writeFile(join(T, 'src', 'app.mjs'), APP_CODE);

  await writeFile(
    join(T, '.planning', 'project-memory-context', 'enrichment', 'hash-store.json'),
    JSON.stringify({ hashes: {}, updatedAt: new Date().toISOString() }),
  );

  const spawnCalls = [];
  const openCalls = [];
  const fakeHandle = { fd: 77, close: async () => {} };

  await refreshContext(T, {
    enrich: false,
    spawnBackground: (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      return 1234;
    },
    open: async (path, flags) => {
      openCalls.push({ path, flags });
      return fakeHandle;
    },
  });

  assert.equal(spawnCalls.length, 1);
  assert.ok(spawnCalls[0].args.includes('--background'));
  assert.equal(spawnCalls[0].opts.stdio[1], 77);

  await rm(T, { recursive: true, force: true });
});

test('refreshContext does NOT spawn background sync when enrich is true and there are pending symbols', async () => {
  const T = tmp('no-spawn-enrich');
  await mkdir(join(T, 'src'), { recursive: true });
  await mkdir(join(T, '.planning', 'project-memory-context', 'enrichment'), { recursive: true });
  await mkdir(join(T, '.planning', 'project-memory-context', 'graph'), { recursive: true });

  await writeFile(join(T, 'src', 'app.mjs'), APP_CODE);

  await writeFile(
    join(T, '.planning', 'project-memory-context', 'enrichment', 'hash-store.json'),
    JSON.stringify({ hashes: {}, updatedAt: new Date().toISOString() }),
  );

  const spawnCalls = [];

  await refreshContext(T, {
    enrich: true,
    spawnBackground: (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      return 1234;
    },
    open: async () => ({ fd: 1, close: async () => {} }),
  });

  const hasSync = spawnCalls.some(c => c.args.some(a => a.includes('sync.mjs')));
  assert.equal(hasSync, false, 'should not spawn sync.mjs directly');

  await rm(T, { recursive: true, force: true });
});
