/**
 * N3 (accepted plan 3.3 / spec S9) — opt-in validated narrative queue flow.
 *
 * runQueueSymbolEnrichment keeps legacy text mode byte-for-byte when no
 * explicit narrativeContext is supplied: the driver request stays exactly
 * `{prompt, timeoutMs}` with no `format` key. With an explicit narrativeContext
 * the queue builds prompt v2, forwards the shared NARRATIVE_SCHEMA as the
 * structured-output `format`, validates provider output through the N1
 * generateValidatedNarrative helper (retrying schema-invalid output exactly
 * once), and persists only validated narrative content plus its summary.
 * Provider failures keep the existing fallback/error semantics and never get a
 * schema retry. The exported main() loop forwards narrative metadata to the
 * subagent route (promptVersion, schema, known graph keys) only when a
 * resolver explicitly supplies context; the default real queue stays legacy.
 */

import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runQueueSymbolEnrichment } from '../cli/enrich-queue.mjs';
import { ensureProjectMemoryContextDirs, readJsonArtifact } from '../src/artifacts.mjs';
import { loadSubagentQueue } from '../src/subagent-queue.mjs';
import { NARRATIVE_SCHEMA } from '../src/cards/narrative-schema.mjs';

const childProcess = createRequire(import.meta.url)('node:child_process');
let deniedNativeSpawns = [];
let originalChildProcessSpawn;
let ownedFixtureRoots = new Set();
let fixtureRootsCreated = 0;
let fixtureRootsRemoved = 0;

beforeEach(() => {
  originalChildProcessSpawn = childProcess.spawn;
  deniedNativeSpawns = [];
  ownedFixtureRoots = new Set();
  fixtureRootsCreated = 0;
  fixtureRootsRemoved = 0;
  childProcess.spawn = (...args) => {
    deniedNativeSpawns.push(args);
    throw new Error('Denied native spawn in test');
  };
  syncBuiltinESMExports();
});

afterEach(async () => {
  const failures = [];
  try {
    for (const root of ownedFixtureRoots) {
      try {
        await rm(root, { recursive: true, force: true });
        fixtureRootsRemoved += 1;
        await assert.rejects(access(root), { code: 'ENOENT' });
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      assert.equal(fixtureRootsRemoved, fixtureRootsCreated, 'every owned fixture root must be removed');
    } catch (error) {
      failures.push(error);
    }
  } finally {
    ownedFixtureRoots.clear();
    try {
      childProcess.spawn = originalChildProcessSpawn;
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        syncBuiltinESMExports();
      } catch (error) {
        failures.push(error);
      }
    }
  }

  if (failures.length) throw new AggregateError(failures, 'test teardown failed');
});

// N4 (plan 3.4 / spec S10) makes trivial symbols (getters, or fewer than 5
// lines without branching) skip the model entirely in explicit narrative mode.
// These fixtures exist to prove the provider/schema/retry loops, so the symbol
// must stay NON-TRIVIAL: six declared code lines with an actual branch.
const USER_TS = [
  "import { db } from './db';",
  '',
  'export async function getUser(id) {',
  '  if (!id) {',
  '    throw new TypeError(`getUser requires an id`);',
  '  }',
  '  return db.users.find(id);',
  '}',
  '',
].join('\n');

async function createQueueFixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-narrative-queue-'));
  ownedFixtureRoots.add(projectRoot);
  fixtureRootsCreated += 1;
  const dirs = await ensureProjectMemoryContextDirs(projectRoot);
  const sourceDir = join(projectRoot, 'src');
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, 'user.ts'), USER_TS, 'utf8');

  const symbol = {
    symbolKey: 'ts|src/user.ts|function|exported|getUser|3',
    name: 'getUser',
    kind: 'function',
    language: 'ts',
    filePath: 'src/user.ts',
    codeHash: 'hash-a',
    range: { startLine: 3, endLine: 8 },
    status: 'pending',
  };

  const worklistFile = join(dirs.enrichment, 'worklist.json');
  const symbolIndexFile = join(dirs.enrichment, 'symbol-index.json');
  const worklist = [structuredClone(symbol)];
  await writeJson(worklistFile, worklist);
  await writeJson(symbolIndexFile, {});

  return { projectRoot, dirs, symbol, worklist, worklistFile, symbolIndexFile };
}

