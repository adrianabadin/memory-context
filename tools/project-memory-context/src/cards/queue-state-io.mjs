// F3 N6B (accepted plan 3.6 / spec S12): the in-process serialized writer
// and bounded file-lock retry shared by the enrichment queue and
// `pmc subagent-apply`.
//
// Contract:
//   - ONE coordinator per canonical enrichment directory. Every critical
//     read -> merge -> write transaction (worklist, symbol index, the
//     multi-file acceptance in persistEnrichmentSuccess, queue state, queue
//     appends) wraps itself in `withEnrichmentWrite(dir, fn)`, so concurrent
//     provider completions in the same process can never interleave the
//     loadJson -> merge -> writeFile sequence and lose or revert accepted
//     fields. Scope keys are `resolve()`d path strings, so callers that spell
//     the same directory differently share one coordinator. Scope identity
//     is the CANONICAL file-system path: plain `resolve()` off-platform, and
//     on win32 additionally realpath (existing paths) plus case folding, so
//     case/junction aliases of one physical directory share one scope.
//   - The coordinator is REENTRANT: a transaction that already holds a scope
//     runs nested acquisitions inline (locked leaf helpers can be called from
//     inside a scoped multi-file transaction without deadlocking and without
//     releasing the outer hold). This is what keeps ONE mutex covering the
//     whole transaction instead of several independent mutexes each covering
//     half of it.
//   - The registry drains when the last holder/waiter of a scope finishes, so
//     repeated runs never leak scope keys.
//   - `withFileLockRetry` wraps ONE file operation with a bounded exponential
//     retry for the transient Windows lock codes EBUSY/EPERM ONLY (EACCES is
//     not part of any documented lock contract in this repository, so it fails
//     immediately like EIO, EINVAL or a validation error). Retries never wrap
//     provider/tokenizer/inference work: an exhausted retry rejects with the
//     original lock error so callers surface error/partial state instead of a
//     false DONE/accepted success. The backoff is small and finite (15/30/60ms)
//     — there is no open-ended busy wait.
//   - `writeJsonFile` is atomic (own temp file + rename): a failed write can
//     never publish truncated JSON over an existing target, and cleanup
//     removes ONLY this module's own `<path>.<pid>.tmp` runtime file.
//
// Scope note: the coordinator serializes concurrent jobs inside ONE process.
// It deliberately adds no persistent lock file and promises no interprocess
// locking; an external OS-level holder of the file is handled by the bounded
// retry above. Model generation never runs under the coordinator — only file
// operations do — so serialization costs no throughput.

import { AsyncLocalStorage } from 'node:async_hooks';
import { realpathSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** The only codes treated as transient file locks worth retrying. */
export const QUEUE_LOCK_RETRY_CODES = new Set(['EBUSY', 'EPERM']);

// B1: one PHYSICAL enrichment directory on Windows can be spelled many ways
// (case aliases, junctions, 8.3 short names), and two spellings must share
// ONE scope or overlapping read-merge-write transactions lose records. Scope
// identity therefore follows the FILE SYSTEM: resolve first, then (win32
// only) fold through realpath for existing paths and fold case — Windows is
// case-insensitive. Case is NEVER folded on other platforms, where two
// case-different spellings are two genuinely different directories. The
// realpath is synchronous (no unawaited async effect) and a failure — the
// path does not exist yet — falls back to the resolved spelling, so the key
// is stable and never empty. This is scope identity only, not a security
// boundary: no permission or containment semantics are added.
const WIN32 = process.platform === 'win32';

function canonicalScopeKey(scopePath) {
  const resolved = resolve(String(scopePath));
  if (!WIN32) return resolved;
  let canonical = resolved;
  try {
    canonical = realpathSync(resolved);
  } catch {
    canonical = resolved;
  }
  return canonical.toLowerCase();
}

const MAX_LOCK_ATTEMPTS = 4;
const LOCK_BACKOFF_MS = [15, 30, 60];

/**
 * Swappable file-operation layer (test seam). Production behavior uses
 * node:fs/promises and a real timer; tests inject counters, deferred IO and a
 * no-op sleep so every retry/bound assertion stays deterministic instead of
 * depending on wall-clock timing. `setQueueStateFileOps` returns its own
 * restore function.
 */
const defaultFileOps = {
  readFile,
  writeFile,
  mkdir,
  rename,
  unlink,
  appendFile,
  sleep: (ms) => new Promise((scheduled) => { setTimeout(scheduled, ms); }),
};

let fileOps = { ...defaultFileOps };

export function setQueueStateFileOps(overrides = {}) {
  const previous = fileOps;
  fileOps = { ...previous, ...overrides };
  return () => { fileOps = previous; };
}

async function runFileOp(operation) {
  let lastLockError = null;
  for (let attempt = 1; attempt <= MAX_LOCK_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!QUEUE_LOCK_RETRY_CODES.has(error?.code) || attempt === MAX_LOCK_ATTEMPTS) {
        throw error;
      }
      lastLockError = error;
      await fileOps.sleep(LOCK_BACKOFF_MS[attempt - 1]);
    }
  }
  throw lastLockError; // unreachable, keeps the bounded chain explicit
}

