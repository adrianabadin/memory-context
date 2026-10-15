/**
 * N3 (accepted plan 3.3 / spec S9) — subagent route schema transport.
 *
 * appendSubagentQueue can carry promptVersion, the shared NARRATIVE_SCHEMA and
 * the known canonical graph keys for opt-in entries; legacy entries stay
 * byte-identical without those fields. pmc subagent-apply consumes that
 * metadata: narrative entries are validated (schema identity, prompt version,
 * JSON shape, mention membership) before anything is persisted, and invalid
 * output marks the entry as error instead of enriched. Legacy entries keep the
 * exact original apply behavior.
 */

import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { appendSubagentQueue, loadSubagentQueue } from '../src/subagent-queue.mjs';
import { ensureProjectMemoryContextDirs, readJsonArtifact } from '../src/artifacts.mjs';
import { main as subagentApply } from '../cli/subagent-apply.mjs';
import { NARRATIVE_SCHEMA } from '../src/cards/narrative-schema.mjs';
import { computeNarrativeHash, hashCalleeSummaries } from '../src/hash.mjs';

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

const SYMBOL_KEY = 'ts|src/user.ts|function|exported|getUser|3';
const KNOWN_KEYS = [
  SYMBOL_KEY,
  'ts|src/db.ts|function|exported|find|1',
  'ts|src/api.ts|function|exported|listUsers|1',
];

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

async function createApplyFixture({ entryOptions, content, worklistStatus = 'subagent-queued' } = {}) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-subagent-apply-'));
  ownedFixtureRoots.add(projectRoot);
  fixtureRootsCreated += 1;
  const dirs = await ensureProjectMemoryContextDirs(projectRoot);
  const enrichmentDir = dirs.enrichment;

  const worklist = [{
    symbolKey: SYMBOL_KEY,
    name: 'getUser',
    filePath: 'src/user.ts',
    language: 'ts',
    kind: 'function',
    codeHash: 'hash-a',
    graphNodeId: null,
    status: worklistStatus,
  }];
  await writeJson(join(enrichmentDir, 'worklist.json'), worklist);
  await writeJson(join(enrichmentDir, 'symbol-index.json'), {});

  const entry = await appendSubagentQueue(enrichmentDir, {
    symbolKey: SYMBOL_KEY,
    name: 'getUser',
    filePath: 'src/user.ts',
    language: 'ts',
    kind: 'function',
    tokenCount: 9000,
    prompt: 'Prompt v2 text',
    queuedAt: '2026-10-13T12:00:00.000Z',
    ...entryOptions,
  });

  const contentFile = join(projectRoot, 'subagent-content.txt');
  await writeFile(contentFile, content, 'utf8');

  return { projectRoot, enrichmentDir, worklistFile: join(enrichmentDir, 'worklist.json'), entry, contentFile };
}

async function writeJson(path, data) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function narrativeEntryOptions(overrides = {}) {
  return {
    promptVersion: 'v2',
    schema: NARRATIVE_SCHEMA,
    knownGraphKeys: [...KNOWN_KEYS],
    ...overrides,
  };
}

function memoryFileFor(enrichmentDir) {
  const safeKey = SYMBOL_KEY.replace(/[^a-zA-Z0-9_-]+/g, '_');
  return join(enrichmentDir, `${safeKey}.memory.json`);
}

async function applyFor(fixture) {
  return subagentApply([
    fixture.projectRoot,
    '--entry-id',
    fixture.entry.id,
    '--content-file',
    fixture.contentFile,
  ]);
}

// -------------------------------------------------------------------
// Narrative entries: validated before persistence
// -------------------------------------------------------------------

test('apply persists a validated narrative entry as canonical JSON with its validated summary', async () => {
  const narrative = validNarrative();
  const fixture = await createApplyFixture({
    entryOptions: narrativeEntryOptions(),
    content: JSON.stringify(narrative),
  });

  const exitCode = await applyFor(fixture);
  assert.equal(exitCode, 0);

  const memoryPayload = await readJsonArtifact(memoryFileFor(fixture.enrichmentDir));
  assert.equal(memoryPayload.content, `${JSON.stringify(narrative, null, 2)}`);
  assert.deepEqual(JSON.parse(memoryPayload.content), narrative);

  const worklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(worklist[0].status, 'enriched');

  const symbolIndex = await readJsonArtifact(join(fixture.enrichmentDir, 'symbol-index.json'));
  assert.equal(symbolIndex[SYMBOL_KEY].status, 'enriched');
  assert.equal(symbolIndex[SYMBOL_KEY].semanticSummary, narrative.summary);

  const queue = await loadSubagentQueue(fixture.enrichmentDir);
  assert.equal(queue.entries[0].status, 'done');
  assert.ok(queue.entries[0].memoryId);
});