async function writeJson(path, data) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function makeNarrativeContext() {
  return {
    symbolKeys: [
      'ts|src/user.ts|function|exported|getUser|3',
      'ts|src/db.ts|function|exported|find|1',
      'ts|src/api.ts|function|exported|listUsers|1',
    ],
    signature: 'export async function getUser(id)',
    role: { role: 'repository', layer: 'domain', confidence: 0.9, evidence: [] },
    callees: [
      { key: 'ts|src/db.ts|function|exported|find|1', name: 'find', summary: 'Returns one row by primary key.' },
    ],
    callers: [
      { key: 'ts|src/api.ts|function|exported|listUsers|1', name: 'listUsers', role: 'controller' },
    ],
    fileCardSummary: 'User lookup helpers for the API layer.',
    projectRules: ['Prefer repository helpers over raw queries.'],
  };
}

function validNarrative(overrides = {}) {
  return {
    summary: 'Looks up one user row by id.',
    behavior: ['Find the user row by id.'],
    sideEffects: [],
    errors: [],
    contracts: ['The id argument must be present.'],
    changeNotes: 'Keep the id lookup semantics when editing.',
    mentions: ['ts|src/db.ts|function|exported|find|1'],
    ...overrides,
  };
}

function succeededResult(content, { startedAt, endedAt, mode = 'local-model' } = {}) {
  return {
    status: 'succeeded',
    content,
    mode,
    provider: 'ollama',
    model: 'fixture-model',
    attempts: [
      {
        mode,
        provider: 'ollama',
        model: 'fixture-model',
        status: 'succeeded',
        startedAt: startedAt ?? '2026-10-13T12:00:00.000Z',
        endedAt: endedAt ?? '2026-10-13T12:00:01.000Z',
      },
    ],
  };
}

