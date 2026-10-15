/**
 * F3 N5B (accepted plan 3.5 / spec S11) — subagent route fingerprint
 * transport and source-freshness rejection.
 *
 * `appendSubagentQueue` transports the COMPLETE opt-in fingerprint evidence
 * (symbolKey, narrativeHash, calleeSummaryHashes, promptVersion, signature,
 * role, range) for narrative entries; partial, malformed or inconsistent
 * evidence rejects with TypeError before the queue file is read or written.
 * `pmc subagent-apply` validates the transported evidence against the ACTUAL
 * current source bytes before any accepted write: when the source changed (or
 * became unavailable) after queueing, or the queued fingerprint is otherwise
 * inconsistent, the apply is rejected — the entry is marked `error`, the
 * worklist entry is marked `stale` for the next pass, and no memory file,
 * index record or sync-manifest entry is written. Only a validated,
 * source-fresh apply persists the aligned fingerprint. Legacy entries without
 * fingerprint evidence keep the exact original apply contract.
 */

import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { appendSubagentQueue, loadSubagentQueue } from '../src/subagent-queue.mjs';
import { ensureProjectMemoryContextDirs, readJsonArtifact } from '../src/artifacts.mjs';
import { main as subagentApply } from '../cli/subagent-apply.mjs';
import { computeNarrativeHash, hashCalleeSummaries } from '../src/hash.mjs';
import { NARRATIVE_SCHEMA } from '../src/cards/narrative-schema.mjs';

let ownedFixtureRoots = new Set();
let fixtureRootsCreated = 0;
let fixtureRootsRemoved = 0;
let consoleStub = null;

beforeEach(() => {
  ownedFixtureRoots = new Set();
  fixtureRootsCreated = 0;
  fixtureRootsRemoved = 0;
  const originalLog = console.log;
  const originalError = console.error;
  consoleStub = { logs: [], errors: [] };
  console.log = (...args) => { consoleStub.logs.push(args.join(' ')); };
  console.error = (...args) => { consoleStub.errors.push(args.join(' ')); };
  consoleStub.restore = () => {
    console.log = originalLog;
    console.error = originalError;
  };
});

afterEach(async () => {
  const failures = [];
  try {
    if (consoleStub) consoleStub.restore();
  } catch (error) {
    failures.push(error);
  } finally {
    consoleStub = null;
  }
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
    assert.equal(fixtureRootsRemoved, fixtureRootsCreated, 'every owned fixture root must be removed');
  } catch (error) {
    failures.push(error);
  } finally {
    ownedFixtureRoots.clear();
  }
  if (failures.length) throw new AggregateError(failures, 'test teardown failed');
});

const SYMBOL_KEY = 'js|src/classify.js|function|exported|classify|1';
const CALLEE_KEY = 'js|src/normalize.js|function|exported|normalize|1';
const DECOY_KEY = 'js|src/api.js|function|exported|handle|1';
const KNOWN_KEYS = [SYMBOL_KEY, CALLEE_KEY, DECOY_KEY];
const CALLEE_SUMMARY = 'Normalizes a raw value into the canonical shape.';

const SOURCE_JS = [
  'export function classify(value) {',
  '  if (!value) {',
  "    throw new TypeError('value required');",
  '  }',
  "  return typeof value === 'string' ? 'text' : 'other';",
  '}',
  '',
  '// padding',
].join('\n');

const RANGE = { startLine: 1, endLine: 6 };
const CODE = SOURCE_JS.split('\n').slice(0, 6).join('\n');
const SIGNATURE = 'export function classify(value)';
const ROLE = { role: 'extractor', layer: 'domain', confidence: 0.9, evidence: [] };

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

async function buildEvidence(overrides = {}) {
  const calleeSummaryHashes = await hashCalleeSummaries({ [CALLEE_KEY]: CALLEE_SUMMARY });
  const narrativeHash = await computeNarrativeHash({
    code: overrides.code ?? CODE,
    signature: overrides.signature ?? SIGNATURE,
    role: overrides.role ?? ROLE,
    calleeSummaryHashes,
    promptVersion: 'v2',
  });
  return {
    symbolKey: SYMBOL_KEY,
    narrativeHash,
    calleeSummaryHashes,
    promptVersion: 'v2',
    signature: SIGNATURE,
    role: ROLE,
    range: { ...RANGE },
    ...overrides,
  };
}

