/**
 * F3 N6B (accepted plan 3.6 / spec S12) — the in-process serialized writer and
 * bounded file-lock retry that keep concurrent provider completions from
 * overlapping an unlocked loadJson -> merge -> writeFile on the enrichment
 * files.
 *
 * `src/cards/queue-state-io.mjs` provides ONE coordinator per canonical
 * enrichment directory (path-canonical, shared across every call site in the
 * process — direct runner and subagent apply alike), reentrant so a scoped
 * multi-file transaction can call the locked leaf helpers without deadlocking,
 * and it drains its registry after idle so repeated runs never leak scope
 * keys. File operations get a bounded exponential retry for the transient
 * Windows lock codes EBUSY/EPERM ONLY (EACCES is not part of any documented
 * lock contract here), around file operations only — never a provider or
 * tokenizer call. Non-lock failures (EIO, validation, EACCES) fail
 * immediately, an exhausted retry rejects with the lock error instead of
 * claiming success, and the atomic temp+rename write leaves the previous
 * target bytes untouched on any failure (cleanup removes only this module's
 * own runtime temp file).
 *
 * All timing is controlled through injected file ops (counters and a no-op
 * sleep), never wall-clock assertions.
 */

import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  QUEUE_LOCK_RETRY_CODES,
  enrichmentWriteScopeCount,
  readJsonFile,
  setQueueStateFileOps,
  withEnrichmentWrite,
  withFileLockRetry,
  writeJsonFile,
} from '../src/cards/queue-state-io.mjs';

const ownedRoots = new Set();
let restoreFileOps = null;

beforeEach(() => {
  restoreFileOps = null;
});

afterEach(async () => {
  const failures = [];
  if (restoreFileOps) {
    try {
      restoreFileOps();
    } catch (error) {
      failures.push(error);
    } finally {
      restoreFileOps = null;
    }
  }
  try {
    assert.equal(enrichmentWriteScopeCount(), 0, 'the scope registry must drain after every idle operation');
  } catch (error) {
    failures.push(error);
  }
  for (const root of ownedRoots) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  ownedRoots.clear();
  if (failures.length) throw new AggregateError(failures, 'test teardown failed');
});

async function ownedDir() {
  const root = await mkdtemp(join(tmpdir(), 'pmc-queue-state-io-'));
  ownedRoots.add(root);
  return root;
}