async function providerEventLines(enrichmentDir) {
  try {
    const raw = await readFile(join(enrichmentDir, 'provider-events.jsonl'), 'utf8');
    return raw.split('\n').filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function baseRunArgs(fixture, extra = {}) {
  const { projectRoot, dirs, symbol, worklist, worklistFile, symbolIndexFile } = fixture;
  return {
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
    ...extra,
  };
}

// -------------------------------------------------------------------
// Prompt-v2 opt-in through runQueueSymbolEnrichment
// -------------------------------------------------------------------

test('narrative mode forwards the NARRATIVE_SCHEMA format and persists only validated narrative content', async () => {
  const fixture = await createQueueFixture();
  const narrative = validNarrative();
  let receivedRequest;

  const result = await runQueueSymbolEnrichment(baseRunArgs(fixture, {
    narrativeContext: makeNarrativeContext(),
    runEnrichmentWithFallbackImpl: async ({ request }) => {
      receivedRequest = request;
      return succeededResult(JSON.stringify(narrative));
    },
  }));

  assert.deepEqual(Object.keys(receivedRequest).sort(), ['format', 'prompt', 'timeoutMs']);
  assert.deepEqual(receivedRequest.format, NARRATIVE_SCHEMA);
  assert.ok(receivedRequest.prompt.includes('Prompt version: v2'));

  assert.equal(result.status, 'enriched');
  assert.equal(result.promptVersion, 'v2');
  assert.equal(result.memoryContent, `${JSON.stringify(narrative, null, 2)}`);

  const memoryFile = join(fixture.dirs.enrichment, 'ts_src_user_ts_function_exported_getUser_3.memory.json');
  const memoryPayload = await readJsonArtifact(memoryFile);
  assert.deepEqual(JSON.parse(memoryPayload.content), narrative);

  const updatedWorklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(updatedWorklist[0].status, 'enriched');
  assert.equal(updatedWorklist[0].lastModeUsed, 'local-model');

  const updatedIndex = await readJsonArtifact(fixture.symbolIndexFile);
  assert.equal(updatedIndex[fixture.symbol.symbolKey].status, 'enriched');
  assert.equal(updatedIndex[fixture.symbol.symbolKey].semanticSummary, narrative.summary);

  assert.equal((await providerEventLines(fixture.dirs.enrichment)).length, 1);
});

test('legacy mode keeps the driver request to exactly prompt and timeoutMs with no format key', async () => {
  const fixture = await createQueueFixture();
  let receivedRequest;

  const result = await runQueueSymbolEnrichment(baseRunArgs(fixture, {
    runEnrichmentWithFallbackImpl: async ({ request }) => {
      receivedRequest = request;
      return succeededResult('Does the user lookup.');
    },
  }));

  assert.deepEqual(Object.keys(receivedRequest).sort(), ['prompt', 'timeoutMs']);
  assert.ok(!('format' in receivedRequest), 'legacy text requests must omit format entirely');
  assert.equal(result.status, 'enriched');
  assert.ok(!('promptVersion' in result), 'legacy result must not carry prompt metadata');
});

test('schema-invalid narrative output is retried exactly once and only validated output is persisted', async () => {
  const fixture = await createQueueFixture();
  const invalid = validNarrative({ mentions: ['ghost|missing|key'] });
  const valid = validNarrative();
  const calls = [];

  const result = await runQueueSymbolEnrichment(baseRunArgs(fixture, {
    narrativeContext: makeNarrativeContext(),
    runEnrichmentWithFallbackImpl: async ({ request }) => {
      calls.push(request);
      return calls.length === 1
        ? succeededResult(JSON.stringify(invalid), { startedAt: '2026-10-13T12:00:00.000Z', endedAt: '2026-10-13T12:00:00.500Z' })
        : succeededResult(JSON.stringify(valid), { startedAt: '2026-10-13T12:00:01.000Z', endedAt: '2026-10-13T12:00:01.500Z' });
    },
  }));

  assert.equal(calls.length, 2, 'schema-invalid output must be retried exactly once');
  assert.deepEqual(calls[1].format, NARRATIVE_SCHEMA, 'the retry must still request structured output');

  assert.equal(result.status, 'enriched');
  assert.equal(result.memoryContent, `${JSON.stringify(valid, null, 2)}`);
  assert.ok(!result.memoryContent.includes('ghost|missing|key'), 'invalid output must not reach persisted memory');

  const updatedWorklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(updatedWorklist[0].status, 'enriched');
  assert.equal(updatedWorklist[0].attempts.length, 2, 'attempts from both provider runs must be preserved');

  assert.equal((await providerEventLines(fixture.dirs.enrichment)).length, 2, 'both runs must log provider events');
});

test('twice-invalid narrative output marks error without writing memory or accepted summaries', async () => {
  const fixture = await createQueueFixture();
  const invalid = validNarrative({ mentions: ['ghost|missing|key'] });
  let calls = 0;

  await assert.rejects(
    runQueueSymbolEnrichment(baseRunArgs(fixture, {
      narrativeContext: makeNarrativeContext(),
      runEnrichmentWithFallbackImpl: async () => {
        calls += 1;
        return succeededResult(JSON.stringify(invalid), {
          startedAt: `2026-10-13T12:00:0${calls}.000Z`,
          endedAt: `2026-10-13T12:00:0${calls}.500Z`,
        });
      },
    })),
    (error) => {
      assert.match(error.message, /Narrative validation failed/);
      assert.match(error.message, /Mention does not exist in graph: ghost\|missing\|key/);
      return true;
    },
  );

  assert.equal(calls, 2, 'schema retries are bounded to one retry');

  const memoryFile = join(fixture.dirs.enrichment, 'ts_src_user_ts_function_exported_getUser_3.memory.json');
  await assert.rejects(access(memoryFile), { code: 'ENOENT' }, 'no invalid memory may be written');

  const updatedWorklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(updatedWorklist[0].status, 'error');
  assert.match(updatedWorklist[0].error, /Narrative validation failed/);
  assert.equal(updatedWorklist[0].attempts.length, 2);

  const updatedIndex = await readJsonArtifact(fixture.symbolIndexFile);
  assert.equal(updatedIndex[fixture.symbol.symbolKey].status, 'error');
  assert.equal(updatedIndex[fixture.symbol.symbolKey].memoryId, null);
  assert.ok(!updatedIndex[fixture.symbol.symbolKey].semanticSummary, 'no summary may be accepted from invalid output');

  assert.equal((await providerEventLines(fixture.dirs.enrichment)).length, 2);
});

test('provider failure in narrative mode keeps existing failure semantics without a schema retry', async () => {
  const fixture = await createQueueFixture();
  let calls = 0;

  await assert.rejects(
    runQueueSymbolEnrichment(baseRunArgs(fixture, {
      narrativeContext: makeNarrativeContext(),
      config: { preferredModes: ['local-model', 'cloud-api'] },
      runEnrichmentWithFallbackImpl: async () => {
        calls += 1;
        return {
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
              startedAt: '2026-10-13T12:00:00.000Z',
              endedAt: '2026-10-13T12:00:01.000Z',
            },
            {
              mode: 'cloud-api',
              provider: 'openai-compatible',
              status: 'failed',
              errorType: 'rate-limit',
              errorMessage: '429 rate limit',
              startedAt: '2026-10-13T12:00:01.000Z',
              endedAt: '2026-10-13T12:00:02.000Z',
            },
          ],
        };
      },
    })),
    /429 rate limit/,
  );

  assert.equal(calls, 1, 'provider failures must not be retried by the schema layer');

  const updatedWorklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(updatedWorklist[0].status, 'error');
  assert.equal(updatedWorklist[0].error, '429 rate limit');
  assert.equal(updatedWorklist[0].lastModeUsed, 'cloud-api');
  assert.equal(updatedWorklist[0].attempts.length, 2);

  const memoryFile = join(fixture.dirs.enrichment, 'ts_src_user_ts_function_exported_getUser_3.memory.json');
  await assert.rejects(access(memoryFile), { code: 'ENOENT' });
});

