/**
 * F3 N4 (accepted plan 3.4 / spec S10) — trivial-template queue/main fast path.
 *
 * In explicit narrative mode (opt-in via narrativeContext / narrativeResolver
 * only), a structurally proven trivial symbol persists the deterministic
 * template narrative with ZERO model calls: the Ollama tokenizer probe, the
 * provider/fallback driver and the subagent route are all skipped before any
 * model-bound work. Attempts stay empty (no pseudo-LLM attempt records), and
 * the memory file, worklist status, symbol-index summary, sync manifest and
 * queue state keep the exact N3 persisted shapes. Non-trivial narrative
 * symbols keep the normal tokenizer/routing behavior, and the legacy text
 * flow — no resolver, no narrativeContext — keeps its exact request shape,
 * outputs and provider behavior byte-for-byte.
 */

import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildSymbolPromptMeta,
  main,
  runQueueSymbolEnrichment,
} from '../cli/enrich-queue.mjs';
import { ensureProjectMemoryContextDirs, readJsonArtifact } from '../src/artifacts.mjs';
import { loadSubagentQueue } from '../src/subagent-queue.mjs';
import { NARRATIVE_SCHEMA, validateNarrative } from '../src/cards/narrative-schema.mjs';
import { tryBuildTrivialNarrative } from '../src/cards/trivial-template.mjs';

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

// Three physical code lines, branch-free: a trivial symbol under plan 3.4.
const TRIVIAL_JS = [
  'export function add(a, b) {',
  '  return a + b;',
  '}',
  '',
].join('\n');

// Six declared lines with a real branch: non-trivial, keeps normal routing.
const BRANCHY_JS = [
  'export function classify(value) {',
  '  if (!value) {',
  "    throw new TypeError('value required');",
  '  }',
  "  return typeof value === 'string' ? 'text' : 'other';",
  '}',
  '',
].join('\n');

const TRIVIAL_KEY = 'js|src/add.js|function|exported|add|2';
const BRANCHY_KEY = 'js|src/classify.js|function|exported|classify|1';

function trivialSymbol() {
  return {
    symbolKey: TRIVIAL_KEY,
    name: 'add',
    kind: 'function',
    language: 'js',
    filePath: 'src/add.js',
    codeHash: 'hash-add',
    range: { startLine: 1, endLine: 3 },
    status: 'pending',
  };
}

function branchySymbol() {
  return {
    symbolKey: BRANCHY_KEY,
    name: 'classify',
    kind: 'function',
    language: 'js',
    filePath: 'src/classify.js',
    codeHash: 'hash-classify',
    range: { startLine: 1, endLine: 6 },
    status: 'pending',
  };
}

function narrativeContextFor(symbol, extra = {}) {
  return {
    symbolKeys: [symbol.symbolKey],
    signature: `export function ${symbol.name}()`,
    role: { role: 'util', layer: 'shared', confidence: 0.8, evidence: [] },
    callees: [],
    callers: [],
    fileCardSummary: 'Fixture module.',
    projectRules: [],
    ...extra,
  };
}

async function createQueueFixture({ files, symbols }) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-n4-template-'));
  ownedFixtureRoots.add(projectRoot);
  fixtureRootsCreated += 1;
  const dirs = await ensureProjectMemoryContextDirs(projectRoot);
  for (const [relPath, content] of Object.entries(files)) {
    await mkdir(join(projectRoot, join(relPath, '..')), { recursive: true });
    await writeFile(join(projectRoot, relPath), content, 'utf8');
  }

  const worklistFile = join(dirs.enrichment, 'worklist.json');
  const symbolIndexFile = join(dirs.enrichment, 'symbol-index.json');
  await writeJson(worklistFile, symbols.map((symbol) => structuredClone(symbol)));
  await writeJson(symbolIndexFile, {});

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

