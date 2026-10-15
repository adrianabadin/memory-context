/**
 * F3 N5B (accepted plan 3.5 / spec S11) — opt-in narrative fingerprint cache
 * and summary-only upward invalidation on the actual queue paths.
 *
 * With an explicit narrative resolver the queue derives the accepted
 * fingerprint `narrativeHash = h(code, signature, role, calleeSummaryHashes,
 * promptVersion)` from the EXACT source slice used by the prompt, the
 * caller-supplied signature/role, and the canonical callee summary TEXT list,
 * BEFORE any tokenizer probe, template build, provider driver or subagent
 * route. A matching stored fingerprint plus a valid accepted narrative
 * artifact reuses the accepted memory with zero tokenizer/provider/subagent/
 * template work and no memory, provider-event or sync-manifest write.
 * Missing or malformed context, absent/corrupt/wrong-key/invalid artifacts
 * and missing stored hashes fail closed into a baseline generation — mere
 * file existence is never a cache proof. A successful validated narrative or
 * template persists aligned `narrativeHash` + complete
 * `calleeSummaryHashes` + `promptVersion` on worklist, index and accepted
 * artifact; failures and rejections preserve the previously accepted
 * fingerprint, bytes and summary. Upward invalidation fires only when a
 * callee's accepted summary TEXT actually changes, and marks every previously
 * accepted dependent caller stale through the complete stored callee-key hash
 * maps (never top-5 display callers, never names) for the NEXT pass.
 * Legacy (no resolver) flows stay byte-for-byte unchanged.
 */

import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { main, runQueueSymbolEnrichment } from '../cli/enrich-queue.mjs';
import { ensureProjectMemoryContextDirs, readJsonArtifact } from '../src/artifacts.mjs';
import { loadSubagentQueue } from '../src/subagent-queue.mjs';
import { computeNarrativeHash, hashCalleeSummaries } from '../src/hash.mjs';

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

// Six declared code lines with a real branch: NON-trivial, so any un-cached
// run must probe the tokenizer and reach the provider driver.
const BRANCHY_JS = [
  'export function classify(value) {',
  '  if (!value) {',
  "    throw new TypeError('value required');",
  '  }',
  "  return typeof value === 'string' ? 'text' : 'other';",
  '}',
  '',
  '// padding line one',
  '// padding line two',
  '',
].join('\n');

// Callee source for the propagation unit: branchy so the provider path runs.
const HELPER_JS = [
  'export function normalize(value) {',
  '  if (value == null) {',
  "    throw new TypeError('value required');",
  '  }',
  '  return String(value).trim().toLowerCase();',
  '}',
  '',
  '// padding',
].join('\n');

// Caller source for the out-of-order next-pass proof: branchy too.
const CONSUMER_JS = [
  'export function consume(raw) {',
  '  if (!raw) {',
  "    throw new TypeError('raw required');",
  '  }',
  '  return normalize(raw);',
  '}',
  '',
  '// padding',
].join('\n');

const BRANCHY_KEY = 'js|src/classify.js|function|exported|classify|1';
const CALLEE_KEY = 'js|src/normalize.js|function|exported|normalize|1';
const CALLER_KEY = 'js|src/consume.js|function|exported|consume|1';
const DECOY_KEY = 'js|src/api.js|function|exported|handle|1';

const CALLEE_SUMMARY = 'Normalizes a raw value into the canonical shape.';
const OLD_SUMMARY = 'Old accepted summary text for the callee symbol.';
const NEW_SUMMARY = 'Rewritten accepted summary text for the callee symbol.';

// The exact code slice the fingerprint must cover (range 1-6 over BRANCHY_JS).
const BRANCHY_CODE = BRANCHY_JS.split('\n').slice(0, 6).join('\n');
const HELPER_CODE = HELPER_JS.split('\n').slice(0, 6).join('\n');
const CONSUMER_CODE = CONSUMER_JS.split('\n').slice(0, 6).join('\n');

const RANGE = { startLine: 1, endLine: 6 };

function branchySymbol() {
  return {
    symbolKey: BRANCHY_KEY,
    name: 'classify',
    kind: 'function',
    language: 'js',
    filePath: 'src/classify.js',
    codeHash: 'hash-classify',
    range: { ...RANGE },
    status: 'pending',
  };
}

function calleeSymbol() {
  return {
    symbolKey: CALLEE_KEY,
    name: 'normalize',
    kind: 'function',
    language: 'js',
    filePath: 'src/normalize.js',
    codeHash: 'hash-normalize',
    range: { ...RANGE },
    status: 'stale',
  };
}

function callerSymbol() {
  return {
    symbolKey: CALLER_KEY,
    name: 'consume',
    kind: 'function',
    language: 'js',
    filePath: 'src/consume.js',
    codeHash: 'hash-consume',
    range: { ...RANGE },
    status: 'pending',
  };
}

function makeContext(overrides = {}) {
  return {
    symbolKeys: [BRANCHY_KEY, CALLEE_KEY, DECOY_KEY],
    signature: 'export function classify(value)',
    role: { role: 'extractor', layer: 'domain', confidence: 0.9, evidence: [] },
    callees: [
      { key: CALLEE_KEY, name: 'normalize', summary: CALLEE_SUMMARY },
    ],
    callers: [
      { key: DECOY_KEY, name: 'handle', role: 'controller' },
    ],
    fileCardSummary: 'Classifier helpers for the API layer.',
    projectRules: ['Keep branches explicit.'],
    ...overrides,
  };
}

function validNarrative(overrides = {}) {
  return {
    summary: 'Classifies a raw value into a canonical bucket.',
    behavior: ['Rejects falsy input with a TypeError.'],
    sideEffects: [],
    errors: [],
    contracts: ['The value argument must be present.'],
    changeNotes: 'Keep the branch semantics when editing.',
    mentions: [CALLEE_KEY],
    ...overrides,
  };
}

function succeededResult(content, { mode = 'local-model' } = {}) {
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
        startedAt: '2026-10-15T12:00:00.000Z',
        endedAt: '2026-10-15T12:00:01.000Z',
      },
    ],
  };
}

async function createQueueFixture({ files, symbols }) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-n5b-queue-'));
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

