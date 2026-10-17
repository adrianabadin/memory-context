/**
 * N4 C1 (retained R3-source-recheck blocker) — fail closed when the
 * trivial-template recheck disagrees with the queue's routing bypass.
 *
 * The exported main() loop may skip the Ollama tokenizer probe and the
 * subagent route based on the initial prompt-meta proof, while
 * runQueueSymbolEnrichment independently re-reads the symbol source. When
 * that fresh proof no longer justifies the bypass (the file was edited into
 * branching code, or disappeared), the runner must NEVER invoke a model
 * behind bypassed routing, and the queue must NEVER report a template /
 * "no model call" completion for a provider-backed result. The entry fails
 * closed through the existing error semantics: an honest English
 * source-changed/unavailable message, zero attempts (no fake provider
 * records), zero provider events, and previously accepted memory bytes,
 * index semanticSummary and sync-manifest bytes preserved for a later
 * normal-queue retry.
 *
 * Controls keep the surrounding contract honest: an unchanged trivial
 * symbol still templates with zero model calls and a success log bound to
 * the actual result; a direct runner caller that never bypassed routing
 * keeps the normal non-trivial provider fallback; a non-trivial main() run
 * keeps its tokenizer probe, schema-format request and provider output; and
 * the legacy text default keeps its exact request shape and bytes.
 *
 * Deterministic by construction: the "edit between the two reads" race is
 * reproduced with an owned-fixture readFile interception (second read of the
 * symbol path only) or an owned-fixture deletion — no timers, no sleeps.
 * Fixtures are owned temp roots removed in `finally`; child spawns are
 * faked (background sync / retry must never create an actual process) and
 * the provider driver is an injected counting stub — no network, no real
 * model, no production PMC state.
 */

import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { main, runQueueSymbolEnrichment } from '../cli/enrich-queue.mjs';
import { buildSymbolKey } from '../src/symbol-keys.mjs';
import { ensureProjectMemoryContextDirs, readJsonArtifact } from '../src/artifacts.mjs';
import { loadSubagentQueue } from '../src/subagent-queue.mjs';
import { NARRATIVE_SCHEMA } from '../src/cards/narrative-schema.mjs';

const childProcess = createRequire(import.meta.url)('node:child_process');
let originalChildProcessSpawn;
let ownedFixtureRoots = new Set();
let fixtureRootsCreated = 0;
let fixtureRootsRemoved = 0;