async function createFixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-n5b-subagent-'));
  ownedFixtureRoots.add(projectRoot);
  fixtureRootsCreated += 1;
  const dirs = await ensureProjectMemoryContextDirs(projectRoot);
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await writeFile(join(projectRoot, 'src/classify.js'), SOURCE_JS, 'utf8');

  const worklist = [{
    symbolKey: SYMBOL_KEY,
    name: 'classify',
    filePath: 'src/classify.js',
    language: 'js',
    kind: 'function',
    codeHash: 'hash-classify',
    graphNodeId: null,
    range: { ...RANGE },
    status: 'subagent-queued',
  }];
  await writeJson(join(dirs.enrichment, 'worklist.json'), worklist);
  await writeJson(join(dirs.enrichment, 'symbol-index.json'), {});

  return {
    projectRoot,
    enrichmentDir: dirs.enrichment,
    worklistFile: join(dirs.enrichment, 'worklist.json'),
    symbolIndexFile: join(dirs.enrichment, 'symbol-index.json'),
  };
}

async function writeJson(path, data) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function queueEntry(fixture, extra = {}) {
  return appendSubagentQueue(fixture.enrichmentDir, {
    symbolKey: SYMBOL_KEY,
    name: 'classify',
    filePath: 'src/classify.js',
    language: 'js',
    kind: 'function',
    tokenCount: 9000,
    prompt: 'Prompt v2 text',
    queuedAt: '2026-10-15T12:00:00.000Z',
    promptVersion: 'v2',
    schema: NARRATIVE_SCHEMA,
    knownGraphKeys: [...KNOWN_KEYS],
    ...extra,
  });
}

async function applyFor(fixture, entry, content) {
  const contentFile = join(fixture.projectRoot, `content-${entry.id}.txt`);
  await writeFile(contentFile, content, 'utf8');
  return subagentApply([fixture.projectRoot, '--entry-id', entry.id, '--content-file', contentFile]);
}

function memoryFileFor(fixture) {
  return join(fixture.enrichmentDir, `${SYMBOL_KEY.replace(/[^a-zA-Z0-9_-]+/g, '_')}.memory.json`);
}

// -------------------------------------------------------------------
// Transport: the complete fingerprint bundle rides the queue entry.
// -------------------------------------------------------------------

test('appendSubagentQueue transports the complete opt-in fingerprint evidence', async () => {
  const fixture = await createFixture();
  const evidence = await buildEvidence();

  const entry = await queueEntry(fixture, { narrativeEvidence: evidence });

  assert.deepEqual(entry.narrativeEvidence, evidence,
    'every evidence field reaches the queue entry: symbolKey, narrativeHash, calleeSummaryHashes, promptVersion, signature, role, range');

  const stored = await loadSubagentQueue(fixture.enrichmentDir);
  assert.deepEqual(stored.entries[0].narrativeEvidence, evidence);
  assert.equal(stored.entries[0].promptVersion, 'v2');
  assert.deepEqual(stored.entries[0].knownGraphKeys, KNOWN_KEYS);
});

test('appendSubagentQueue rejects partial, malformed or inconsistent evidence before any queue read or write', async () => {
  const fixture = await createFixture();
  const evidence = await buildEvidence();
  const before = await loadSubagentQueue(fixture.enrichmentDir);

  const partials = [
    ['missing signature', { signature: undefined }],
    ['missing role', { role: undefined }],
    ['missing range', { range: undefined }],
    ['zero start line', { range: { startLine: 0, endLine: 6 } }],
    ['reversed range', { range: { startLine: 6, endLine: 1 } }],
    ['empty narrativeHash', { narrativeHash: '' }],
    ['non-string narrativeHash', { narrativeHash: 42 }],
    ['empty promptVersion', { promptVersion: '' }],
    ['promptVersion inconsistent with the trio', { promptVersion: 'v1' }],
    ['foreign symbolKey', { symbolKey: DECOY_KEY }],
    ['raw graph id callee key', { calleeSummaryHashes: { node_123: 'abc' } }],
    ['non-string callee hash', { calleeSummaryHashes: { [CALLEE_KEY]: 7 } }],
    ['missing calleeSummaryHashes', { calleeSummaryHashes: undefined }],
    ['non-string signature', { signature: 42 }],
  ];

  for (const [label, patch] of partials) {
    const malformed = { ...evidence, ...patch };
    if ('signature' in patch && patch.signature === undefined) delete malformed.signature;
    if ('role' in patch && patch.role === undefined) delete malformed.role;
    if ('range' in patch && patch.range === undefined) delete malformed.range;
    if ('calleeSummaryHashes' in patch && patch.calleeSummaryHashes === undefined) delete malformed.calleeSummaryHashes;
    await assert.rejects(
      appendSubagentQueue(fixture.enrichmentDir, {
        symbolKey: SYMBOL_KEY,
        name: 'classify',
        filePath: 'src/classify.js',
        language: 'js',
        kind: 'function',
        prompt: 'p',
        promptVersion: 'v2',
        schema: NARRATIVE_SCHEMA,
        knownGraphKeys: [...KNOWN_KEYS],
        narrativeEvidence: malformed,
      }),
      TypeError,
      `${label} must reject with TypeError before the queue file is touched`,
    );
  }

  // Evidence without the narrative trio must not silently become a legacy entry.
  await assert.rejects(
    appendSubagentQueue(fixture.enrichmentDir, {
      symbolKey: SYMBOL_KEY,
      name: 'classify',
      filePath: 'src/classify.js',
      language: 'js',
      kind: 'function',
      prompt: 'p',
      narrativeEvidence: evidence,
    }),
    TypeError,
    'fingerprint evidence requires the complete narrative metadata trio',
  );

  assert.deepEqual(await loadSubagentQueue(fixture.enrichmentDir), before,
    'every rejected call leaves the queue file untouched');
});