function succeededTextResult(content) {
  return {
    status: 'succeeded',
    content,
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
}

async function memoryFileOf(fixture, symbol) {
  return join(fixture.dirs.enrichment, `${symbol.symbolKey.replace(/[^a-zA-Z0-9_-]+/g, '_')}.memory.json`);
}

// -------------------------------------------------------------------
// Helper seam: buildSymbolPromptMeta attaches typed template metadata
// -------------------------------------------------------------------

test('buildSymbolPromptMeta attaches typed trivial metadata in narrative mode and keeps the prompt contract', async () => {
  const fixture = await createQueueFixture({ files: { 'src/add.js': TRIVIAL_JS }, symbols: [trivialSymbol()] });
  const context = narrativeContextFor(trivialSymbol());

  const result = await buildSymbolPromptMeta(trivialSymbol(), fixture.projectRoot, { narrativeContext: context });

  assert.ok(result.prompt.includes('Prompt version: v2'), 'the fast path metadata never replaces the prompt contract');
  assert.deepEqual(result.schema, NARRATIVE_SCHEMA);
  assert.equal(result.trivial.proof.kind, 'branch-free');
  assert.equal(result.trivial.proof.lineCount, 3);
  assert.deepEqual(
    validateNarrative(result.trivial.narrative, { symbolKeys: new Set([TRIVIAL_KEY]) }),
    { valid: true, errors: [] },
    'the template narrative must validate against the same N1 schema and known keys before any persistence',
  );
});

test('legacy two-argument buildSymbolPromptMeta stays exactly {prompt, totalLines} with no trivial key', async () => {
  const fixture = await createQueueFixture({ files: { 'src/add.js': TRIVIAL_JS }, symbols: [trivialSymbol()] });

  const result = await buildSymbolPromptMeta(trivialSymbol(), fixture.projectRoot);

  assert.deepEqual(Object.keys(result).sort(), ['prompt', 'totalLines']);
  assert.ok(!result.prompt.includes('Prompt version: v2'));
});

// -------------------------------------------------------------------
// Queue seam: runQueueSymbolEnrichment persists the template itself
// -------------------------------------------------------------------

test('runQueueSymbolEnrichment derives the template with zero driver calls and the exact N3 persistence shapes', async () => {
  const fixture = await createQueueFixture({ files: { 'src/add.js': TRIVIAL_JS }, symbols: [trivialSymbol()] });
  const symbol = trivialSymbol();
  const worklist = await readJsonArtifact(fixture.worklistFile);
  let driverCalls = 0;

  const result = await runQueueSymbolEnrichment({
    symbol,
    projectRoot: fixture.projectRoot,
    projectSlug: 'n4-fixture',
    timeoutMs: 30_000,
    enrichmentDir: fixture.dirs.enrichment,
    worklist,
    worklistFile: fixture.worklistFile,
    symbolIndex: {},
    symbolIndexFile: fixture.symbolIndexFile,
    config: { preferredModes: ['local-model'] },
    providers: [],
    narrativeContext: narrativeContextFor(symbol),
    runEnrichmentWithFallbackImpl: async () => {
      driverCalls += 1;
      throw new Error('the provider driver must not run for a proven trivial symbol');
    },
  });

  assert.equal(driverCalls, 0, 'zero model calls means zero provider driver invocations');
  assert.equal(result.status, 'enriched');
  assert.equal(result.trivial.kind, 'branch-free');
  assert.deepEqual(result.attempts, [], 'template results carry no pseudo-LLM attempts');
  assert.equal(result.promptVersion, 'v2');
  assert.equal(result.semanticSummary, JSON.parse(result.memoryContent).summary, 'the validated summary is the persisted template summary');

  const memoryFile = await memoryFileOf(fixture, symbol);
  const memoryPayload = await readJsonArtifact(memoryFile);
  const persisted = JSON.parse(memoryPayload.content);
  assert.deepEqual(persisted, JSON.parse(result.memoryContent));
  assert.deepEqual(persisted.mentions, [TRIVIAL_KEY], 'mentions stay inside the authoritative known keys');
  assert.deepEqual(validateNarrative(persisted, { symbolKeys: new Set([TRIVIAL_KEY]) }), { valid: true, errors: [] });

  const updatedWorklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(updatedWorklist[0].status, 'enriched');
  assert.ok(!('attempts' in updatedWorklist[0]), 'no provider attempts may be invented for a template run');
  assert.ok(!('lastModeUsed' in updatedWorklist[0]), 'no enrichment mode was used');

  const updatedIndex = await readJsonArtifact(fixture.symbolIndexFile);
  assert.equal(updatedIndex[TRIVIAL_KEY].status, 'enriched');
  assert.equal(updatedIndex[TRIVIAL_KEY].semanticSummary, persisted.summary);

  const manifest = await readJsonArtifact(join(fixture.dirs.enrichment, 'sync-manifest.json'));
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0].action, 'upsert');
  assert.equal(manifest.entries[0].symbolKey, TRIVIAL_KEY);

  await assert.rejects(access(join(fixture.dirs.enrichment, 'provider-events.jsonl')), { code: 'ENOENT' });
});