test('apply rejects invalid narrative JSON and marks the entry error instead of enriched', async () => {
  const fixture = await createApplyFixture({
    entryOptions: narrativeEntryOptions(),
    content: 'this is not a narrative object',
  });

  const exitCode = await applyFor(fixture);
  assert.equal(exitCode, 1);

  const queue = await loadSubagentQueue(fixture.enrichmentDir);
  assert.equal(queue.entries[0].status, 'error');
  assert.match(queue.entries[0].error, /narrative validation failed/i);
  assert.match(queue.entries[0].error, /JSON object/);

  const worklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(worklist[0].status, 'subagent-queued', 'invalid output must not be enriched');

  await assert.rejects(access(memoryFileFor(fixture.enrichmentDir)), { code: 'ENOENT' });
});

test('apply rejects narrative mentions that are not known graph keys', async () => {
  const narrative = validNarrative({ mentions: ['ghost|missing|key'] });
  const fixture = await createApplyFixture({
    entryOptions: narrativeEntryOptions(),
    content: JSON.stringify(narrative),
  });

  const exitCode = await applyFor(fixture);
  assert.equal(exitCode, 1);

  const queue = await loadSubagentQueue(fixture.enrichmentDir);
  assert.equal(queue.entries[0].status, 'error');
  assert.match(queue.entries[0].error, /Mention does not exist in graph: ghost\|missing\|key/);

  const worklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(worklist[0].status, 'subagent-queued');
  await assert.rejects(access(memoryFileFor(fixture.enrichmentDir)), { code: 'ENOENT' });
});

test('apply rejects an entry whose queued schema is not the shared NARRATIVE_SCHEMA', async () => {
  const fixture = await createApplyFixture({
    entryOptions: narrativeEntryOptions({ schema: { type: 'object' } }),
    content: JSON.stringify(validNarrative()),
  });

  const exitCode = await applyFor(fixture);
  assert.equal(exitCode, 1);

  const queue = await loadSubagentQueue(fixture.enrichmentDir);
  assert.equal(queue.entries[0].status, 'error');
  assert.match(queue.entries[0].error, /narrative schema/);

  const worklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(worklist[0].status, 'subagent-queued');
  await assert.rejects(access(memoryFileFor(fixture.enrichmentDir)), { code: 'ENOENT' });
});

// -------------------------------------------------------------------
// Legacy entries: exact original behavior preserved
// -------------------------------------------------------------------

test('apply persists legacy entries verbatim without narrative validation', async () => {
  const fixture = await createApplyFixture({
    content: 'Responsibility: Looks up a user by id.',
  });

  const exitCode = await applyFor(fixture);
  assert.equal(exitCode, 0);

  const memoryPayload = await readJsonArtifact(memoryFileFor(fixture.enrichmentDir));
  assert.equal(memoryPayload.content, 'Responsibility: Looks up a user by id.');

  const worklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(worklist[0].status, 'enriched');

  const queue = await loadSubagentQueue(fixture.enrichmentDir);
  assert.equal(queue.entries[0].status, 'done');
  assert.ok(!('promptVersion' in queue.entries[0]));
  assert.ok(!('schema' in queue.entries[0]));
});

// ── Partial narrative metadata rejects before any queue write (N3 B3) ───────

test('appendSubagentQueue rejects partial or malformed narrative metadata without writing the queue', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-subagent-partial-'));
  ownedFixtureRoots.add(projectRoot);
  fixtureRootsCreated += 1;
  const dirs = await ensureProjectMemoryContextDirs(projectRoot);
  const base = {
    symbolKey: SYMBOL_KEY,
    name: 'getUser',
    filePath: 'src/user.ts',
    language: 'ts',
    kind: 'function',
    prompt: 'p',
  };

  const before = await loadSubagentQueue(dirs.enrichment);
  await assert.rejects(appendSubagentQueue(dirs.enrichment, { ...base, promptVersion: 'v2' }), TypeError,
    'promptVersion without schema/knownGraphKeys must not become a silent legacy entry');
  await assert.rejects(appendSubagentQueue(dirs.enrichment, { ...base, schema: NARRATIVE_SCHEMA }), TypeError,
    'schema without promptVersion/knownGraphKeys must not become a silent legacy entry');
  await assert.rejects(
    appendSubagentQueue(dirs.enrichment, {
      ...base,
      promptVersion: 'v2',
      schema: NARRATIVE_SCHEMA,
      knownGraphKeys: 'not-a-collection',
    }),
    TypeError,
    'a malformed knownGraphKeys collection must be rejected',
  );
  assert.deepEqual(await loadSubagentQueue(dirs.enrichment), before, 'rejected metadata must leave the queue untouched');
});

