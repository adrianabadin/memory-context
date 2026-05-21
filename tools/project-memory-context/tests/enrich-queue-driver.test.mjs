import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildQueueSummary, parseQueueConcurrency, runQueueSymbolEnrichment } from '../cli/enrich-queue.mjs';
import {
  ensureProjectMemoryContextDirs,
  readJsonArtifact,
  writeJsonArtifact,
} from '../src/artifacts.mjs';

async function createQueueFixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-enrich-queue-'));
  const dirs = await ensureProjectMemoryContextDirs(projectRoot);
  const sourceDir = join(projectRoot, 'src');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(
    join(sourceDir, 'user.ts'),
    [
      "import { db } from './db';",
      '',
      'export async function getUser(id) {',
      '  return db.users.find(id);',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  const symbol = {
    symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
    name: 'getUser',
    kind: 'function',
    language: 'ts',
    filePath: 'src/user.ts',
    codeHash: 'hash-a',
    range: {
      startLine: 3,
      endLine: 5,
    },
    status: 'pending',
  };

  const worklistFile = join(dirs.enrichment, 'worklist.json');
  const symbolIndexFile = join(dirs.enrichment, 'symbol-index.json');
  const worklist = [structuredClone(symbol)];
  await writeJsonArtifact(worklistFile, worklist);
  await writeJsonArtifact(symbolIndexFile, {});

  return { projectRoot, dirs, symbol, worklist, worklistFile, symbolIndexFile };
}

test('runQueueSymbolEnrichment writes memory, appends sync entry, records successful attempts, and updates symbol index', async () => {
  const { projectRoot, dirs, symbol, worklist, worklistFile, symbolIndexFile } = await createQueueFixture();

  const result = await runQueueSymbolEnrichment({
    symbol,
    projectRoot,
    projectSlug: 'memory-context',
    timeoutMs: 30_000,
    enrichmentDir: dirs.enrichment,
    worklist,
    worklistFile,
    symbolIndex: {},
    symbolIndexFile,
    config: { preferredModes: ['local-model'] },
    providers: [],
    runEnrichmentWithFallbackImpl: async () => ({
      status: 'succeeded',
      content: 'Does the user lookup.',
      mode: 'local-model',
      provider: 'ollama',
      model: 'deepseek',
      attempts: [
        {
          mode: 'local-model',
          provider: 'ollama',
          model: 'deepseek',
          status: 'succeeded',
          startedAt: '2026-05-17T12:00:00.000Z',
          endedAt: '2026-05-17T12:00:01.000Z',
        },
      ],
    }),
  });

  assert.equal(result.status, 'enriched');
  assert.equal(result.memoryId, 'queue-ts_src_user_ts_function_exported_getUser_1');

  const memoryFile = join(dirs.enrichment, 'ts_src_user_ts_function_exported_getUser_1.memory.json');
  const memoryPayload = await readJsonArtifact(memoryFile);
  assert.equal(memoryPayload.content, 'Does the user lookup.');
  assert.deepEqual(memoryPayload.tags, [
    'symbol',
    'ts',
    'function',
    'project:memory-context',
    'file:src/user.ts',
  ]);

  const syncManifest = await readJsonArtifact(join(dirs.enrichment, 'sync-manifest.json'));
  assert.equal(syncManifest.entries.length, 1);
  assert.equal(syncManifest.entries[0].status, 'pending');
  assert.equal(syncManifest.entries[0].source, 'enrich-queue');
  assert.equal(syncManifest.entries[0].symbolKey, symbol.symbolKey);

  const updatedWorklist = await readJsonArtifact(worklistFile);
  assert.equal(updatedWorklist[0].status, 'enriched');
  assert.equal(updatedWorklist[0].lastModeUsed, 'local-model');
  assert.deepEqual(updatedWorklist[0].attempts, [
    {
      mode: 'local-model',
      provider: 'ollama',
      model: 'deepseek',
      status: 'succeeded',
      startedAt: '2026-05-17T12:00:00.000Z',
      endedAt: '2026-05-17T12:00:01.000Z',
    },
  ]);

  const updatedIndex = await readJsonArtifact(symbolIndexFile);
  assert.equal(updatedIndex[symbol.symbolKey].memoryId, 'queue-ts_src_user_ts_function_exported_getUser_1');
  assert.equal(updatedIndex[symbol.symbolKey].status, 'enriched');
});

test('runQueueSymbolEnrichment preserves failed and successful fallback attempts on success', async () => {
  const { projectRoot, dirs, symbol, worklist, worklistFile, symbolIndexFile } = await createQueueFixture();

  await runQueueSymbolEnrichment({
    symbol,
    projectRoot,
    projectSlug: 'memory-context',
    timeoutMs: 30_000,
    enrichmentDir: dirs.enrichment,
    worklist,
    worklistFile,
    symbolIndex: {},
    symbolIndexFile,
    config: { preferredModes: ['local-model', 'cloud-api'] },
    providers: [],
    runEnrichmentWithFallbackImpl: async () => ({
      status: 'succeeded',
      content: 'Fallback summary.',
      mode: 'cloud-api',
      provider: 'openai-compatible',
      model: 'gpt-test',
      attempts: [
        {
          mode: 'local-model',
          provider: 'ollama',
          status: 'failed',
          errorType: 'network',
          errorMessage: 'ECONNREFUSED',
          startedAt: '2026-05-17T12:00:00.000Z',
          endedAt: '2026-05-17T12:00:01.000Z',
        },
        {
          mode: 'cloud-api',
          provider: 'openai-compatible',
          model: 'gpt-test',
          status: 'succeeded',
          startedAt: '2026-05-17T12:00:01.000Z',
          endedAt: '2026-05-17T12:00:02.000Z',
        },
      ],
    }),
  });

  const updatedWorklist = await readJsonArtifact(worklistFile);
  assert.equal(updatedWorklist[0].status, 'enriched');
  assert.equal(updatedWorklist[0].lastModeUsed, 'cloud-api');
  assert.deepEqual(updatedWorklist[0].attempts, [
    {
      mode: 'local-model',
      provider: 'ollama',
      status: 'failed',
      errorType: 'network',
      errorMessage: 'ECONNREFUSED',
      startedAt: '2026-05-17T12:00:00.000Z',
      endedAt: '2026-05-17T12:00:01.000Z',
    },
    {
      mode: 'cloud-api',
      provider: 'openai-compatible',
      model: 'gpt-test',
      status: 'succeeded',
      startedAt: '2026-05-17T12:00:01.000Z',
      endedAt: '2026-05-17T12:00:02.000Z',
    },
  ]);
});

test('runQueueSymbolEnrichment persists failed attempts and rejects on terminal driver errors', async () => {
  const { projectRoot, symbol, worklist, worklistFile, dirs, symbolIndexFile } = await createQueueFixture();

  await assert.rejects(
    runQueueSymbolEnrichment({
      symbol,
      projectRoot,
      projectSlug: 'memory-context',
      timeoutMs: 30_000,
        enrichmentDir: dirs.enrichment,
        worklist,
        worklistFile,
        symbolIndex: {},
        symbolIndexFile,
        config: { preferredModes: ['local-model', 'cloud-api'] },
        providers: [],
      runEnrichmentWithFallbackImpl: async () => ({
        status: 'error',
        content: null,
        mode: null,
        provider: null,
        model: null,
        attempts: [
          {
            mode: 'local-model',
            provider: 'ollama',
            status: 'failed',
            errorType: 'network',
            errorMessage: 'ECONNREFUSED',
            startedAt: '2026-05-17T12:00:00.000Z',
            endedAt: '2026-05-17T12:00:01.000Z',
          },
          {
            mode: 'cloud-api',
            provider: 'openai-compatible',
            status: 'failed',
            errorType: 'rate-limit',
            errorMessage: '429 rate limit',
            startedAt: '2026-05-17T12:00:01.000Z',
            endedAt: '2026-05-17T12:00:02.000Z',
          },
        ],
      }),
    }),
    /429 rate limit/,
  );

  const updatedWorklist = await readJsonArtifact(worklistFile);
  assert.equal(updatedWorklist[0].status, 'error');
  assert.equal(updatedWorklist[0].lastModeUsed, 'cloud-api');
  assert.equal(updatedWorklist[0].error, '429 rate limit');
  assert.deepEqual(updatedWorklist[0].attempts, [
    {
      mode: 'local-model',
      provider: 'ollama',
      status: 'failed',
      errorType: 'network',
      errorMessage: 'ECONNREFUSED',
      startedAt: '2026-05-17T12:00:00.000Z',
      endedAt: '2026-05-17T12:00:01.000Z',
    },
    {
      mode: 'cloud-api',
      provider: 'openai-compatible',
      status: 'failed',
      errorType: 'rate-limit',
      errorMessage: '429 rate limit',
      startedAt: '2026-05-17T12:00:01.000Z',
      endedAt: '2026-05-17T12:00:02.000Z',
    },
  ]);

  const updatedIndex = await readJsonArtifact(symbolIndexFile);
  assert.equal(updatedIndex[symbol.symbolKey].status, 'error');
  assert.equal(updatedIndex[symbol.symbolKey].memoryId, null);
});

test('parseQueueConcurrency falls back to 1 on invalid values', () => {
  assert.equal(parseQueueConcurrency('0'), 1);
  assert.equal(parseQueueConcurrency('-4'), 1);
  assert.equal(parseQueueConcurrency('NaN'), 1);
  assert.equal(parseQueueConcurrency('3'), 3);
});

test('enrich wrapper exports runEnrichQueue', async () => {
  const mod = await import('../cli/enrich.mjs');
  assert.equal(typeof mod.runEnrichQueue, 'function');
});

test('enrich wrapper exports re-exports from enrich-queue', async () => {
  const mod = await import('../cli/enrich.mjs');
  assert.equal(typeof mod.runQueueSymbolEnrichment, 'function');
  assert.equal(typeof mod.buildQueueSummary, 'function');
  assert.equal(typeof mod.parseQueueConcurrency, 'function');
});

test('buildQueueSummary counts already_enriched entries as enriched in reports', () => {
  const summary = buildQueueSummary([
    { status: 'already_enriched' },
    { status: 'enriched' },
    { status: 'pending' },
    { status: 'error' },
  ]);

  assert.deepEqual(summary, {
    enriched: 2,
    errors: 1,
    pending: 1,
  });
});