function codeError(code, message = `${code}: injected test failure`) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Deterministic scheduling ticks — no timers, no wall-clock dependence.
async function tick(times = 1) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitFor(condition, message, { iterations = 20_000 } = {}) {
  for (let i = 0; i < iterations; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

/**
 * Swap the file-op layer; every retry/atomicity assertion in this file
 * observes injected counters instead of real transient locks.
 */
function installFileOps(overrides) {
  restoreFileOps = setQueueStateFileOps(overrides);
  return restoreFileOps;
}

// -------------------------------------------------------------------
// Serialized read-merge-write: overlapping transactions on one scope
// can never interleave the load -> merge -> save sequence.
// -------------------------------------------------------------------

test('withEnrichmentWrite serializes overlapping read-merge-write transactions on one scope so no record is lost', async () => {
  const dir = await ownedDir();
  const file = join(dir, 'worklist.json');
  await writeJsonFile(file, []);

  // Injected slow IO: every read and write yields a turn, so without a
  // coordinator both transactions would load the empty array and the
  // second write would erase the first record.
  installFileOps({
    readFile: async (...args) => { await tick(); return (await import('node:fs/promises')).readFile(...args); },
    writeFile: async (...args) => { await tick(); return (await import('node:fs/promises')).writeFile(...args); },
  });

  const transaction = (entry) => withEnrichmentWrite(dir, async () => {
    const rows = await readJsonFile(file);
    rows.push(entry);
    await writeJsonFile(file, rows);
  });

  await Promise.all([
    transaction({ symbolKey: 'k1', status: 'enriched' }),
    transaction({ symbolKey: 'k2', status: 'enriched' }),
    transaction({ symbolKey: 'k3', status: 'error' }),
  ]);

  const final = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(final.map((row) => row.symbolKey), ['k1', 'k2', 'k3'],
    'every concurrent full record must survive — a lost update means an unlocked overlap');
});

test('two concurrent transactions on DIFFERENT scopes do not serialize against each other', async () => {
  const dirA = await ownedDir();
  const dirB = await ownedDir();
  let releaseA;
  const heldA = new Promise((resolve) => { releaseA = resolve; });
  let aStarted = false;
  let bFinishedWhileAHeld = false;

  const a = withEnrichmentWrite(dirA, async () => {
    aStarted = true;
    await heldA;
  });
  const b = withEnrichmentWrite(dirB, async () => {
    await waitFor(() => aStarted, 'scope A must start while scope B is free');
    bFinishedWhileAHeld = true;
  });

  await waitFor(() => bFinishedWhileAHeld, 'scope B must complete while scope A is still held');
  assert.equal(bFinishedWhileAHeld, true,
    'the coordinator is per canonical directory — a global mutex would deadlock this test');
  releaseA();
  await Promise.all([a, b]);
});

// -------------------------------------------------------------------
// Reentrancy and canonical scope keys: a scoped transaction that calls a
// locked leaf helper on the same directory must not deadlock, even when
// the two paths are spelled differently.
// -------------------------------------------------------------------

test('withEnrichmentWrite is reentrant on the same canonical scope (nested acquisition cannot deadlock)', async () => {
  const dir = await ownedDir();
  let nestedRan = false;
  let settled = false;

  // Cancellable deadlock guard: a lost race must never fail the test run
  // later — it stops as soon as the real transaction settles.
  const guard = (async () => {
    for (let i = 0; i < 200_000 && !settled; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    return settled ? 'settled' : 'deadlock';
  })();

  const guarded = await Promise.race([
    withEnrichmentWrite(dir, async () => {
      await withEnrichmentWrite(join(dir, 'sub', '..'), async () => {
        nestedRan = true;
      });
    }),
    guard,
  ]);
  settled = true;
  await guard;

  assert.notEqual(guarded, 'deadlock', 'a nested acquisition of the held scope must run inline, not queue forever');
  assert.equal(nestedRan, true);
});

test('the scope registry reports the held coordinator and drains to zero after idle', async () => {
  const dir = await ownedDir();
  let observedDuringHold = null;

  await withEnrichmentWrite(dir, async () => {
    observedDuringHold = enrichmentWriteScopeCount();
  });

  assert.equal(observedDuringHold, 1, 'one canonical directory holds exactly one coordinator while a transaction runs');
  assert.equal(enrichmentWriteScopeCount(), 0, 'the registry must not leak scope keys after idle');
});

// -------------------------------------------------------------------
// Bounded file-lock retry: EBUSY/EPERM only, file operations only,
// exponential and finite, with observable bounded backoff.
// -------------------------------------------------------------------

test('EBUSY then EPERM then success retries exactly three file attempts with bounded exponential backoff', async () => {
  const dir = await ownedDir();
  const file = join(dir, 'worklist.json');
  const realWriteFile = (await import('node:fs/promises')).writeFile;
  const delays = [];
  let attempts = 0;

  installFileOps({
    writeFile: async (path, data, encoding) => {
      attempts += 1;
      if (attempts === 1) throw codeError('EBUSY');
      if (attempts === 2) throw codeError('EPERM');
      return realWriteFile(path, data, encoding);
    },
    sleep: async (ms) => { delays.push(ms); },
  });

  await writeJsonFile(file, [{ symbolKey: 'k1', status: 'enriched' }]);

  assert.equal(attempts, 3, 'two transient lock failures and one success — no skipped attempt');
  assert.deepEqual(delays, [15, 30], 'backoff is exponential and bounded (15ms, 30ms — never an open-ended wait)');
  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(written, [{ symbolKey: 'k1', status: 'enriched' }]);
  assert.equal((await readdir(dir)).length, 1, 'the successful atomic rename leaves no temp file behind');
});

test('a non-lock EIO failure fails immediately: one attempt, no backoff, previous target bytes untouched', async () => {
  const dir = await ownedDir();
  const file = join(dir, 'worklist.json');
  await writeJsonFile(file, [{ symbolKey: 'k1', status: 'pending' }]);
  const before = await readFile(file, 'utf8');

  const delays = [];
  let attempts = 0;
  installFileOps({
    writeFile: async () => {
      attempts += 1;
      throw codeError('EIO', 'disk error');
    },
    sleep: async (ms) => { delays.push(ms); },
  });

  await assert.rejects(writeJsonFile(file, [{ symbolKey: 'k1', status: 'enriched' }]), (error) => {
    assert.equal(error.code, 'EIO');
    return true;
  });

  assert.equal(attempts, 1, 'EIO is not a lock error — it must never be retried');
  assert.deepEqual(delays, []);
  assert.equal(await readFile(file, 'utf8'), before, 'a failed write must never publish partial or swapped JSON');
  assert.deepEqual((await readdir(dir)), ['worklist.json'], 'only this module\u2019s own temp file may be cleaned up');
});

test('EACCES fails immediately (no documented lock contract), never retried', async () => {
  const dir = await ownedDir();
  const file = join(dir, 'worklist.json');
  const delays = [];
  let attempts = 0;
  installFileOps({
    writeFile: async () => {
      attempts += 1;
      throw codeError('EACCES');
    },
    sleep: async (ms) => { delays.push(ms); },
  });

  await assert.rejects(writeJsonFile(file, []), (error) => error.code === 'EACCES');
  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
});

test('exhausted lock retries reject with the lock error and leave the target untouched (no false success)', async () => {
  const dir = await ownedDir();
  const file = join(dir, 'worklist.json');
  await writeJsonFile(file, [{ symbolKey: 'k1', status: 'pending' }]);
  const before = await readFile(file, 'utf8');

  const delays = [];
  let attempts = 0;
  installFileOps({
    writeFile: async () => {
      attempts += 1;
      throw codeError('EBUSY');
    },
    sleep: async (ms) => { delays.push(ms); },
  });

  await assert.rejects(writeJsonFile(file, [{ symbolKey: 'k1', status: 'enriched' }]), (error) => error.code === 'EBUSY');

  assert.equal(attempts, 4, 'the retry chain is finite: four attempts, never an infinite busy wait');
  assert.deepEqual(delays, [15, 30, 60], 'each backoff step stays small and bounded');
  assert.equal(await readFile(file, 'utf8'), before,
    'an exhausted lock must never publish an accepted bundle or claim a finished write');
  assert.deepEqual(await readdir(dir), ['worklist.json'], 'the own runtime temp file is cleaned up on failure');
});

test('readJsonFile retries a locked read once and then parses; a non-lock read error fails immediately', async () => {
  const dir = await ownedDir();
  const file = join(dir, 'worklist.json');
  await writeJsonFile(file, [{ symbolKey: 'k1' }]);

  const realReadFile = (await import('node:fs/promises')).readFile;
  const delays = [];
  let attempts = 0;
  installFileOps({
    readFile: async (...args) => {
      attempts += 1;
      if (attempts === 1) throw codeError('EBUSY');
      return realReadFile(...args);
    },
    sleep: async (ms) => { delays.push(ms); },
  });

  const rows = await readJsonFile(file);
  assert.deepEqual(rows, [{ symbolKey: 'k1' }]);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [15]);
  restoreFileOps();
  restoreFileOps = null;

  let secondAttempts = 0;
  installFileOps({
    readFile: async () => {
      secondAttempts += 1;
      throw codeError('EIO');
    },
    sleep: async () => { assert.fail('a non-lock read error must not back off'); },
  });
  await assert.rejects(readJsonFile(file), (error) => error.code === 'EIO');
  assert.equal(secondAttempts, 1);
});

// -------------------------------------------------------------------
// Public helpers: retry codes and the generic file-op retry wrapper that
// queue call sites put around other modules' appends.
// -------------------------------------------------------------------

test('QUEUE_LOCK_RETRY_CODES covers exactly the transient lock codes EBUSY and EPERM', () => {
  assert.deepEqual([...QUEUE_LOCK_RETRY_CODES].sort(), ['EBUSY', 'EPERM']);
});

test('withFileLockRetry retries only lock codes around one file operation and rethrows the original error', async () => {
  const delays = [];
  let attempts = 0;
  installFileOps({ sleep: async (ms) => { delays.push(ms); } });

  const result = await withFileLockRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw codeError('EBUSY');
    return 'written';
  });
  assert.equal(result, 'written');
  assert.equal(attempts, 3);

  let failedAttempts = 0;
  const boom = codeError('EIO', 'validation failed');
  await assert.rejects(withFileLockRetry(async () => {
    failedAttempts += 1;
    throw boom;
  }), (error) => {
    assert.equal(error, boom, 'the original error is preserved, never remapped to a success shape');
    return true;
  });
  assert.equal(failedAttempts, 1);
  assert.deepEqual(delays, [15, 30]);
});

test('writeJsonFile serializes bytes exactly like the historical saveJson format', async () => {
  const dir = await ownedDir();
  const file = join(dir, 'queue-state.json');
  const payload = { status: 'running', pid: 7, summary: { pending: 1 } };
  await writeJsonFile(file, payload);
  const raw = await readFile(file, 'utf8');
  assert.equal(raw, `${JSON.stringify(payload, null, 2)}\n`);
  assert.deepEqual(await readJsonFile(file), payload);
});

test('withEnrichmentWrite validates its callback argument before touching any file state', async () => {
  const dir = await ownedDir();
  await assert.rejects(withEnrichmentWrite(dir, null), TypeError);
  await assert.rejects(withEnrichmentWrite(dir, 'not a function'), TypeError);
  assert.equal(enrichmentWriteScopeCount(), 0);
});