// -------------------------------------------------------------------
// main() loop forwarding — opt-in hooks end to end, default stays legacy
// -------------------------------------------------------------------

function stubConsole() {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => { logs.push(args.join(' ')); };
  console.error = (...args) => { errors.push(args.join(' ')); };
  return {
    logs,
    errors,
    restore() {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

function fixtureConfig() {
  return {
    preferredModes: ['local-model'],
    localModel: { provider: 'ollama', baseUrl: 'http://127.0.0.1:0', model: 'fixture-model' },
    subagentTokenThreshold: 5000,
    fileCoverageThreshold: 0.8,
  };
}

test('main loop forwards narrativeContext into the queue path and persists validated output end to end', async () => {
  const fixture = await createQueueFixture();
  const { main } = await import('../cli/enrich-queue.mjs');
  const narrative = validNarrative();
  const resolvedKeys = [];
  let receivedRequest;
  const consoleStub = stubConsole();

  // A stale symbol-level summary must never win over the validated output.
  const staleWorklist = await readJsonArtifact(fixture.worklistFile);
  staleWorklist[0].semanticSummary = 'Stale symbol override.';
  await writeJson(fixture.worklistFile, staleWorklist);

  try {
    await main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      narrativeResolver: async (symbol) => {
        resolvedKeys.push(symbol.symbolKey);
        return makeNarrativeContext();
      },
      countPromptTokensImpl: async () => 400,
      runEnrichmentWithFallbackImpl: async ({ request }) => {
        receivedRequest = request;
        return succeededResult(JSON.stringify(narrative));
      },
    });
  } finally {
    consoleStub.restore();
  }

  assert.deepEqual(resolvedKeys, [fixture.symbol.symbolKey], 'the resolver must receive the queued symbol');
  assert.deepEqual(receivedRequest.format, NARRATIVE_SCHEMA, 'the loop must forward structured-output format');
  assert.ok(receivedRequest.prompt.includes('Prompt version: v2'));

  const updatedWorklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(updatedWorklist[0].status, 'enriched');

  const memoryFile = join(fixture.dirs.enrichment, 'ts_src_user_ts_function_exported_getUser_3.memory.json');
  const memoryPayload = await readJsonArtifact(memoryFile);
  assert.deepEqual(JSON.parse(memoryPayload.content), narrative);

  // The validated summary must survive the final main index write, not only
  // the persist helper (S9 final-main contract).
  const finalIndex = await readJsonArtifact(fixture.symbolIndexFile);
  assert.equal(finalIndex[fixture.symbol.symbolKey].semanticSummary, narrative.summary);
  assert.notEqual(finalIndex[fixture.symbol.symbolKey].semanticSummary, 'Stale symbol override.');

  const queueState = await readJsonArtifact(join(fixture.dirs.enrichment, 'queue-state.json'));
  assert.equal(queueState.status, 'finished');

  assert.ok(
    deniedNativeSpawns.length >= 1,
    'finalize must attempt the background sync spawn through the deny patch, never a real process',
  );
});

test('main keeps prior accepted summary, memory and manifest when narrative output never validates', async () => {
  const fixture = await createQueueFixture();
  const { main } = await import('../cli/enrich-queue.mjs');
  const invalid = validNarrative({ mentions: ['ghost|missing|key'] });
  const memoryFile = join(fixture.dirs.enrichment, 'ts_src_user_ts_function_exported_getUser_3.memory.json');
  const manifestFile = join(fixture.dirs.enrichment, 'sync-manifest.json');
  await writeFile(memoryFile, 'accepted before\n', 'utf8');
  await writeFile(manifestFile, '{"entries":[]}\n', 'utf8');
  await writeJson(fixture.symbolIndexFile, {
    [fixture.symbol.symbolKey]: {
      memoryId: 'old-memory',
      graphNodeId: null,
      codeHash: 'hash-a',
      status: 'enriched',
      lastEnrichedAt: '2026-10-01T00:00:00.000Z',
      semanticSummary: 'Accepted before.',
    },
  });

  let calls = 0;
  // Fake child handles instead of real spawns: background sync and the
  // error-triggered retry must never create an actual process.
  const cp = createRequire(import.meta.url)('node:child_process');
  const deniedVersion = cp.spawn;
  cp.spawn = () => ({ pid: -1, unref() {} });
  syncBuiltinESMExports();
  const consoleStub = stubConsole();
  try {
    await main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      narrativeResolver: async () => makeNarrativeContext(),
      countPromptTokensImpl: async () => 1,
      runEnrichmentWithFallbackImpl: async () => {
        calls += 1;
        return succeededResult(JSON.stringify(invalid));
      },
    });
  } finally {
    consoleStub.restore();
    cp.spawn = deniedVersion;
    syncBuiltinESMExports();
  }

  assert.equal(calls, 2, 'schema retry stays bounded to one retry');

  const updatedWorklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(updatedWorklist[0].status, 'error');
  assert.match(updatedWorklist[0].error, /Narrative validation failed/);

  const finalIndex = await readJsonArtifact(fixture.symbolIndexFile);
  assert.equal(
    finalIndex[fixture.symbol.symbolKey].semanticSummary,
    'Accepted before.',
    'a failed narrative run must not overwrite the previously accepted index summary',
  );

  assert.equal(await readFile(memoryFile, 'utf8'), 'accepted before\n');
  assert.equal(await readFile(manifestFile, 'utf8'), '{"entries":[]}\n');
});