/**
 * Bounded retry around ONE file operation (read/write/append/rename/mkdir),
 * never around provider or tokenizer work. Non-lock errors — EIO, EACCES,
 * ENOENT, JSON validation — fail on the first attempt with their original
 * error object.
 */
export function withFileLockRetry(operation) {
  if (typeof operation !== 'function') {
    return Promise.reject(new TypeError('withFileLockRetry requires a function'));
  }
  return runFileOp(operation);
}

// -------------------------------------------------------------------
// Per-scope in-process serialization (reentrant).
// -------------------------------------------------------------------

const writeContext = new AsyncLocalStorage();
const scopes = new Map();

/** Observable for leak controls: how many canonical scopes currently exist. */
export function enrichmentWriteScopeCount() {
  return scopes.size;
}

/**
 * Run `fn` while holding the canonical scope for `scopePath` (normally the
 * enrichment directory, or the dirname of the file being transacted on).
 * Concurrent callers on the same canonical scope run strictly one after
 * another; a caller that already holds the scope runs inline (reentrancy).
 *
 * @param {string} scopePath directory or file path identifying the resource
 * @param {Function} fn the transaction; its return value or error propagates
 */
export async function withEnrichmentWrite(scopePath, fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('withEnrichmentWrite requires a function');
  }
  const key = canonicalScopeKey(scopePath);
  const held = writeContext.getStore();
  if (held !== undefined && held.has(key)) {
    return fn();
  }

  let scope = scopes.get(key);
  if (scope === undefined) {
    scope = { tail: Promise.resolve(), holders: 0 };
    scopes.set(key, scope);
  }
  scope.holders += 1;
  const previousTail = scope.tail;
  let release;
  scope.tail = new Promise((resolveTurn) => { release = resolveTurn; });

  try {
    await previousTail; // the previous holder's tail never rejects
  } catch {
    // Defensive: a broken tail must not strand the queue; the transaction
    // below still runs under this scope's serialization.
  }

  try {
    const nextHeld = held === undefined ? new Set([key]) : new Set(held).add(key);
    return await writeContext.run(nextHeld, fn);
  } finally {
    release();
    scope.holders -= 1;
    if (scope.holders === 0 && scopes.get(key) === scope) {
      scopes.delete(key); // idle drain: no unbounded key growth across runs
    }
  }
}

// -------------------------------------------------------------------
// JSON primitives: retrying read, atomic temp+rename write.
// -------------------------------------------------------------------

/**
 * Read + parse one JSON file through the bounded lock retry. ENOENT and JSON
 * syntax errors propagate untouched for callers to handle exactly as before.
 */
export async function readJsonFile(path) {
  const raw = await runFileOp(() => fileOps.readFile(path, 'utf8'));
  return JSON.parse(raw);
}

/**
 * Atomically write one JSON file: serialize with the exact historical
 * `JSON.stringify(data, null, 2) + '\n'` bytes into this module's own temp
 * file, then rename over the target — every step through the bounded lock
 * retry. On failure the previous target bytes stay intact and only the own
 * temp file is removed.
 */
export async function writeJsonFile(path, data) {
  const tempPath = `${path}.${process.pid}.tmp`;
  try {
    await runFileOp(() => fileOps.mkdir(dirname(path), { recursive: true }));
    await runFileOp(() => fileOps.writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8'));
    await runFileOp(() => fileOps.rename(tempPath, path));
  } catch (error) {
    try {
      await runFileOp(() => fileOps.unlink(tempPath));
    } catch {
      // Own temp file may not exist (failure before writeFile); nothing else
      // is ever removed here.
    }
    throw error;
  }
}