// -------------------------------------------------------------------
// Apply: validated + source-fresh evidence persists the aligned bundle.
// -------------------------------------------------------------------

test('subagent-apply persists a validated source-fresh fingerprint aligned across worklist, index and accepted artifact', async () => {
  const fixture = await createFixture();
  const evidence = await buildEvidence();
  const entry = await queueEntry(fixture, { narrativeEvidence: evidence });

  const exitCode = await applyFor(fixture, entry, JSON.stringify(validNarrative()));
  assert.equal(exitCode, 0);

  const worklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(worklist[0].status, 'enriched');
  assert.equal(worklist[0].narrativeHash, evidence.narrativeHash);
  assert.deepEqual(worklist[0].calleeSummaryHashes, evidence.calleeSummaryHashes);
  assert.equal(worklist[0].promptVersion, 'v2');

  const index = await readJsonArtifact(fixture.symbolIndexFile);
  assert.equal(index[SYMBOL_KEY].status, 'enriched');
  assert.equal(index[SYMBOL_KEY].narrativeHash, evidence.narrativeHash);
  assert.deepEqual(index[SYMBOL_KEY].calleeSummaryHashes, evidence.calleeSummaryHashes);
  assert.equal(index[SYMBOL_KEY].promptVersion, 'v2');
  assert.equal(index[SYMBOL_KEY].semanticSummary, validNarrative().summary);

  const memory = await readJsonArtifact(memoryFileFor(fixture));
  assert.deepEqual(memory.narrativeEvidence, {
    symbolKey: SYMBOL_KEY,
    narrativeHash: evidence.narrativeHash,
    calleeSummaryHashes: evidence.calleeSummaryHashes,
    promptVersion: 'v2',
  });
  assert.deepEqual(JSON.parse(memory.content), validNarrative());

  const queue = await loadSubagentQueue(fixture.enrichmentDir);
  assert.equal(queue.entries[0].status, 'done');
  assert.ok(queue.entries[0].memoryId);
});

// -------------------------------------------------------------------
// Apply: stale or inconsistent queued fingerprints reject before writes.
// -------------------------------------------------------------------

test('subagent-apply rejects a queued fingerprint whose source changed after queueing, before any accepted write', async () => {
  const fixture = await createFixture();
  const evidence = await buildEvidence();
  const entry = await queueEntry(fixture, { narrativeEvidence: evidence });

  // The source changes between queue and apply.
  await writeFile(
    join(fixture.projectRoot, 'src/classify.js'),
    SOURCE_JS.replace('return typeof', '// touched\n  return typeof'),
    'utf8',
  );

  const exitCode = await applyFor(fixture, entry, JSON.stringify(validNarrative()));
  assert.equal(exitCode, 1);

  assert.ok(consoleStub.errors.some((line) => /fingerprint/i.test(line)),
    'the rejection reports the stale queued fingerprint');

  const queue = await loadSubagentQueue(fixture.enrichmentDir);
  assert.equal(queue.entries[0].status, 'error');
  assert.match(queue.entries[0].error, /fingerprint/i);

  const worklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(worklist[0].status, 'stale', 'the stale entry is marked for the next pass');
  assert.equal(worklist[0].staleReason, 'queued-fingerprint-mismatch');
  assert.ok(!('narrativeHash' in worklist[0]), 'no fingerprint may be persisted from a rejected apply');

  const index = await readJsonArtifact(fixture.symbolIndexFile);
  assert.deepEqual(index, {}, 'no index record may be written by a rejected apply');
  await assert.rejects(access(memoryFileFor(fixture)), { code: 'ENOENT' },
    'no memory file may be written by a rejected apply');
  const manifest = await readJsonArtifact(join(fixture.enrichmentDir, 'sync-manifest.json'), { entries: [] });
  assert.deepEqual(manifest.entries, [], 'no sync-manifest entry may be written by a rejected apply');
});