// -------------------------------------------------------------------
// N5B (plan 3.5 / S11): transported fingerprint evidence never lets
// rejected content reach an accepted write.
// -------------------------------------------------------------------

async function buildEvidence(overrides = {}) {
  const calleeSummaryHashes = await hashCalleeSummaries({
    'ts|src/db.ts|function|exported|find|1': 'Returns one row by primary key.',
  });
  const narrativeHash = await computeNarrativeHash({
    code: 'export async function getUser(id) {\n  return id;\n}',
    signature: 'export async function getUser(id)',
    role: { role: 'repository', layer: 'domain', confidence: 0.9, evidence: [] },
    calleeSummaryHashes,
    promptVersion: 'v2',
  });
  return {
    symbolKey: SYMBOL_KEY,
    narrativeHash,
    calleeSummaryHashes,
    promptVersion: 'v2',
    signature: 'export async function getUser(id)',
    role: { role: 'repository', layer: 'domain', confidence: 0.9, evidence: [] },
    range: { startLine: 3, endLine: 8 },
    ...overrides,
  };
}

test('apply with valid transported evidence still rejects invalid narrative content before any accepted write', async () => {
  const narrative = validNarrative({ mentions: ['ghost|missing|key'] });
  const fixture = await createApplyFixture({
    entryOptions: narrativeEntryOptions({ narrativeEvidence: await buildEvidence() }),
    content: JSON.stringify(narrative),
  });

  const exitCode = await applyFor(fixture);
  assert.equal(exitCode, 1);

  const queue = await loadSubagentQueue(fixture.enrichmentDir);
  assert.equal(queue.entries[0].status, 'error');
  assert.match(queue.entries[0].error, /Mention does not exist in graph: ghost\|missing\|key/);

  const worklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(worklist[0].status, 'subagent-queued');
  assert.ok(!('narrativeHash' in worklist[0]), 'a rejected apply must not persist the transported fingerprint');
  assert.ok(!('calleeSummaryHashes' in worklist[0]));
  assert.ok(!('promptVersion' in worklist[0]));

  const symbolIndex = await readJsonArtifact(join(fixture.enrichmentDir, 'symbol-index.json'));
  assert.deepEqual(symbolIndex, {});
  await assert.rejects(access(memoryFileFor(fixture.enrichmentDir)), { code: 'ENOENT' });
});

test('apply with valid transported evidence preserves previously accepted fingerprint, memory bytes and index record when the queued content is invalid', async () => {
  const fixture = await createApplyFixture({
    entryOptions: narrativeEntryOptions({ narrativeEvidence: await buildEvidence() }),
    content: 'this is not a narrative object',
  });

  const memoryFile = memoryFileFor(fixture.enrichmentDir);
  await writeFile(memoryFile, 'accepted before\n', 'utf8');
  const acceptedIndex = {
    [SYMBOL_KEY]: {
      memoryId: 'old-memory',
      graphNodeId: null,
      codeHash: 'hash-a',
      status: 'enriched',
      lastEnrichedAt: '2026-10-01T00:00:00.000Z',
      semanticSummary: 'Accepted before.',
      narrativeHash: 'accepted-fp',
      calleeSummaryHashes: { 'ts|src/db.ts|function|exported|find|1': 'accepted-hash' },
      promptVersion: 'v2',
    },
  };
  await writeJson(join(fixture.enrichmentDir, 'symbol-index.json'), acceptedIndex);

  const exitCode = await applyFor(fixture);
  assert.equal(exitCode, 1);

  const queue = await loadSubagentQueue(fixture.enrichmentDir);
  assert.equal(queue.entries[0].status, 'error');

  const worklist = await readJsonArtifact(fixture.worklistFile);
  assert.equal(worklist[0].status, 'subagent-queued');
  assert.ok(!('narrativeHash' in worklist[0]));

  assert.equal(await readFile(memoryFile, 'utf8'), 'accepted before\n',
    'accepted memory bytes must survive a rejected apply');
  assert.deepEqual(await readJsonArtifact(join(fixture.enrichmentDir, 'symbol-index.json')), acceptedIndex,
    'the previously accepted fingerprint and summary must survive a rejected apply');
});