function memoryFileOf(enrichmentDir, symbolKey) {
  return join(enrichmentDir, `${symbolKey.replace(/[^a-zA-Z0-9_-]+/g, '_')}.memory.json`);
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

// One complete main() run with counters; returns the captured console output.
async function runMain(fixture, { context, tokenizerCalls = [], providerCalls = [], providerResult } = {}) {
  const consoleStub = stubConsole();
  try {
    await main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      narrativeResolver: async () => context,
      countPromptTokensImpl: async (input) => {
        tokenizerCalls.push(input);
        return 400;
      },
      runEnrichmentWithFallbackImpl: async ({ request }) => {
        providerCalls.push(request);
        // A function returns the full driver result (failure shapes); a
        // string is wrapped as a successful structured response.
        if (typeof providerResult === 'function') return providerResult(request);
        if (typeof providerResult === 'string') return succeededResult(providerResult);
        return succeededResult(JSON.stringify(validNarrative()));
      },
    });
  } finally {
    consoleStub.restore();
  }
  return consoleStub;
}

// Oracle: the accepted S11 formula over the exact inputs.
async function expectedHash({ code, signature, role, callees = [], promptVersion = 'v2' }) {
  const calleeSummaryHashes = await hashCalleeSummaries(Object.fromEntries(callees));
  return computeNarrativeHash({ code, signature, role, calleeSummaryHashes, promptVersion });
}

async function storedHashes(fixture) {
  const worklist = await readJsonArtifact(fixture.worklistFile);
  const index = await readJsonArtifact(fixture.symbolIndexFile);
  const memory = await readJsonArtifact(memoryFileOf(fixture.dirs.enrichment, fixture.symbols[0].symbolKey));
  return { worklist, index, memory };
}

// -------------------------------------------------------------------
// First acceptance persists the aligned fingerprint; the next run reuses
// it with zero tokenizer, provider, subagent and template work.
// -------------------------------------------------------------------

test('first acceptance persists an aligned fingerprint and the next run reuses it with zero model-bound work and zero writes', async () => {
  const fixture = await createQueueFixture({ files: { 'src/classify.js': BRANCHY_JS }, symbols: [branchySymbol()] });
  const context = makeContext();
  const tokenizer1 = [];
  const provider1 = [];

  const first = await runMain(fixture, { context, tokenizerCalls: tokenizer1, providerCalls: provider1 });
  assert.equal(tokenizer1.length, 1, 'the first run is a baseline generation and must probe the tokenizer');
  assert.equal(provider1.length, 1, 'the first run must generate through the provider driver');
  assert.ok(first.errors.some((line) => line.includes('[queue] DONE')), 'the first run reports a normal DONE line');

  // ── aligned fingerprint on worklist, index and accepted artifact ──
  const calleeSummaryHashes = await hashCalleeSummaries({ [CALLEE_KEY]: CALLEE_SUMMARY });
  const fingerprint = await expectedHash({
    code: BRANCHY_CODE,
    signature: context.signature,
    role: context.role,
    callees: [[CALLEE_KEY, CALLEE_SUMMARY]],
  });
  assert.equal(fingerprint, await computeNarrativeHash({
    code: BRANCHY_CODE,
    signature: context.signature,
    role: context.role,
    calleeSummaryHashes,
    promptVersion: 'v2',
  }), 'the oracle itself must use the accepted formula');

  const before = await storedHashes(fixture);
  assert.equal(before.worklist[0].status, 'enriched');
  assert.equal(before.worklist[0].narrativeHash, fingerprint, 'the worklist persists the aligned narrativeHash');
  assert.deepEqual(before.worklist[0].calleeSummaryHashes, calleeSummaryHashes, 'the worklist persists the complete callee summary hash map');
  assert.equal(before.worklist[0].promptVersion, 'v2');
  assert.equal(before.index[BRANCHY_KEY].narrativeHash, fingerprint, 'the index persists the aligned narrativeHash');
  assert.deepEqual(before.index[BRANCHY_KEY].calleeSummaryHashes, calleeSummaryHashes);
  assert.equal(before.index[BRANCHY_KEY].promptVersion, 'v2');
  assert.deepEqual(before.memory.narrativeEvidence, {
    symbolKey: BRANCHY_KEY,
    narrativeHash: fingerprint,
    calleeSummaryHashes,
    promptVersion: 'v2',
  }, 'the accepted artifact carries the structured narrative evidence bundle');
  assert.deepEqual(JSON.parse(before.memory.content), validNarrative());
  assert.equal(before.index[BRANCHY_KEY].semanticSummary, validNarrative().summary);

  const worklistBytes = await readFile(fixture.worklistFile, 'utf8');
  const indexBytes = await readFile(fixture.symbolIndexFile, 'utf8');
  const memoryBytes = await readFile(memoryFileOf(fixture.dirs.enrichment, BRANCHY_KEY), 'utf8');
  const manifestBytes = await readFile(join(fixture.dirs.enrichment, 'sync-manifest.json'), 'utf8');
  const eventsBefore = await providerEventLines(fixture.dirs.enrichment);
  assert.equal(eventsBefore.length, 1);

  // ── second run: full cache reuse ──
  const tokenizer2 = [];
  const provider2 = [];
  const second = await runMain(fixture, { context, tokenizerCalls: tokenizer2, providerCalls: provider2 });

  assert.equal(tokenizer2.length, 0, 'a matching fingerprint must precede the Ollama tokenizer probe');
  assert.equal(provider2.length, 0, 'a valid accepted artifact must precede the provider driver');
  assert.ok(second.errors.some((line) => line.includes('REUSE') && line.includes('accepted narrative cache hit')),
    'the reuse is reported honestly on the run report');
  assert.ok(!second.errors.some((line) => line.includes('template narrative')),
    'a reused result never claims the template path');
  assert.ok(!second.errors.some((line) => line.includes('[queue] DONE')),
    'a reused result never claims a fresh enrichment DONE line');

  const queue = await loadSubagentQueue(fixture.dirs.enrichment);
  assert.equal(queue.entries.length, 0, 'the reuse must precede the subagent route');

  assert.equal((await providerEventLines(fixture.dirs.enrichment)).length, 1, 'no provider event may be appended on reuse');
  assert.equal(await readFile(join(fixture.dirs.enrichment, 'sync-manifest.json'), 'utf8'), manifestBytes,
    'no sync-manifest write may happen on reuse');
  assert.equal(await readFile(memoryFileOf(fixture.dirs.enrichment, BRANCHY_KEY), 'utf8'), memoryBytes,
    'accepted memory bytes must be preserved unchanged on reuse');
  assert.equal(await readFile(fixture.worklistFile, 'utf8'), worklistBytes,
    'an already-accepted matching entry needs no worklist write');
  assert.equal(await readFile(fixture.symbolIndexFile, 'utf8'), indexBytes,
    'an already-accepted matching entry needs no index write');

  const after = await storedHashes(fixture);
  assert.equal(after.worklist[0].status, 'enriched',
    'reuse never downgrades or rewrites an accepted status');
  assert.equal(after.worklist[0].narrativeHash, fingerprint);
  assert.equal(after.index[BRANCHY_KEY].status, 'enriched');
  assert.equal(after.index[BRANCHY_KEY].semanticSummary, validNarrative().summary,
    'accepted memoryId/semanticSummary/content fields are preserved unchanged on cache hit');

  const summary = JSON.parse(second.logs[second.logs.length - 1]);
  assert.equal(summary.complete, true);
  assert.equal(summary.enriched, 1);
  assert.equal(summary.errors, 0);
  assert.equal(summary.subagentQueued ?? 0, 0,
    'the early-exit reuse report never claims a queued subagent');
  assert.ok(deniedNativeSpawns.length >= 1, 'finalize must attempt the background sync spawn through the deny patch');
});