beforeEach(() => {
  originalChildProcessSpawn = childProcess.spawn;
  ownedFixtureRoots = new Set();
  fixtureRootsCreated = 0;
  fixtureRootsRemoved = 0;
  // Fake child handles instead of real spawns: the background sync and the
  // error-triggered retry must never create an actual process, but the retry
  // launch path tolerates handles, so a throwing spawn would mask queue
  // behavior instead of proving it.
  childProcess.spawn = () => ({ pid: -1, unref() {} });
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

// Three physical code lines, branch-free: trivial under plan 3.4.
const TRIVIAL_JS = [
  'export function add(a, b) {',
  '  return a + b;',
  '}',
  '',
].join('\n');

// Six declared lines with a real branch, plus padding that keeps file
// coverage below the subagent routing threshold for main() controls.
const BRANCHY_JS = [
  'export function classify(value) {',
  '  if (!value) {',
  "    throw new TypeError('value required');",
  '  }',
  "  return typeof value === 'string' ? 'text' : 'other';",
  '}',
  '// padding keeps file coverage below the subagent routing threshold',
  '// padding',
  '',
].join('\n');

const ACCEPTED_MEMORY = 'accepted before\n';
const ACCEPTED_MANIFEST = '{"entries":[]}\n';
const ACCEPTED_SUMMARY = 'Accepted before.';

function makeSymbol(overrides = {}) {
  const base = {
    name: 'add',
    kind: 'function',
    language: 'js',
    filePath: 'src/add.js',
    codeHash: 'hash-add',
    range: { startLine: 1, endLine: 3 },
    status: 'pending',
  };
  const symbol = { ...base, ...overrides };
  symbol.symbolKey = buildSymbolKey(symbol);
  return symbol;
}

function trivialSymbol() {
  return makeSymbol({ name: 'add', filePath: 'src/add.js', range: { startLine: 1, endLine: 3 } });
}

function branchySymbol() {
  return makeSymbol({
    name: 'classify',
    filePath: 'src/classify.js',
    codeHash: 'hash-classify',
    range: { startLine: 1, endLine: 6 },
  });
}

function narrativeContextFor(symbol) {
  return {
    symbolKeys: [symbol.symbolKey],
    signature: `export function ${symbol.name}()`,
    role: { role: 'util', layer: 'shared', confidence: 0.8, evidence: [] },
    callees: [],
    callers: [],
    fileCardSummary: 'Fixture module.',
    projectRules: [],
  };
}

async function createQueueFixture({ files, symbols, seedAccepted = false }) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-n4-c1-'));
  ownedFixtureRoots.add(projectRoot);
  fixtureRootsCreated += 1;
  const dirs = await ensureProjectMemoryContextDirs(projectRoot);
  for (const [relPath, content] of Object.entries(files)) {
    await mkdir(join(projectRoot, dirname(relPath)), { recursive: true });
    await writeFile(join(projectRoot, relPath), content, 'utf8');
  }

  const worklistFile = join(dirs.enrichment, 'worklist.json');
  const symbolIndexFile = join(dirs.enrichment, 'symbol-index.json');
  await writeJson(worklistFile, symbols.map((symbol) => structuredClone(symbol)));
  await writeJson(symbolIndexFile, {});

  if (seedAccepted) {
    // Previously accepted enrichment artifacts that a fail-closed run must
    // leave byte-identical.
    for (const symbol of symbols) {
      const memoryFile = join(dirs.enrichment, `${symbol.symbolKey.replace(/[^a-zA-Z0-9_-]+/g, '_')}.memory.json`);
      await writeFile(memoryFile, ACCEPTED_MEMORY, 'utf8');
    }
    await writeFile(join(dirs.enrichment, 'sync-manifest.json'), ACCEPTED_MANIFEST, 'utf8');
    await writeJson(symbolIndexFile, Object.fromEntries(symbols.map((symbol) => [symbol.symbolKey, {
      memoryId: 'old-memory',
      graphNodeId: null,
      codeHash: symbol.codeHash,
      status: 'enriched',
      lastEnrichedAt: '2026-10-01T00:00:00.000Z',
      semanticSummary: ACCEPTED_SUMMARY,
    }])));
  }

  return { projectRoot, dirs, worklistFile, symbolIndexFile, symbols };
}

async function writeJson(path, data) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function fixtureConfig() {
  return {
    preferredModes: ['local-model'],
    localModel: { provider: 'ollama', baseUrl: 'http://127.0.0.1:0', model: 'fixture-model' },
    subagentTokenThreshold: 5000,
    fileCoverageThreshold: 0.8,
  };
}

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

function providerNarrative() {
  return {
    summary: 'Provider result summary.',
    behavior: ['Provider behavior.'],
    sideEffects: [],
    errors: [],
    contracts: [],
    changeNotes: 'Check behavior.',
    mentions: [],
  };
}

function countingProviderStub(calls) {
  return async ({ request }) => {
    calls.requests.push(request);
    calls.provider += 1;
    return {
      status: 'succeeded',
      content: JSON.stringify(providerNarrative()),
      mode: 'local-model',
      provider: 'ollama',
      model: 'fixture-model',
      attempts: [
        {
          mode: 'local-model',
          provider: 'ollama',
          model: 'fixture-model',
          status: 'succeeded',
          startedAt: '2026-10-14T12:00:00.000Z',
          endedAt: '2026-10-14T12:00:01.000Z',
        },
      ],
    };
  };
}

async function memoryFileOf(dirs, symbol) {
  return join(dirs.enrichment, `${symbol.symbolKey.replace(/[^a-zA-Z0-9_-]+/g, '_')}.memory.json`);
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

/**
 * Deterministically reproduce "the file changed between the queue's initial
 * proof read and the runner's independent recheck read": only reads of the
 * exact symbol path are intercepted, the first read (buildSymbolPromptMeta)
 * sees the original bytes, and every later read returns the mutated content
 * — or throws ENOENT when the fixture file "disappeared". All other reads
 * pass through untouched.
 */
async function withMutatedRecheckRead(symbolPath, recheckOutcome, fn) {
  const fsp = createRequire(import.meta.url)('node:fs/promises');
  const originalReadFile = fsp.readFile;
  let symbolReads = 0;
  fsp.readFile = async (path, ...rest) => {
    if (String(path) === String(symbolPath)) {
      symbolReads += 1;
      if (symbolReads >= 2) {
        if (recheckOutcome === 'gone') {
          const error = new Error(`ENOENT: no such file or directory, open '${path}'`);
          error.code = 'ENOENT';
          throw error;
        }
        return recheckOutcome;
      }
    }
    return originalReadFile(path, ...rest);
  };
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    fsp.readFile = originalReadFile;
    syncBuiltinESMExports();
  }
}

async function baseRunArgs(fixture, symbol, extra = {}) {
  return {
    symbol,
    projectRoot: fixture.projectRoot,
    projectSlug: 'n4-c1',
    timeoutMs: 30_000,
    enrichmentDir: fixture.dirs.enrichment,
    worklist: await readJsonArtifact(fixture.worklistFile),
    worklistFile: fixture.worklistFile,
    symbolIndex: await readJsonArtifact(fixture.symbolIndexFile),
    symbolIndexFile: fixture.symbolIndexFile,
    config: { preferredModes: ['local-model'] },
    providers: [],
    ...extra,
  };
}

// -------------------------------------------------------------------
// Blocker reproduction: the initial routing bypass must never be followed
// by a model call or a template/no-model success claim when the fresh
// source proof no longer justifies it.
// -------------------------------------------------------------------

test('C1 runner fails closed with zero provider calls when the bypass flag meets a now-branching source', async () => {
  // The fixture file holds branching code while the caller (the main loop's
  // earlier read) already bypassed routing on the previous trivial proof.
  const fixture = await createQueueFixture({ files: { 'src/add.js': BRANCHY_JS }, symbols: [trivialSymbol()], seedAccepted: true });
  const symbol = trivialSymbol();
  const calls = { provider: 0, requests: [] };

  await assert.rejects(
    runQueueSymbolEnrichment(await baseRunArgs(fixture, symbol, {
      narrativeContext: narrativeContextFor(symbol),
      expectTrivialTemplate: true,
      runEnrichmentWithFallbackImpl: countingProviderStub(calls),
    })),
    (error) => {
      assert.match(error.message, /source changed or became unavailable/);
      assert.match(error.message, /retry/i);
      return true;
    },
  );

  assert.equal(calls.provider, 0, 'no provider invocation may happen behind bypassed routing');
  assert.deepEqual(calls.requests, []);

  const updatedWorklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(updatedWorklist[0].status, 'error');
  assert.match(updatedWorklist[0].error, /source changed or became unavailable/);
  assert.ok(!('attempts' in updatedWorklist[0]), 'no fake provider attempt records may be invented');
  assert.equal(updatedWorklist[0].lastModeUsed, undefined, 'no enrichment mode was used');

  const updatedIndex = await readJsonArtifact(fixture.symbolIndexFile);
  // Pre-existing merge contract (N3 B1): a previously accepted disk-enriched
  // index record survives error updates with its summary intact — the
  // fail-closed run must not clobber accepted enrichment state. The honest
  // error state lives on the worklist entry above.
  assert.equal(updatedIndex[symbol.symbolKey].status, 'enriched', 'the accepted index record is preserved');
  assert.equal(updatedIndex[symbol.symbolKey].memoryId, 'old-memory');
  assert.equal(
    updatedIndex[symbol.symbolKey].semanticSummary,
    ACCEPTED_SUMMARY,
    'the previously accepted summary must survive the fail-closed error',
  );

  assert.equal(await readFile(await memoryFileOf(fixture.dirs, symbol), 'utf8'), ACCEPTED_MEMORY, 'accepted memory bytes stay untouched');
  assert.equal(await readFile(join(fixture.dirs.enrichment, 'sync-manifest.json'), 'utf8'), ACCEPTED_MANIFEST, 'the sync manifest stays untouched');
  assert.deepEqual(await providerEventLines(fixture.dirs.enrichment), [], 'no provider events may be logged');
});

test('C1 runner fails closed with zero provider calls when the bypass flag meets a vanished source', async () => {
  const fixture = await createQueueFixture({ files: { 'src/add.js': TRIVIAL_JS }, symbols: [trivialSymbol()], seedAccepted: true });
  const symbol = trivialSymbol();
  const calls = { provider: 0, requests: [] };
  await rm(join(fixture.projectRoot, 'src/add.js'));

  await assert.rejects(
    runQueueSymbolEnrichment(await baseRunArgs(fixture, symbol, {
      // The routing bypass always arrives with a prebuilt prompt from main().
      prompt: 'prebuilt v2 prompt from the initial trivial proof',
      narrativeContext: narrativeContextFor(symbol),
      expectTrivialTemplate: true,
      runEnrichmentWithFallbackImpl: countingProviderStub(calls),
    })),
    /source changed or became unavailable/,
  );

  assert.equal(calls.provider, 0, 'an unavailable source must not fall through to the provider');

  const updatedWorklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(updatedWorklist[0].status, 'error');
  assert.ok(!('attempts' in updatedWorklist[0]));
  assert.equal(await readFile(await memoryFileOf(fixture.dirs, symbol), 'utf8'), ACCEPTED_MEMORY);
  assert.equal(await readFile(join(fixture.dirs.enrichment, 'sync-manifest.json'), 'utf8'), ACCEPTED_MANIFEST);
});

test('C1 main fails closed when the source turns branching between its proof read and the runner recheck', async () => {
  const fixture = await createQueueFixture({ files: { 'src/add.js': TRIVIAL_JS }, symbols: [trivialSymbol()], seedAccepted: true });
  const symbol = trivialSymbol();
  const calls = { provider: 0, requests: [] };
  const tokenizerCalls = [];
  const consoleStub = stubConsole();

  try {
    await withMutatedRecheckRead(
      resolve(fixture.projectRoot, 'src/add.js'),
      BRANCHY_JS,
      () => main({
        projectRoot: fixture.projectRoot,
        config: fixtureConfig(),
        providers: [],
        narrativeResolver: async () => narrativeContextFor(symbol),
        countPromptTokensImpl: async (input) => {
          tokenizerCalls.push(input);
          return 400;
        },
        runEnrichmentWithFallbackImpl: countingProviderStub(calls),
      }),
    );
  } finally {
    consoleStub.restore();
  }

  assert.equal(tokenizerCalls.length, 0, 'the initial bypass still skips the tokenizer probe');
  assert.equal(calls.provider, 0, 'the invalidated bypass must never reach the provider');
  assert.equal((await loadSubagentQueue(fixture.dirs.enrichment)).entries.length, 0, 'and never the subagent route');

  const allOutput = [...consoleStub.logs, ...consoleStub.errors].join('\n');
  assert.ok(!/no model call/i.test(allOutput), 'the queue must never report a no-model success for an invalidated bypass');
  assert.ok(!/template narrative/i.test(allOutput), 'the queue must never report a template completion for an invalidated bypass');
  assert.ok(/source changed or became unavailable/.test(allOutput), 'the failure message must be reported');

  const finalSummary = JSON.parse(consoleStub.logs[consoleStub.logs.length - 1]);
  // Pre-existing semantics: `complete` means the queue finished processing;
  // errors are reported separately and never masked as successes.
  assert.equal(finalSummary.complete, true);
  assert.equal(finalSummary.enriched, 0, 'an invalidated bypass must never be counted as enriched');
  assert.equal(finalSummary.errors, 1);

  const updatedWorklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(updatedWorklist[0].status, 'error');
  assert.match(updatedWorklist[0].error, /source changed or became unavailable/);
  assert.ok(!('attempts' in updatedWorklist[0]));

  const finalIndex = await readJsonArtifact(fixture.symbolIndexFile);
  assert.equal(finalIndex[symbol.symbolKey].status, 'enriched', 'the accepted index record survives the fail-closed run (pre-existing merge contract)');
  assert.equal(
    finalIndex[symbol.symbolKey].semanticSummary,
    ACCEPTED_SUMMARY,
    'the final main index state keeps the previously accepted summary (S9 B1 contract)',
  );

  assert.equal(await readFile(await memoryFileOf(fixture.dirs, symbol), 'utf8'), ACCEPTED_MEMORY);
  assert.equal(await readFile(join(fixture.dirs.enrichment, 'sync-manifest.json'), 'utf8'), ACCEPTED_MANIFEST);
  assert.deepEqual(await providerEventLines(fixture.dirs.enrichment), []);
});

test('C1 main fails closed when the source disappears between its proof read and the runner recheck', async () => {
  const fixture = await createQueueFixture({ files: { 'src/add.js': TRIVIAL_JS }, symbols: [trivialSymbol()], seedAccepted: true });
  const symbol = trivialSymbol();
  const calls = { provider: 0, requests: [] };
  const consoleStub = stubConsole();

  try {
    await withMutatedRecheckRead(
      resolve(fixture.projectRoot, 'src/add.js'),
      'gone',
      () => main({
        projectRoot: fixture.projectRoot,
        config: fixtureConfig(),
        providers: [],
        narrativeResolver: async () => narrativeContextFor(symbol),
        countPromptTokensImpl: async () => 400,
        runEnrichmentWithFallbackImpl: countingProviderStub(calls),
      }),
    );
  } finally {
    consoleStub.restore();
  }

  assert.equal(calls.provider, 0, 'a vanished source must never fall through to the provider');
  const allOutput = [...consoleStub.logs, ...consoleStub.errors].join('\n');
  assert.ok(!/no model call/i.test(allOutput));
  assert.ok(/source changed or became unavailable/.test(allOutput));

  const finalSummary = JSON.parse(consoleStub.logs[consoleStub.logs.length - 1]);
  assert.equal(finalSummary.enriched, 0);
  assert.equal(finalSummary.errors, 1);

  const updatedWorklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(updatedWorklist[0].status, 'error');
  assert.equal(await readFile(await memoryFileOf(fixture.dirs, symbol), 'utf8'), ACCEPTED_MEMORY);
});

// -------------------------------------------------------------------
// Controls: the surrounding S10/S9 contract stays byte-for-byte honest.
// -------------------------------------------------------------------

test('control: an unchanged trivial symbol still templates with zero model calls and a result-bound success log', async () => {
  const fixture = await createQueueFixture({ files: { 'src/add.js': TRIVIAL_JS }, symbols: [trivialSymbol()] });
  const symbol = trivialSymbol();
  const calls = { provider: 0, requests: [] };
  const tokenizerCalls = [];
  const consoleStub = stubConsole();

  try {
    await main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      narrativeResolver: async () => narrativeContextFor(symbol),
      countPromptTokensImpl: async (input) => {
        tokenizerCalls.push(input);
        return 400;
      },
      runEnrichmentWithFallbackImpl: countingProviderStub(calls),
    });
  } finally {
    consoleStub.restore();
  }

  assert.equal(tokenizerCalls.length, 0);
  assert.equal(calls.provider, 0);
  assert.equal((await loadSubagentQueue(fixture.dirs.enrichment)).entries.length, 0);

  const allOutput = [...consoleStub.logs, ...consoleStub.errors].join('\n');
  assert.ok(/template narrative/.test(allOutput), 'a real template result reports the template path');
  assert.ok(/no model call/.test(allOutput), 'the no-model claim is bound to the actual template result');

  const finalSummary = JSON.parse(consoleStub.logs[consoleStub.logs.length - 1]);
  assert.equal(finalSummary.enriched, 1);
  assert.equal(finalSummary.errors, 0);

  const updatedWorklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(updatedWorklist[0].status, 'enriched');

  const memoryPayload = JSON.parse(await readFile(await memoryFileOf(fixture.dirs, symbol), 'utf8'));
  const persisted = JSON.parse(memoryPayload.content);
  assert.deepEqual(persisted.mentions, [symbol.symbolKey], 'the template persists with the authoritative mention');
  assert.deepEqual(persisted.sideEffects, []);

  const finalIndex = await readJsonArtifact(fixture.symbolIndexFile);
  assert.equal(finalIndex[symbol.symbolKey].semanticSummary, persisted.summary);
});