test('main loop forwards promptVersion, schema and known graph keys only on the subagent route', async () => {
  const fixture = await createQueueFixture();
  const { main } = await import('../cli/enrich-queue.mjs');
  const context = makeNarrativeContext();
  const resolvedKeys = [];
  let enrichmentCalls = 0;
  const consoleStub = stubConsole();

  try {
    await main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      narrativeResolver: async (symbol) => {
        resolvedKeys.push(symbol.symbolKey);
        return context;
      },
      countPromptTokensImpl: async () => 999_999,
      runEnrichmentWithFallbackImpl: async () => {
        enrichmentCalls += 1;
        return succeededResult('should not run');
      },
    });
  } finally {
    consoleStub.restore();
  }

  assert.equal(enrichmentCalls, 0, 'subagent-routed symbols must not hit the provider driver');

  const queue = await loadSubagentQueue(fixture.dirs.enrichment);
  assert.equal(queue.entries.length, 1);
  const entry = queue.entries[0];
  assert.equal(entry.status, 'pending');
  assert.equal(entry.promptVersion, 'v2');
  assert.deepEqual(entry.schema, NARRATIVE_SCHEMA);
  assert.deepEqual(entry.knownGraphKeys, [...context.symbolKeys]);
  assert.ok(entry.prompt.includes('Prompt version: v2'));
  assert.ok(entry.prompt.includes('- ts|src/db.ts|function|exported|find|1: Returns one row by primary key.'));

  const updatedWorklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(updatedWorklist[0].status, 'subagent-queued');
});