// -------------------------------------------------------------------
// Actual main(): zero tokenizer, provider and subagent calls end to end
// -------------------------------------------------------------------

test('main persists the template with zero tokenizer, provider and subagent calls end to end', async () => {
  const fixture = await createQueueFixture({ files: { 'src/add.js': TRIVIAL_JS }, symbols: [trivialSymbol()] });
  const tokenizerCalls = [];
  const providerCalls = [];
  const consoleStub = stubConsole();

  try {
    await main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      narrativeResolver: async () => narrativeContextFor(trivialSymbol()),
      countPromptTokensImpl: async (input) => {
        tokenizerCalls.push(input);
        return 400;
      },
      runEnrichmentWithFallbackImpl: async () => {
        providerCalls.push(1);
        throw new Error('the provider driver must not run for a proven trivial symbol');
      },
    });
  } finally {
    consoleStub.restore();
  }

  assert.equal(tokenizerCalls.length, 0, 'the fast path must precede the Ollama tokenizer probe');
  assert.equal(providerCalls.length, 0, 'the fast path must precede provider/fallback');
  assert.ok(deniedNativeSpawns.length >= 1, 'finalize must attempt the background sync spawn through the deny patch');

  const queue = await loadSubagentQueue(fixture.dirs.enrichment);
  assert.equal(queue.entries.length, 0, 'the fast path must precede the subagent route');

  const finalSummary = JSON.parse(consoleStub.logs[consoleStub.logs.length - 1]);
  assert.equal(finalSummary.complete, true);
  assert.equal(finalSummary.total, 1);
  assert.equal(finalSummary.enriched, 1);
  assert.equal(finalSummary.errors, 0);
  assert.equal(finalSummary.subagentQueued, 0);

  const expected = await tryBuildTrivialNarrative({
    symbol: trivialSymbol(),
    projectRoot: fixture.projectRoot,
    knownKeys: new Set([TRIVIAL_KEY]),
  });

  const memoryPayload = await readJsonArtifact(await memoryFileOf(fixture, trivialSymbol()));
  assert.deepEqual(JSON.parse(memoryPayload.content), expected.narrative, 'persisted content is exactly the deterministic template');

  const updatedWorklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(updatedWorklist[0].status, 'enriched');
  assert.ok(!('attempts' in updatedWorklist[0]));

  const finalIndex = await readJsonArtifact(fixture.symbolIndexFile);
  assert.equal(finalIndex[TRIVIAL_KEY].status, 'enriched');
  assert.equal(finalIndex[TRIVIAL_KEY].semanticSummary, expected.narrative.summary);

  const manifest = await readJsonArtifact(join(fixture.dirs.enrichment, 'sync-manifest.json'));
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0].symbolKey, TRIVIAL_KEY);

  const queueState = await readJsonArtifact(join(fixture.dirs.enrichment, 'queue-state.json'));
  assert.equal(queueState.status, 'finished');

  await assert.rejects(access(join(fixture.dirs.enrichment, 'provider-events.jsonl')), { code: 'ENOENT' });
});