test('control: a direct runner caller without the bypass flag keeps the normal non-trivial provider flow', async () => {
  const fixture = await createQueueFixture({ files: { 'src/classify.js': BRANCHY_JS }, symbols: [branchySymbol()] });
  const symbol = branchySymbol();
  const calls = { provider: 0, requests: [] };

  const result = await runQueueSymbolEnrichment(await baseRunArgs(fixture, symbol, {
    narrativeContext: narrativeContextFor(symbol),
    runEnrichmentWithFallbackImpl: countingProviderStub(calls),
  }));

  assert.equal(result.status, 'enriched');
  assert.equal(calls.provider, 1, 'no bypass flag means the standard provider fallback stays available');
  assert.deepEqual(Object.keys(calls.requests[0]).sort(), ['format', 'prompt', 'timeoutMs']);
  assert.deepEqual(calls.requests[0].format, NARRATIVE_SCHEMA);

  const memoryPayload = JSON.parse(await readFile(await memoryFileOf(fixture.dirs, symbol), 'utf8'));
  assert.deepEqual(JSON.parse(memoryPayload.content), providerNarrative(), 'the provider output persists unchanged');

  const updatedWorklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(updatedWorklist[0].status, 'enriched');
  assert.equal(updatedWorklist[0].attempts.length, 1, 'real provider attempts are still recorded honestly');
});