test('main loop without a narrative resolver builds the legacy queue request with no format key', async () => {
  const fixture = await createQueueFixture();
  const { main } = await import('../cli/enrich-queue.mjs');
  let receivedRequest;
  const consoleStub = stubConsole();

  try {
    await main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      countPromptTokensImpl: async () => 400,
      runEnrichmentWithFallbackImpl: async ({ request }) => {
        receivedRequest = request;
        return succeededResult('Does the user lookup.');
      },
    });
  } finally {
    consoleStub.restore();
  }

  assert.deepEqual(Object.keys(receivedRequest).sort(), ['prompt', 'timeoutMs']);
  assert.ok(!('format' in receivedRequest), 'the default queue flow must never request structured output');
  assert.ok(!receivedRequest.prompt.includes('Prompt version: v2'), 'the default prompt must stay legacy text');

  const updatedWorklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(updatedWorklist[0].status, 'enriched');
});

test('main loop subagent route without narrative context writes a legacy queue entry without schema metadata', async () => {
  const fixture = await createQueueFixture();
  const { main } = await import('../cli/enrich-queue.mjs');
  const consoleStub = stubConsole();

  try {
    await main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      countPromptTokensImpl: async () => 999_999,
      runEnrichmentWithFallbackImpl: async () => {
        throw new Error('legacy subagent route must not hit the provider driver');
      },
    });
  } finally {
    consoleStub.restore();
  }

  const queue = await loadSubagentQueue(fixture.dirs.enrichment);
  assert.equal(queue.entries.length, 1);
  const entry = queue.entries[0];
  assert.equal(entry.status, 'pending');
  assert.ok(!('promptVersion' in entry), 'legacy entries must not carry promptVersion');
  assert.ok(!('schema' in entry), 'legacy entries must not carry a schema');
  assert.ok(!('knownGraphKeys' in entry), 'legacy entries must not carry known graph keys');
  assert.ok(!entry.prompt.includes('Prompt version: v2'));

  const updatedWorklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(updatedWorklist[0].status, 'subagent-queued');
});