// -------------------------------------------------------------------
// Non-trivial narrative symbols keep normal tokenizer/routing behavior
// -------------------------------------------------------------------

test('a non-trivial narrative symbol keeps the tokenizer probe and the subagent route', async () => {
  const fixture = await createQueueFixture({ files: { 'src/classify.js': BRANCHY_JS }, symbols: [branchySymbol()] });
  const tokenizerCalls = [];
  const providerCalls = [];
  const consoleStub = stubConsole();

  try {
    await main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      narrativeResolver: async () => narrativeContextFor(branchySymbol()),
      countPromptTokensImpl: async (input) => {
        tokenizerCalls.push(input);
        return 999_999;
      },
      runEnrichmentWithFallbackImpl: async () => {
        providerCalls.push(1);
        throw new Error('routed symbols must not hit the provider driver');
      },
    });
  } finally {
    consoleStub.restore();
  }

  assert.equal(tokenizerCalls.length, 1, 'non-trivial symbols must keep the normal tokenizer probe');
  assert.equal(providerCalls.length, 0);

  const queue = await loadSubagentQueue(fixture.dirs.enrichment);
  assert.equal(queue.entries.length, 1);
  assert.equal(queue.entries[0].promptVersion, 'v2');
  assert.deepEqual(queue.entries[0].schema, NARRATIVE_SCHEMA);
  assert.deepEqual(queue.entries[0].knownGraphKeys, [BRANCHY_KEY]);

  const updatedWorklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(updatedWorklist[0].status, 'subagent-queued');

  const finalIndex = await readJsonArtifact(fixture.symbolIndexFile);
  assert.deepEqual(finalIndex, {}, 'a routed symbol writes no index entry in this run');

  await assert.rejects(access(await memoryFileOf(fixture, branchySymbol())), { code: 'ENOENT' });
});

// -------------------------------------------------------------------
// Legacy text flow is byte-for-byte unchanged, triviality never engages
// -------------------------------------------------------------------

test('legacy text flow ignores triviality and keeps its exact request, output and attempt records', async () => {
  const fixture = await createQueueFixture({ files: { 'src/add.js': TRIVIAL_JS }, symbols: [trivialSymbol()] });
  const tokenizerCalls = [];
  const requests = [];
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
        requests.push(request);
        return succeededTextResult('Legacy enrichment text.');
      },
    });
  } finally {
    consoleStub.restore();
  }

  assert.equal(tokenizerCalls.length, 1, 'the legacy flow keeps its tokenizer probe');
  assert.deepEqual(Object.keys(requests[0]).sort(), ['prompt', 'timeoutMs']);
  assert.ok(!('format' in requests[0]), 'legacy requests never gain a format key');
  assert.ok(requests[0].prompt.startsWith('Symbol: add\n'), 'legacy prompt text stays byte-identical');
  assert.ok(!requests[0].prompt.includes('Prompt version: v2'));

  const memoryPayload = await readJsonArtifact(await memoryFileOf(fixture, trivialSymbol()));
  assert.equal(memoryPayload.content, 'Legacy enrichment text.', 'legacy enrichment text persists verbatim');

  const updatedWorklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(updatedWorklist[0].status, 'enriched');
  assert.equal(updatedWorklist[0].attempts.length, 1, 'legacy attempt records are unchanged');
  assert.equal(updatedWorklist[0].lastModeUsed, 'local-model');

  const queue = await loadSubagentQueue(fixture.dirs.enrichment);
  assert.equal(queue.entries.length, 0);

  const finalSummary = JSON.parse(consoleStub.logs[consoleStub.logs.length - 1]);
  assert.equal(finalSummary.enriched, 1);
  assert.equal(finalSummary.errors, 0);
});