test('control: a non-trivial main run keeps its tokenizer probe, schema request and provider output', async () => {
  const fixture = await createQueueFixture({ files: { 'src/classify.js': BRANCHY_JS }, symbols: [branchySymbol()] });
  const symbol = branchySymbol();
  const calls = { provider: 0, requests: [] };
  const tokenizerCalls = [];
  const consoleStub = stubConsole();

  try {
    await main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      narrativeResolver: async () => narrativeContextFor(symbol),
      countPromptTokensImpl: async (input) => {
        tokenizerCalls.push(input);
        return 400;
      },
      runEnrichmentWithFallbackImpl: countingProviderStub(calls),
    });
  } finally {
    consoleStub.restore();
  }

  assert.equal(tokenizerCalls.length, 1, 'non-trivial symbols keep the tokenizer probe');
  assert.equal(calls.provider, 1);
  assert.deepEqual(Object.keys(calls.requests[0]).sort(), ['format', 'prompt', 'timeoutMs']);
  assert.deepEqual(calls.requests[0].format, NARRATIVE_SCHEMA);

  const allOutput = [...consoleStub.logs, ...consoleStub.errors].join('\n');
  assert.ok(/ tokens/.test(allOutput), 'the provider-backed DONE line keeps its token reporting');
  assert.ok(!/template narrative/.test(allOutput));

  const finalSummary = JSON.parse(consoleStub.logs[consoleStub.logs.length - 1]);
  assert.equal(finalSummary.enriched, 1);

  const memoryPayload = JSON.parse(await readFile(await memoryFileOf(fixture.dirs, symbol), 'utf8'));
  assert.deepEqual(JSON.parse(memoryPayload.content), providerNarrative());
});