test('a stale entry whose accepted fingerprint still matches is reused and reconciled without a model call', async () => {
  const fixture = await createQueueFixture({ files: { 'src/classify.js': BRANCHY_JS }, symbols: [branchySymbol()] });
  const context = makeContext();

  await runMain(fixture, { context });

  // Mark the accepted entry stale without touching any fingerprint input.
  const worklist = await readJsonArtifact(fixture.worklistFile);
  worklist[0].status = 'stale';
  worklist[0].staleReason = 'code-hash-changed';
  await writeJson(fixture.worklistFile, worklist);

  const tokenizer = [];
  const provider = [];
  const run = await runMain(fixture, { context, tokenizerCalls: tokenizer, providerCalls: provider });

  assert.equal(provider.length, 0, 'a matching stored fingerprint must not reach the provider');
  assert.equal(tokenizer.length, 0, 'a matching stored fingerprint must not reach the tokenizer');
  assert.ok(run.errors.some((line) => line.includes('REUSE')));
  const reconciled = await readJsonArtifact(fixture.worklistFile);
  assert.equal(reconciled[0].status, 'enriched', 'a cache hit reconciles the stale entry back to accepted');
  assert.equal(reconciled[0].narrativeHash,
    (await readJsonArtifact(fixture.symbolIndexFile))[BRANCHY_KEY].narrativeHash);
});

// -------------------------------------------------------------------
// Invalidation: own inputs change → regenerate; caller-only context → hit.
// -------------------------------------------------------------------