test('subagent-apply fails closed when the queued source is unavailable', async () => {
  const fixture = await createFixture();
  const evidence = await buildEvidence();
  const entry = await queueEntry(fixture, { narrativeEvidence: evidence });

  await rm(join(fixture.projectRoot, 'src/classify.js'));

  const exitCode = await applyFor(fixture, entry, JSON.stringify(validNarrative()));
  assert.equal(exitCode, 1);

  const queue = await loadSubagentQueue(fixture.enrichmentDir);
  assert.equal(queue.entries[0].status, 'error');
  assert.match(queue.entries[0].error, /source unavailable/i);

  const worklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(worklist[0].status, 'stale');
  assert.equal(worklist[0].staleReason, 'queued-fingerprint-mismatch');
  const index = await readJsonArtifact(fixture.symbolIndexFile);
  assert.deepEqual(index, {});
  await assert.rejects(access(memoryFileFor(fixture)), { code: 'ENOENT' });
});

test('subagent-apply rejects tampered transported evidence that no longer matches its own inputs', async () => {
  const fixture = await createFixture();
  const evidence = await buildEvidence();
  const entry = await queueEntry(fixture, { narrativeEvidence: evidence });

  // Tamper the stored signature: the recomputed fingerprint no longer matches
  // the transported narrativeHash even though the source is unchanged.
  const queueFile = join(fixture.enrichmentDir, 'subagent-queue.json');
  const queueRaw = JSON.parse(await readFile(queueFile, 'utf8'));
  queueRaw.entries[0].narrativeEvidence.signature = 'export function classify(value /* tampered */)';
  await writeJson(queueFile, queueRaw);

  const exitCode = await applyFor(fixture, entry, JSON.stringify(validNarrative()));
  assert.equal(exitCode, 1);

  const queue = await loadSubagentQueue(fixture.enrichmentDir);
  assert.equal(queue.entries[0].status, 'error');
  assert.match(queue.entries[0].error, /fingerprint/i);
  await assert.rejects(access(memoryFileFor(fixture)), { code: 'ENOENT' });
  assert.deepEqual(await readJsonArtifact(fixture.symbolIndexFile), {});
});

test('subagent-apply rejects an incomplete tampered evidence bundle without any accepted write', async () => {
  const fixture = await createFixture();
  const evidence = await buildEvidence();
  const entry = await queueEntry(fixture, { narrativeEvidence: evidence });

  const queueFile = join(fixture.enrichmentDir, 'subagent-queue.json');
  const queueRaw = JSON.parse(await readFile(queueFile, 'utf8'));
  delete queueRaw.entries[0].narrativeEvidence.role;
  await writeJson(queueFile, queueRaw);
  const queueBytes = await readFile(queueFile, 'utf8');

  const exitCode = await applyFor(fixture, entry, JSON.stringify(validNarrative()));
  assert.equal(exitCode, 1);

  const queue = await loadSubagentQueue(fixture.enrichmentDir);
  assert.equal(queue.entries[0].status, 'error');
  assert.match(queue.entries[0].error, /evidence/i);
  assert.deepEqual(await readJsonArtifact(fixture.symbolIndexFile), {});
  await assert.rejects(access(memoryFileFor(fixture)), { code: 'ENOENT' });
  assert.notEqual(await readFile(queueFile, 'utf8'), queueBytes, 'the rejected apply records its own error state');
});

// -------------------------------------------------------------------
// Legacy contract: trio-only entries keep the original apply behavior.
// -------------------------------------------------------------------

test('subagent-apply persists a trio-only narrative entry without any fingerprint metadata', async () => {
  const fixture = await createFixture();
  const entry = await queueEntry(fixture);

  const exitCode = await applyFor(fixture, entry, JSON.stringify(validNarrative()));
  assert.equal(exitCode, 0);

  const worklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(worklist[0].status, 'enriched');
  assert.ok(!('narrativeHash' in worklist[0]), 'legacy entries gain no fingerprint field');
  assert.ok(!('calleeSummaryHashes' in worklist[0]));
  assert.ok(!('promptVersion' in worklist[0]));

  const index = await readJsonArtifact(fixture.symbolIndexFile);
  assert.equal(index[SYMBOL_KEY].status, 'enriched');
  assert.ok(!('narrativeHash' in index[SYMBOL_KEY]));

  const memory = await readJsonArtifact(memoryFileFor(fixture));
  assert.ok(!('narrativeEvidence' in memory), 'the legacy memory payload keeps exactly its historical keys');
  assert.deepEqual(Object.keys(memory).sort(), ['category', 'content', 'tags']);

  const queue = await loadSubagentQueue(fixture.enrichmentDir);
  assert.equal(queue.entries[0].status, 'done');
});