test('control: the legacy text default keeps its exact request shape, bytes and attempt records', async () => {
  const fixture = await createQueueFixture({ files: { 'src/add.js': TRIVIAL_JS }, symbols: [trivialSymbol()] });
  const symbol = trivialSymbol();
  const calls = { provider: 0, requests: [] };
  const tokenizerCalls = [];
  const consoleStub = stubConsole();

  try {
    await main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      countPromptTokensImpl: async (input) => {
        tokenizerCalls.push(input);
        return 400;
      },
      runEnrichmentWithFallbackImpl: async ({ request }) => {
        calls.requests.push(request);
        calls.provider += 1;
        return {
          status: 'succeeded',
          content: 'Legacy enrichment text.',
          mode: 'local-model',
          attempts: [
            {
              mode: 'local-model',
              provider: 'ollama',
              model: 'fixture-model',
              status: 'succeeded',
              startedAt: '2026-10-14T12:00:00.000Z',
              endedAt: '2026-10-14T12:00:01.000Z',
            },
          ],
        };
      },
    });
  } finally {
    consoleStub.restore();
  }

  assert.equal(tokenizerCalls.length, 1, 'the legacy flow keeps its tokenizer probe');
  assert.equal(calls.provider, 1);
  assert.deepEqual(Object.keys(calls.requests[0]).sort(), ['prompt', 'timeoutMs']);
  assert.ok(!('format' in calls.requests[0]), 'legacy requests never gain a format key');

  const memoryPayload = await readJsonArtifact(await memoryFileOf(fixture.dirs, symbol));
  assert.equal(memoryPayload.content, 'Legacy enrichment text.', 'legacy enrichment text persists verbatim');

  const updatedWorklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(updatedWorklist[0].status, 'enriched');
  assert.equal(updatedWorklist[0].attempts.length, 1, 'legacy attempt records are unchanged');
  assert.equal(updatedWorklist[0].lastModeUsed, 'local-model');

  const allOutput = [...consoleStub.logs, ...consoleStub.errors].join('\n');
  assert.ok(!/template narrative/.test(allOutput), 'the legacy flow never reports template completions');
});