test('code, signature, role, callee summary text, empty summary and promptVersion changes invalidate; caller-only context does not', async () => {
  const fixture = await createQueueFixture({ files: { 'src/classify.js': BRANCHY_JS }, symbols: [branchySymbol()] });
  const context = makeContext();
  const tokenizer = [];
  const provider = [];
  let previousHash = null;

  const readHash = async () => (await readJsonArtifact(fixture.worklistFile))[0].narrativeHash;

  // 1. baseline acceptance
  await runMain(fixture, { context, tokenizerCalls: tokenizer, providerCalls: provider });
  assert.equal(provider.length, 1);
  previousHash = await readHash();
  assert.equal(previousHash, await expectedHash({
    code: BRANCHY_CODE, signature: context.signature, role: context.role,
    callees: [[CALLEE_KEY, CALLEE_SUMMARY]],
  }));

  // 2. caller-only context change (top-5 caller list) → still a cache hit
  context.callers = [
    { key: DECOY_KEY, name: 'handle', role: 'controller' },
    { key: BRANCHY_KEY, name: 'classify', role: 'extractor' },
  ];
  await runMain(fixture, { context, tokenizerCalls: tokenizer, providerCalls: provider });
  assert.equal(provider.length, 1, 'a caller-only context change must not re-run the model');
  assert.equal(await readHash(), previousHash, 'caller-only context never changes the fingerprint');

  // 3. own code change → regenerate
  await writeFile(join(fixture.projectRoot, 'src/classify.js'),
    BRANCHY_JS.replace('return typeof', '// touched\n  return typeof'), 'utf8');
  await runMain(fixture, { context, tokenizerCalls: tokenizer, providerCalls: provider });
  assert.equal(provider.length, 2, 'a code change must regenerate');
  const afterCode = await readHash();
  assert.notEqual(afterCode, previousHash);
  previousHash = afterCode;

  // 4. signature change → regenerate
  context.signature = 'export function classify(value /* touched */)';
  await runMain(fixture, { context, tokenizerCalls: tokenizer, providerCalls: provider });
  assert.equal(provider.length, 3, 'a signature change must regenerate');
  assert.notEqual(await readHash(), previousHash);
  previousHash = await readHash();

  // 5. role change → regenerate
  context.role = { ...context.role, layer: 'infrastructure' };
  await runMain(fixture, { context, tokenizerCalls: tokenizer, providerCalls: provider });
  assert.equal(provider.length, 4, 'a role change must regenerate');
  assert.notEqual(await readHash(), previousHash);
  previousHash = await readHash();

  // 6. callee summary TEXT change → regenerate
  context.callees = [{ key: CALLEE_KEY, name: 'normalize', summary: 'A rewritten callee summary.' }];
  await runMain(fixture, { context, tokenizerCalls: tokenizer, providerCalls: provider });
  assert.equal(provider.length, 5, 'a callee summary text change must regenerate');
  assert.notEqual(await readHash(), previousHash);
  previousHash = await readHash();

  // 7. callee summary becomes the empty string → regenerate with the
  //    empty-text pair included in the canonical map
  context.callees = [{ key: CALLEE_KEY, name: 'normalize', summary: '' }];
  await runMain(fixture, { context, tokenizerCalls: tokenizer, providerCalls: provider });
  assert.equal(provider.length, 6, 'an empty callee summary is still exact summary text');
  const currentSource = await readFile(join(fixture.projectRoot, 'src/classify.js'), 'utf8');
  const emptyHash = await expectedHash({
    code: currentSource.split('\n').slice(0, 6).join('\n'),
    signature: context.signature, role: context.role,
    callees: [[CALLEE_KEY, '']],
  });
  assert.equal(await readHash(), emptyHash, 'the empty summary string is hashed as exact bytes');
  previousHash = await readHash();

  // 8. stored promptVersion tampered → regenerate (never a cache hit)
  const memoryFile = memoryFileOf(fixture.dirs.enrichment, BRANCHY_KEY);
  const tampered = JSON.parse(await readFile(memoryFile, 'utf8'));
  tampered.narrativeEvidence.promptVersion = 'v1';
  await writeFile(memoryFile, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');
  const tamperRun = await runMain(fixture, { context, tokenizerCalls: tokenizer, providerCalls: provider });
  assert.equal(provider.length, 7, 'a mismatching stored promptVersion must regenerate');
  assert.ok(tamperRun.errors.some((line) => line.includes('prompt-version-mismatch')),
    'the exact miss reason is reported instead of silently trusting the artifact');
  const restored8 = JSON.parse(await readFile(memoryFile, 'utf8')).narrativeEvidence;
  assert.equal(restored8.promptVersion, 'v2', 'regeneration restores a valid aligned bundle');
  assert.equal(restored8.narrativeHash, await readHash(),
    'the tampered artifact never replaces the accepted fingerprint');
  assert.equal(await readHash(), previousHash,
    'untouched fingerprint inputs reproduce the same hash after a baseline regeneration');

  // 9. stored calleeSummaryHashes tampered → regenerate
  const tampered2 = JSON.parse(await readFile(memoryFile, 'utf8'));
  tampered2.narrativeEvidence.calleeSummaryHashes = { [CALLEE_KEY]: 'deadbeef' };
  await writeFile(memoryFile, `${JSON.stringify(tampered2, null, 2)}\n`, 'utf8');
  await runMain(fixture, { context, tokenizerCalls: tokenizer, providerCalls: provider });
  assert.equal(provider.length, 8, 'inconsistent stored callee hashes must regenerate');
  const restored9 = JSON.parse(await readFile(memoryFile, 'utf8')).narrativeEvidence;
  assert.deepEqual(restored9.calleeSummaryHashes, await hashCalleeSummaries({ [CALLEE_KEY]: '' }),
    'the tampered dependency map is replaced by the accepted exact summary hash knowledge');
  assert.equal(restored9.narrativeHash, (await readJsonArtifact(fixture.worklistFile))[0].narrativeHash);
});

// -------------------------------------------------------------------
// No artifact, corrupt artifact, wrong key, missing content, invalid
// mentions/schema and missing stored hashes never become cache hits.
// -------------------------------------------------------------------

test('missing, corrupt, wrong-key, content-invalid and fingerprint-less artifacts each fail closed into one generation', async () => {
  const fixture = await createQueueFixture({ files: { 'src/classify.js': BRANCHY_JS }, symbols: [branchySymbol()] });
  const context = makeContext();
  const tokenizer = [];
  const provider = [];
  const memoryFile = memoryFileOf(fixture.dirs.enrichment, BRANCHY_KEY);

  // baseline
  await runMain(fixture, { context, tokenizerCalls: tokenizer, providerCalls: provider });
  assert.equal(provider.length, 1);

  const expectMiss = async (label, reason, mutate) => {
    await mutate();
    const run = await runMain(fixture, { context, tokenizerCalls: tokenizer, providerCalls: provider });
    assert.equal(provider.length, expectMiss.calls += 1, `${label} must not be a cache hit`);
    assert.ok(run.errors.some((line) => line.includes(reason)),
      `${label} must report the ${reason} miss reason`);
    // the accepted artifact is restored to a valid state by regeneration
    const restored = JSON.parse(await readFile(memoryFile, 'utf8'));
    assert.equal(typeof restored.content, 'string');
    assert.deepEqual(JSON.parse(restored.content), validNarrative());
    assert.equal(restored.narrativeEvidence.narrativeHash,
      (await readJsonArtifact(fixture.worklistFile))[0].narrativeHash);
  };
  expectMiss.calls = 1;

  await expectMiss('corrupt artifact JSON', 'corrupt-artifact', async () => {
    await writeFile(memoryFile, 'this is not json {', 'utf8');
  });

  await expectMiss('missing content', 'missing-content', async () => {
    const payload = JSON.parse(await readFile(memoryFile, 'utf8'));
    delete payload.content;
    await writeFile(memoryFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  });

  await expectMiss('wrong evidence key', 'wrong-key', async () => {
    const payload = JSON.parse(await readFile(memoryFile, 'utf8'));
    payload.narrativeEvidence.symbolKey = DECOY_KEY;
    await writeFile(memoryFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  });

  await expectMiss('mismatching fingerprint', 'fingerprint-mismatch', async () => {
    const payload = JSON.parse(await readFile(memoryFile, 'utf8'));
    payload.narrativeEvidence.narrativeHash = 'deadbeefdeadbeef';
    await writeFile(memoryFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  });

  await expectMiss('content with unknown mentions', 'invalid-content', async () => {
    const payload = JSON.parse(await readFile(memoryFile, 'utf8'));
    const invalid = { ...validNarrative(), mentions: ['ghost|missing|key'] };
    payload.content = `${JSON.stringify(invalid, null, 2)}`;
    await writeFile(memoryFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  });

  await expectMiss('content missing a schema field', 'invalid-content', async () => {
    const payload = JSON.parse(await readFile(memoryFile, 'utf8'));
    const invalid = { ...validNarrative() };
    delete invalid.contracts;
    payload.content = `${JSON.stringify(invalid, null, 2)}`;
    await writeFile(memoryFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  });

  await expectMiss('accepted artifact without stored fingerprint evidence', 'missing-stored-hash', async () => {
    const payload = JSON.parse(await readFile(memoryFile, 'utf8'));
    delete payload.narrativeEvidence;
    await writeFile(memoryFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  });

  // Baseline once: after the regeneration above the stored hash exists again,
  // so the very next run must be a plain cache hit.
  const tokenizerBefore = tokenizer.length;
  const hitRun = await runMain(fixture, { context, tokenizerCalls: tokenizer, providerCalls: provider });
  assert.equal(provider.length, expectMiss.calls, 'a restored complete fingerprint must hit');
  assert.equal(tokenizer.length, tokenizerBefore, 'the restored baseline must not probe the tokenizer again');
  assert.ok(hitRun.errors.some((line) => line.includes('REUSE')));

  // Worklist-side stored hash missing → baseline generation, old memory is
  // never trusted on its own.
  const worklist = await readJsonArtifact(fixture.worklistFile);
  delete worklist[0].narrativeHash;
  await writeJson(fixture.worklistFile, worklist);
  await runMain(fixture, { context, tokenizerCalls: tokenizer, providerCalls: provider });
  assert.equal(provider.length, expectMiss.calls + 1, 'a missing stored worklist hash requires one baseline generation');
  assert.ok((await readJsonArtifact(fixture.worklistFile))[0].narrativeHash,
    'the baseline restores the stored fingerprint');
});

// -------------------------------------------------------------------
// Failures preserve previously accepted state.
// -------------------------------------------------------------------

test('a failed regeneration preserves the previously accepted fingerprint, memory bytes, index summary and manifest', async () => {
  const fixture = await createQueueFixture({ files: { 'src/classify.js': BRANCHY_JS }, symbols: [branchySymbol()] });
  const context = makeContext();

  await runMain(fixture, { context });

  const memoryFile = memoryFileOf(fixture.dirs.enrichment, BRANCHY_KEY);
  const acceptedHash = (await readJsonArtifact(fixture.worklistFile))[0].narrativeHash;
  const memoryBytes = await readFile(memoryFile, 'utf8');
  const manifestBytes = await readFile(join(fixture.dirs.enrichment, 'sync-manifest.json'), 'utf8');
  const indexBytes = await readFile(fixture.symbolIndexFile, 'utf8');
  const acceptedIndex = (await readJsonArtifact(fixture.symbolIndexFile))[BRANCHY_KEY];
  const eventsBefore = (await providerEventLines(fixture.dirs.enrichment)).length;

  // Change the source so the current fingerprint no longer matches.
  await writeFile(join(fixture.projectRoot, 'src/classify.js'),
    BRANCHY_JS.replace('return typeof', '// touched\n  return typeof'), 'utf8');

  const cp = createRequire(import.meta.url)('node:child_process');
  const deniedVersion = cp.spawn;
  cp.spawn = () => ({ pid: -1, unref() {} });
  syncBuiltinESMExports();
  const tokenizer = [];
  const provider = [];
  try {
    await runMain(fixture, {
      context,
      tokenizerCalls: tokenizer,
      providerCalls: provider,
      providerResult: () => ({
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
            startedAt: '2026-10-15T12:00:00.000Z',
            endedAt: '2026-10-15T12:00:01.000Z',
          },
        ],
      }),
    });
  } finally {
    cp.spawn = deniedVersion;
    syncBuiltinESMExports();
  }

  // The driver result is an honest failure: the run reports an error.
  assert.equal(provider.length, 1, 'the changed symbol still attempted exactly one generation');

  const worklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(worklist[0].status, 'error');
  assert.equal(worklist[0].narrativeHash, acceptedHash,
    'a failed run must not overwrite the previously accepted fingerprint');
  assert.deepEqual(worklist[0].calleeSummaryHashes,
    (await readJsonArtifact(fixture.symbolIndexFile))[BRANCHY_KEY].calleeSummaryHashes,
    'the accepted dependency evidence survives the failure');

  assert.equal(await readFile(memoryFile, 'utf8'), memoryBytes, 'accepted memory bytes are preserved');
  assert.equal(await readFile(join(fixture.dirs.enrichment, 'sync-manifest.json'), 'utf8'), manifestBytes,
    'no sync-manifest entry is appended on failure');
  assert.equal(await readFile(fixture.symbolIndexFile, 'utf8'), indexBytes,
    'the previously accepted index record survives a failed regeneration (C1 contract)');

  const failedIndex = await readJsonArtifact(fixture.symbolIndexFile);
  assert.equal(failedIndex[BRANCHY_KEY].status, 'enriched',
    'the accepted index status is preserved, exactly like the accepted summary');
  assert.equal(failedIndex[BRANCHY_KEY].memoryId, acceptedIndex.memoryId);
  assert.equal(failedIndex[BRANCHY_KEY].narrativeHash, acceptedHash,
    'the previously accepted fingerprint survives in the index record');
  assert.deepEqual(failedIndex[BRANCHY_KEY].calleeSummaryHashes, JSON.parse(memoryBytes).narrativeEvidence.calleeSummaryHashes);
  assert.equal(failedIndex[BRANCHY_KEY].promptVersion, 'v2');
  assert.equal(failedIndex[BRANCHY_KEY].semanticSummary, validNarrative().summary,
    'the previously accepted summary survives the failure');
  assert.equal((await providerEventLines(fixture.dirs.enrichment)).length, eventsBefore + 1,
    'the honest failed attempt is the only new provider event');
});

// -------------------------------------------------------------------
// Upward propagation: only an actual accepted summary TEXT change.
// -------------------------------------------------------------------

function dependentCallers(count) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      symbolKey: `js|src/dep${i}.js|function|exported|zulu${i}|0`,
      name: `zulu${i}`,
      filePath: `src/dep${i}.js`,
      language: 'js',
      kind: 'function',
      codeHash: `dep-hash-${i}`,
      range: { startLine: 1, endLine: 3 },
      status: 'enriched',
      memoryId: `queue-dep-${i}`,
      enrichedAt: '2026-10-01T00:00:00.000Z',
      narrativeHash: `dep-fp-${i}`,
      promptVersion: 'v2',
      calleeSummaryHashes: {},
    });
  }
  return entries;
}

async function propagationFixture({ summary = OLD_SUMMARY, knownSummaryText = summary } = {}) {
  const fixture = await createQueueFixture({
    files: { 'src/normalize.js': HELPER_JS },
    symbols: [calleeSymbol()],
  });

  const oldHash = (await hashCalleeSummaries({ [CALLEE_KEY]: summary }))[CALLEE_KEY];
  const worklist = await readJsonArtifact(fixture.worklistFile);
  const callers = dependentCallers(7);
  for (const caller of callers) caller.calleeSummaryHashes = { [CALLEE_KEY]: oldHash };
  // Decoy 1: shares the callee's NAME but not its dependency key — names
  // must never identify dependents.
  const nameDecoy = {
    symbolKey: DECOY_KEY,
    name: 'normalize',
    filePath: 'src/api.js',
    language: 'js',
    kind: 'function',
    codeHash: 'decoy-hash',
    range: { startLine: 1, endLine: 3 },
    status: 'enriched',
    memoryId: 'queue-decoy',
    enrichedAt: '2026-10-01T00:00:00.000Z',
    narrativeHash: 'decoy-fp',
    promptVersion: 'v2',
    calleeSummaryHashes: { [DECOY_KEY]: 'other-hash' },
  };
  // Decoy 2: already knows the callee under the caller-supplied summary text.
  const knownDecoy = {
    symbolKey: 'js|src/known.js|function|exported|known|0',
    name: 'known',
    filePath: 'src/known.js',
    language: 'js',
    kind: 'function',
    codeHash: 'known-hash',
    range: { startLine: 1, endLine: 3 },
    status: 'enriched',
    memoryId: 'queue-known',
    enrichedAt: '2026-10-01T00:00:00.000Z',
    narrativeHash: 'known-fp',
    promptVersion: 'v2',
    calleeSummaryHashes: { [CALLEE_KEY]: (await hashCalleeSummaries({ [CALLEE_KEY]: knownSummaryText }))[CALLEE_KEY] },
  };
  // Not yet accepted: pending callers stay regular processing.
  const pendingDep = {
    symbolKey: 'js|src/pending.js|function|exported|pending|0',
    name: 'pending',
    filePath: 'src/pending.js',
    language: 'js',
    kind: 'function',
    codeHash: 'pending-hash',
    range: { startLine: 1, endLine: 3 },
    status: 'pending',
    calleeSummaryHashes: { [CALLEE_KEY]: oldHash },
  };
  worklist.push(...callers, nameDecoy, knownDecoy, pendingDep);
  await writeJson(fixture.worklistFile, worklist);

  // Previously accepted callee artifact with the OLD full summary text.
  const oldNarrative = validNarrative({ summary, mentions: [] });
  await writeJson(memoryFileOf(fixture.dirs.enrichment, CALLEE_KEY), {
    content: `${JSON.stringify(oldNarrative, null, 2)}`,
    category: 'architecture',
    tags: ['symbol', 'js', 'function'],
  });

  return { fixture, callers, nameDecoy, knownDecoy, pendingDep };
}

test('a changed accepted callee summary marks every previously accepted dependent caller stale for the next pass', async () => {
  const { fixture, callers, nameDecoy, knownDecoy, pendingDep } = await propagationFixture({ knownSummaryText: NEW_SUMMARY });
  const provider = [];

  const result = await runQueueSymbolEnrichment({
    symbol: calleeSymbol(),
    projectRoot: fixture.projectRoot,
    projectSlug: 'n5b-fixture',
    timeoutMs: 30_000,
    enrichmentDir: fixture.dirs.enrichment,
    worklist: await readJsonArtifact(fixture.worklistFile),
    worklistFile: fixture.worklistFile,
    symbolIndex: {},
    symbolIndexFile: fixture.symbolIndexFile,
    config: { preferredModes: ['local-model'] },
    providers: [],
    narrativeContext: makeCalleeContext(),
    runEnrichmentWithFallbackImpl: async () => {
      provider.push(1);
      return succeededResult(JSON.stringify(validNarrative({
        summary: NEW_SUMMARY,
        mentions: [],
      })));
    },
  });
  assert.equal(result.status, 'enriched');
  assert.equal(provider.length, 1);

  const worklist = await readJsonArtifact(fixture.worklistFile);
  const byKey = new Map(worklist.map((entry) => [entry.symbolKey, entry]));

  for (const caller of callers) {
    const entry = byKey.get(caller.symbolKey);
    assert.equal(entry.status, 'stale', `${caller.symbolKey} must be stale for the next pass`);
    assert.equal(entry.staleReason, 'callee-summary-changed');
    assert.equal(entry.memoryId, caller.memoryId, 'accepted memory must be preserved until regeneration');
    assert.equal(entry.narrativeHash, caller.narrativeHash, 'the accepted fingerprint is preserved until regeneration');
    assert.deepEqual(entry.calleeSummaryHashes, { [CALLEE_KEY]: (await hashCalleeSummaries({ [CALLEE_KEY]: OLD_SUMMARY }))[CALLEE_KEY] },
      'marking must not rewrite the accepted dependency evidence');
  }
  assert.equal(byKey.get(nameDecoy.symbolKey).status, 'enriched',
    'a shared NAME must never identify dependents');
  assert.equal(byKey.get(knownDecoy.symbolKey).status, 'enriched',
    'an already-consistent caller must not be marked');
  assert.equal(byKey.get(pendingDep.symbolKey).status, 'pending',
    'a not-yet-accepted caller keeps regular processing');

  const calleeEntry = byKey.get(CALLEE_KEY);
  assert.equal(calleeEntry.status, 'enriched');
  assert.ok(calleeEntry.narrativeHash, 'the regenerated callee persists its own aligned fingerprint');
});

test('a callee body change with identical accepted summary bytes causes no upward staleness', async () => {
  const { fixture, callers, nameDecoy, knownDecoy, pendingDep } = await propagationFixture();
  const provider = [];

  const result = await runQueueSymbolEnrichment({
    symbol: calleeSymbol(),
    projectRoot: fixture.projectRoot,
    projectSlug: 'n5b-fixture',
    timeoutMs: 30_000,
    enrichmentDir: fixture.dirs.enrichment,
    worklist: await readJsonArtifact(fixture.worklistFile),
    worklistFile: fixture.worklistFile,
    symbolIndex: {},
    symbolIndexFile: fixture.symbolIndexFile,
    config: { preferredModes: ['local-model'] },
    providers: [],
    narrativeContext: makeCalleeContext(),
    runEnrichmentWithFallbackImpl: async () => {
      provider.push(1);
      return succeededResult(JSON.stringify(validNarrative({
        summary: OLD_SUMMARY,
        behavior: ['A rewritten body with the very same summary text.'],
        mentions: [],
      })));
    },
  });
  assert.equal(result.status, 'enriched');

  const worklist = await readJsonArtifact(fixture.worklistFile);
  const byKey = new Map(worklist.map((entry) => [entry.symbolKey, entry]));
  for (const caller of callers) {
    assert.equal(byKey.get(caller.symbolKey).status, 'enriched',
      'identical summary bytes must not propagate staleness');
    assert.ok(!('staleReason' in byKey.get(caller.symbolKey)));
  }
  assert.equal(byKey.get(nameDecoy.symbolKey).status, 'enriched');
  assert.equal(byKey.get(knownDecoy.symbolKey).status, 'enriched');
  assert.equal(byKey.get(pendingDep.symbolKey).status, 'pending');
});

test('propagation compares the FULL accepted summary text, beyond the 200-character index cap', async () => {
  const word = (ch) => ch.repeat(40);
  const longA = [word('A'), word('B'), word('C'), word('D'), `${word('E').slice(0, 37)}XDDD`, ...Array(20).fill(word('F'))].join(' ');
  const longB = [word('A'), word('B'), word('C'), word('D'), `${word('E').slice(0, 37)}YEEE`, ...Array(20).fill(word('G'))].join(' ');
  assert.notEqual(longA, longB);
  assert.equal(longA.slice(0, 200), longB.slice(0, 200),
    'the two summaries share their first 200 characters, so a truncated compare would see no change');
  assert.ok(longA.length > 200 && longB.length > 200);
  assert.ok(longA.trim().split(/\s+/).length <= 25 && longB.trim().split(/\s+/).length <= 25);

  const { fixture, callers } = await propagationFixture({ summary: longA, knownSummaryText: longA });

  await runQueueSymbolEnrichment({
    symbol: calleeSymbol(),
    projectRoot: fixture.projectRoot,
    projectSlug: 'n5b-fixture',
    timeoutMs: 30_000,
    enrichmentDir: fixture.dirs.enrichment,
    worklist: await readJsonArtifact(fixture.worklistFile),
    worklistFile: fixture.worklistFile,
    symbolIndex: {},
    symbolIndexFile: fixture.symbolIndexFile,
    config: { preferredModes: ['local-model'] },
    providers: [],
    narrativeContext: makeCalleeContext(),
    runEnrichmentWithFallbackImpl: async () => succeededResult(JSON.stringify(validNarrative({
      summary: longB,
      mentions: [],
    }))),
  });

  const worklist = await readJsonArtifact(fixture.worklistFile);
  const byKey = new Map(worklist.map((entry) => [entry.symbolKey, entry]));
  for (const caller of callers) {
    assert.equal(byKey.get(caller.symbolKey).status, 'stale',
      'a change beyond character 200 is still a real summary change');
    assert.equal(byKey.get(caller.symbolKey).staleReason, 'callee-summary-changed');
  }
});

test('an already-processed caller is persisted stale for the next pass and regenerates instead of reusing the stale fingerprint', async () => {
  const fixture = await createQueueFixture({
    files: { 'src/normalize.js': HELPER_JS, 'src/consume.js': CONSUMER_JS },
    symbols: [callerSymbol(), calleeSymbol()],
  });

  const oldCalleeHash = (await hashCalleeSummaries({ [CALLEE_KEY]: OLD_SUMMARY }))[CALLEE_KEY];

  const oldNarrative = validNarrative({ summary: OLD_SUMMARY, mentions: [] });
  await writeJson(memoryFileOf(fixture.dirs.enrichment, CALLEE_KEY), {
    content: `${JSON.stringify(oldNarrative, null, 2)}`,
    category: 'architecture',
    tags: ['symbol', 'js', 'function'],
  });

  const provider = [];
  const runQueue = async (symbol, context) => runQueueSymbolEnrichment({
    symbol,
    projectRoot: fixture.projectRoot,
    projectSlug: 'n5b-fixture',
    timeoutMs: 30_000,
    enrichmentDir: fixture.dirs.enrichment,
    worklist: await readJsonArtifact(fixture.worklistFile),
    worklistFile: fixture.worklistFile,
    symbolIndex: await readJsonArtifact(fixture.symbolIndexFile),
    symbolIndexFile: fixture.symbolIndexFile,
    config: { preferredModes: ['local-model'] },
    providers: [],
    narrativeContext: context,
    runEnrichmentWithFallbackImpl: async () => {
      provider.push(symbol.symbolKey);
      return succeededResult(JSON.stringify(validNarrative({
        summary: symbol.symbolKey === CALLER_KEY
          ? 'Consumes a raw value through the normalizer.'
          : NEW_SUMMARY,
        mentions: [],
      })));
    },
  });

  // Pass 1: the caller is processed FIRST (already processed by the time the
  // callee's summary changes), then the callee regenerates.
  const callerContext = {
    symbolKeys: [CALLER_KEY, CALLEE_KEY],
    signature: 'export function consume(raw)',
    role: { role: 'controller', layer: 'interface', confidence: 0.8, evidence: [] },
    callees: [{ key: CALLEE_KEY, name: 'normalize', summary: OLD_SUMMARY }],
    callers: [],
    fileCardSummary: 'Consumer module.',
    projectRules: [],
  };
  const first = await runQueue(callerSymbol(), callerContext);
  assert.equal(first.status, 'enriched');
  const callerAcceptedHash = (await readJsonArtifact(fixture.worklistFile))
    .find((entry) => entry.symbolKey === CALLER_KEY).narrativeHash;
  assert.ok(callerAcceptedHash);

  await runQueue(calleeSymbol(), makeCalleeContext());

  const afterCallee = await readJsonArtifact(fixture.worklistFile);
  const callerEntry = afterCallee.find((entry) => entry.symbolKey === CALLER_KEY);
  assert.equal(callerEntry.status, 'stale',
    'an already-processed caller is persisted stale for the NEXT pass, not re-run in place');
  assert.equal(callerEntry.staleReason, 'callee-summary-changed');
  assert.equal(callerEntry.narrativeHash, callerAcceptedHash);
  assert.equal(callerEntry.calleeSummaryHashes[CALLEE_KEY], oldCalleeHash,
    'the stored dependency evidence is NOT rewritten at marking time');

  // Pass 2 (next pass): the resolver now supplies the accepted NEW callee
  // summary, so the current fingerprint differs and the stale fingerprint is
  // never reused.
  const newCalleeSummary = NEW_SUMMARY;
  const nextContext = {
    ...callerContext,
    callees: [{ key: CALLEE_KEY, name: 'normalize', summary: newCalleeSummary }],
  };
  const providerBefore = provider.length;
  const second = await runQueue(callerSymbol(), nextContext);
  assert.equal(second.status, 'enriched');
  assert.equal(provider.length, providerBefore + 1,
    'the next pass must regenerate the caller instead of hitting the stale cached fingerprint');

  const afterNext = await readJsonArtifact(fixture.worklistFile);
  const nextEntry = afterNext.find((entry) => entry.symbolKey === CALLER_KEY);
  assert.equal(nextEntry.status, 'enriched');
  assert.equal(nextEntry.narrativeHash, await expectedHash({
    code: CONSUMER_CODE,
    signature: callerContext.signature,
    role: callerContext.role,
    callees: [[CALLEE_KEY, newCalleeSummary]],
  }));
  assert.equal(nextEntry.calleeSummaryHashes[CALLEE_KEY],
    (await hashCalleeSummaries({ [CALLEE_KEY]: newCalleeSummary }))[CALLEE_KEY],
    'regeneration stores the accepted exact summary hash knowledge');
});

// -------------------------------------------------------------------
// Legacy parity: without a resolver nothing about the old flow changes.
// -------------------------------------------------------------------

test('the legacy flow persists exactly the historical keys with no fingerprint metadata', async () => {
  const fixture = await createQueueFixture({ files: { 'src/classify.js': BRANCHY_JS }, symbols: [branchySymbol()] });
  const provider = [];

  const result = await runQueueSymbolEnrichment({
    symbol: branchySymbol(),
    projectRoot: fixture.projectRoot,
    projectSlug: 'n5b-fixture',
    timeoutMs: 30_000,
    enrichmentDir: fixture.dirs.enrichment,
    worklist: await readJsonArtifact(fixture.worklistFile),
    worklistFile: fixture.worklistFile,
    symbolIndex: {},
    symbolIndexFile: fixture.symbolIndexFile,
    config: { preferredModes: ['local-model'] },
    providers: [],
    runEnrichmentWithFallbackImpl: async () => {
      provider.push(1);
      return succeededResult('Classifies values into buckets.');
    },
  });

  assert.equal(result.status, 'enriched');
  assert.ok(!('promptVersion' in result), 'legacy results stay free of narrative metadata');
  assert.equal(provider.length, 1);

  const memory = await readJsonArtifact(memoryFileOf(fixture.dirs.enrichment, BRANCHY_KEY));
  assert.deepEqual(Object.keys(memory).sort(), ['category', 'content', 'tags'],
    'the legacy memory payload keeps exactly its historical keys');
  assert.ok(!('narrativeEvidence' in memory));

  const worklist = await readJsonArtifact(fixture.worklistFile);
  assert.ok(!('narrativeHash' in worklist[0]));
  assert.ok(!('calleeSummaryHashes' in worklist[0]));
  assert.ok(!('promptVersion' in worklist[0]));

  const index = await readJsonArtifact(fixture.symbolIndexFile);
  assert.deepEqual(Object.keys(index[BRANCHY_KEY]).sort(),
    ['codeHash', 'graphNodeId', 'lastEnrichedAt', 'memoryId', 'semanticSummary', 'status'],
    'the legacy index record keeps exactly its historical keys');
});

function makeCalleeContext() {
  return {
    symbolKeys: [CALLEE_KEY],
    signature: 'export function normalize(value)',
    role: { role: 'util', layer: 'shared', confidence: 0.85, evidence: [] },
    callees: [],
    callers: [],
    fileCardSummary: 'Normalization helpers.',
    projectRules: [],
  };
}

// -------------------------------------------------------------------
// B1 metadata coherence control: ALL prompt/fingerprint inputs are owned
// before the first await, and the caller-owned object stays untouched.
// -------------------------------------------------------------------

test('B1 metadata isolation: Set symbolKeys and nested role inputs are owned before the first await, and the caller-owned context is never mutated or frozen', async () => {
  const fixture = await createQueueFixture({ files: { 'src/classify.js': BRANCHY_JS }, symbols: [branchySymbol()] });
  const context = makeContext({
    symbolKeys: new Set([BRANCHY_KEY, CALLEE_KEY, DECOY_KEY]),
    role: { role: 'extractor', layer: 'domain', confidence: 0.9, evidence: [{ signal: 'decorator', weight: 0.4 }] },
  });
  const original = structuredClone(context);
  let sent;
  const consoleStub = stubConsole();
  try {
    await main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      narrativeResolver: async () => context,
      countPromptTokensImpl: async () => {
        // The awaited hook mutates every fingerprint-relevant metadata
        // field of the caller-owned object AFTER the prompt was built —
        // the classic shared-alias race this control pins down.
        context.signature = 'export function classify(mutated)';
        context.role.layer = 'infrastructure';
        context.callees[0].summary = 'Mutated while awaiting.';
        return 400;
      },
      runEnrichmentWithFallbackImpl: async ({ request }) => {
        sent = request.prompt;
        return succeededResult(JSON.stringify(validNarrative()));
      },
    });
  } finally {
    consoleStub.restore();
  }

  // The prompt still shows the pre-await snapshot values.
  assert.ok(sent.includes(original.signature), 'the prompt is built from the snapshot, never the mutated alias');
  assert.ok(sent.includes(CALLEE_SUMMARY));
  assert.ok(!sent.includes('Mutated while awaiting.'));

  // The accepted fingerprint is the oracle over the ORIGINAL inputs —
  // nested role object and full callee summary included — not over the
  // later-mutated alias.
  const expected = await expectedHash({
    code: BRANCHY_CODE,
    signature: original.signature,
    role: original.role,
    callees: [[CALLEE_KEY, CALLEE_SUMMARY]],
  });
  const row = (await readJsonArtifact(fixture.worklistFile))[0];
  assert.equal(row.narrativeHash, expected, 'all five fingerprint inputs must come from the pre-await snapshot');
  assert.deepEqual(row.calleeSummaryHashes, await hashCalleeSummaries({ [CALLEE_KEY]: CALLEE_SUMMARY }));
  assert.equal(row.promptVersion, 'v2');

  // Set-typed symbolKeys survive the snapshot: the narrative validated
  // against the Set keys and persisted byte-identically.
  const memory = await readJsonArtifact(memoryFileOf(fixture.dirs.enrichment, BRANCHY_KEY));
  assert.deepEqual(JSON.parse(memory.content), validNarrative());

  // The queue never wrote to (or froze) the caller-owned object: after
  // restoring ONLY this test's own hook mutations it is deep-equal to the
  // original — same keys, same Set type, same nested arrays/objects.
  context.signature = original.signature;
  context.role.layer = original.role.layer;
  context.callees[0].summary = original.callees[0].summary;
  assert.deepEqual(context, original, 'the queue must never mutate the caller-owned context');
  assert.ok(context.symbolKeys instanceof Set, 'the caller Set must stay a Set, never replaced or rewritten');
  assert.equal(Object.isFrozen(context), false, 'the queue must never freeze caller-owned data');
  assert.equal(Object.isFrozen(context.role), false);
  assert.equal(Object.isFrozen(context.callees[0]), false);
});
