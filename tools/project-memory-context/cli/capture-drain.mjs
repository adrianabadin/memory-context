#!/usr/bin/env node
// capture-drain.mjs — Detached drainer for the PMC session-capture queue.
//
// Consumes the JSONL queue produced by src/session-capture.mjs and persists
// rows to the agent-memory session ledger via createLedgerOnlyStore, without
// loading the embedding model and without going through the MCP server.
//
// Design (pmc-session-capture-plugin §4):
//   - Acquire an exclusive lock at <root>/.opencode/pmc-capture-drain.lock.
//   - Read the live queue + rotated archives (oldest first), batch up to 100.
//   - Dispatch each entry to the matching LedgerStore session method.
//   - Retry transient failures 3x with exponential backoff (100ms, 200ms, 400ms).
//   - Exit cleanly when the queue is empty and idle for 30s.
//   - Release the lock on every exit path.
//
// Lock semantics:
//   - `acquireLock` uses `writeFileSync(..., { flag: 'wx' })` for an atomic
//     create. On EEXIST it reads the holder PID and probes liveness with
//     `kill(pid, 0)`. A dead/stale holder allows the lock to be stolen; a live
//     holder makes the drainer exit silently (`exitReason: 'locked'`).
//   - `releaseLock` is best-effort and idempotent (a missing lock on exit is
//     not fatal). It is called from a `finally` block so every exit path
//     (success, error, idle, locked-after-steal) releases the lock.
//
// Batch semantics:
//   - Up to `DEFAULT_BATCH_SIZE` (100) entries are read per cycle, oldest
//     first across rotated archives + the live file. After a batch is
//     processed, the remaining entries are atomically rewritten into the live
//     queue (tmp-write → rename, with a Windows unlink-then-rename fallback)
//     and rotated archives are deleted. An empty result file is unlinked so
//     "queue empty" is observable on disk.
//
// Retry semantics:
//   - `withRetry` attempts the operation once, then retries up to
//     `DEFAULT_RETRIES` (3) times with `DEFAULT_BACKOFF` ([100, 200, 400] ms).
//     If every attempt fails the last error is rethrown. `runDrain` does NOT
//     rewrite the queue on that path, so the failed entry stays in the queue
//     for the next drain run (no data loss).
//
// Windows EBUSY mitigation (two layers):
//   1. Driver layer — `createLedgerOnlyStore` opens SQLite in WAL mode and
//      sets `PRAGMA busy_timeout = 5000`, so transient `SQLITE_BUSY`/EBUSY
//      from concurrent access by the main agent process retries inside SQLite
//      for up to 5s before surfacing.
//   2. Application layer — `withRetry` wraps each entry write in 3 retries
//      with exponential backoff (100ms, 200ms, 400ms). A persistent failure
//      after both layers preserves the entry in the queue for the next run.
//   The two layers compose: driver retry first, then application retry, then
//   queue preservation. No data loss on transient or persistent lock errors.

import {
  existsSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  readdirSync,
  renameSync,
  statSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join, basename } from 'node:path';

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF = [100, 200, 400];

// ── Lock management ──────────────────────────────────────────────────────

/**
 * Try to acquire an exclusive drainer lock.
 *
 * Uses `writeFileSync(..., { flag: 'wx' })` for an atomic create. If the lock
 * file already exists, reads the recorded PID and checks liveness via
 * `kill(pid, 0)`. A dead holder allows the lock to be stolen.
 *
 * @param {string} lockPath - Absolute path to the lock file.
 * @param {object} [options]
 * @param {number} [options.pid=process.pid] - PID to record in the lock.
 * @param {(pid:number, signal:number)=>boolean} [options.kill=process.kill] - Liveness probe.
 * @returns {boolean} true if the lock was acquired, false if held by a live process.
 */
export function acquireLock(lockPath, options = {}) {
  const pid = options.pid ?? process.pid;
  const kill = options.kill ?? process.kill;
  const dir = dirname(lockPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(lockPath, String(pid), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err && err.code !== 'EEXIST') throw err;
  }
  // Lock exists — see whether the holder is still alive.
  let holderPid;
  try {
    holderPid = Number(readFileSync(lockPath, 'utf8'));
  } catch {
    // Unreadable lock — treat as stale and steal it.
    writeFileSync(lockPath, String(pid), { flag: 'w' });
    return true;
  }
  try {
    if (Number.isFinite(holderPid) && kill(holderPid, 0)) {
      // Alive: refuse.
      return false;
    }
  } catch {
    // kill threw (ESRCH / no such process) → holder is dead.
  }
  // Steal the stale lock.
  writeFileSync(lockPath, String(pid), { flag: 'w' });
  return true;
}

/**
 * Release the drainer lock if present.
 *
 * @param {string} lockPath - Absolute path to the lock file.
 * @param {object} [options]
 * @param {(p:string)=>void} [options.unlinkSync=unlinkSync] - Injector for tests.
 */
export function releaseLock(lockPath, options = {}) {
  const unlink = options.unlinkSync ?? unlinkSync;
  try {
    if (existsSync(lockPath)) unlink(lockPath);
  } catch {
    // Best-effort: a missing lock on exit is not fatal.
  }
}

// ── Queue reading ────────────────────────────────────────────────────────

/**
 * Enumerate the live queue plus rotated archives, oldest archive first.
 *
 * File naming convention (see src/session-capture.mjs):
 *   - live:   pmc-capture-queue.jsonl
 *   - rotated: pmc-capture-queue.<timestamp>.jsonl
 *
 * @param {string} queuePath - Absolute path to the live queue file.
 * @returns {{ path: string, entries: object[] }[]} Ordered file list with parsed entries.
 */
export function readQueueFiles(queuePath) {
  const dir = dirname(queuePath);
  const base = basename(queuePath); // pmc-capture-queue.jsonl
  const stem = base.replace(/\.jsonl$/, ''); // pmc-capture-queue
  const rotRe = new RegExp(
    '^' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.(\\d+)\\.jsonl$',
  );

  let files = [];
  if (existsSync(dir)) {
    files = readdirSync(dir)
      .map((name) => {
        const m = rotRe.exec(name);
        if (m) return { name, ts: Number(m[1]), rotated: true };
        if (name === base) return { name, ts: Number.MAX_SAFE_INTEGER, rotated: false };
        return null;
      })
      .filter(Boolean)
      .sort((a, b) => a.ts - b.ts);
  }

  const out = [];
  for (const f of files) {
    const fullPath = join(dir, f.name);
    let raw = '';
    try {
      raw = readFileSync(fullPath, 'utf8');
    } catch {
      continue;
    }
    const entries = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((e) => e !== null);
    if (entries.length > 0) out.push({ path: fullPath, entries });
  }
  return out;
}

/**
 * Read up to `batchSize` queue entries (oldest first), without mutating files.
 *
 * @param {string} queuePath - Absolute path to the live queue file.
 * @param {number} [batchSize=100] - Maximum entries to return.
 * @returns {object[]} Parsed entries (length <= batchSize).
 */
export function readQueueBatch(queuePath, batchSize = DEFAULT_BATCH_SIZE) {
  const files = readQueueFiles(queuePath);
  const all = [];
  for (const f of files) {
    for (const e of f.entries) {
      all.push(e);
      if (all.length >= batchSize) return all;
    }
  }
  return all;
}

// ── Retry helper ─────────────────────────────────────────────────────────

/**
 * Run an async operation with bounded retries and exponential backoff.
 *
 * The operation is attempted once, then retried up to `retries` times. Between
 * attempts the drainer sleeps for `backoff[i]` milliseconds (i = 0-based retry
 * index). If every attempt fails, the last error is rethrown.
 *
 * Example: `withRetry(fn, { retries: 3, backoff: [100, 200, 400] })`
 *   attempt 1 → fail → sleep 100
 *   attempt 2 → fail → sleep 200
 *   attempt 3 → fail → sleep 400
 *   attempt 4 → fail → throw
 *
 * @param {() => Promise<T>} fn - Async operation to retry.
 * @param {object} options
 * @param {number} [options.retries=3] - Number of retries after the first attempt.
 * @param {number[]} [options.backoff=[100,200,400]] - Per-retry sleep delays in ms.
 * @param {(ms:number)=>Promise<void>} [options.sleep=defaultSleep] - Sleep injector.
 * @returns {Promise<T>}
 * @template T
 */
export async function withRetry(fn, options = {}) {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  const sleep = options.sleep ?? defaultSleep;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delay = backoff[attempt] ?? backoff[backoff.length - 1] ?? 0;
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Entry dispatch ───────────────────────────────────────────────────────

/**
 * Dispatch a single queue entry to the matching LedgerStore session method.
 *
 * Sets the session context first so the ledger associates the row with the
 * right session/project, then calls:
 *   - 'prompt'     → storeSessionPrompt(sessionId, content)
 *   - 'tool_call'  → storeSessionToolCall({ sessionId, toolName, argsSafe, ... })
 *   - 'response'   → storeSessionResponse(sessionId, promptId, fullResponse)
 *
 * Unknown types are ignored (forward-compat).
 *
 * @param {import('../../../agent-memory-mcp/src/compose.js').LedgerStore} store
 * @param {object} entry - Parsed queue entry.
 */
export async function processEntry(store, entry) {
  const sessionId = entry.sessionId;
  const projectId = entry.projectId;
  if (typeof store.setSessionContext === 'function') {
    store.setSessionContext(sessionId, projectId);
  }
  switch (entry.type) {
    case 'prompt':
      await store.storeSessionPrompt(sessionId, entry.content);
      break;
    case 'tool_call':
      await store.storeSessionToolCall({
        sessionId,
        promptId: entry.promptId,
        responseId: entry.responseId,
        toolName: entry.toolName,
        argsSafe: entry.argsSafe,
        resultSummary: entry.resultSummary,
        importance: entry.importance,
      });
      break;
    case 'response':
      await store.storeSessionResponse(sessionId, entry.promptId, entry.fullResponse);
      break;
    default:
      // Unknown entry type — skip without throwing (forward-compatible).
      break;
  }
}

// ── Core drainer loop (testable via dependency injection) ────────────────

/**
 * Run the drainer loop over a project root.
 *
 * All side-effectful collaborators are injectable so the loop is fully testable
 * without real SQLite or real waiting:
 *   - `storeFactory(dbPath)` → LedgerStore (default: real createLedgerOnlyStore)
 *   - `sleep(ms)`            → async sleep (default: setTimeout)
 *   - `now()`                → clock (default: Date.now)
 *   - `kill(pid, signal)`    → liveness probe (default: process.kill)
 *
 * @param {string} projectRoot - Absolute project root.
 * @param {object} [options]
 * @returns {Promise<{ processed: number, exitReason: 'idle'|'locked' }>}
 */
export async function runDrain(projectRoot, options = {}) {
  const lockPath = join(projectRoot, '.opencode', 'pmc-capture-drain.lock');
  const queuePath = join(projectRoot, '.opencode', 'pmc-capture-queue.jsonl');
  const dbPath = options.dbPath ?? join(
    projectRoot,
    '.planning',
    'project-memory-context',
    'memory',
  );

  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const kill = options.kill ?? process.kill;
  const pid = options.pid ?? process.pid;

  if (!acquireLock(lockPath, { pid, kill })) {
    return { processed: 0, exitReason: 'locked' };
  }

  const storeFactory = options.storeFactory ?? defaultStoreFactory;
  let store = null;
  let processed = 0;
  try {
    store = await storeFactory(dbPath);
    let lastNonEmptyMs = now();

    while (true) {
      const files = readQueueFiles(queuePath);
      const allEntries = files.flatMap((f) => f.entries);
      const batch = allEntries.slice(0, batchSize);

      if (batch.length === 0) {
        if (now() - lastNonEmptyMs >= idleTimeoutMs) {
          return { processed, exitReason: 'idle' };
        }
        await sleep(pollIntervalMs);
        continue;
      }

      for (const entry of batch) {
        await withRetry(() => processEntry(store, entry), { retries, backoff, sleep });
        processed++;
      }

      // Collapse remaining entries into the live queue and drop rotated files.
      const remaining = allEntries.slice(batch.length);
      rewriteQueue(queuePath, files, remaining);

      lastNonEmptyMs = now();
    }
  } finally {
    try {
      if (store && typeof store.close === 'function') store.close();
    } catch {
      // Best-effort close.
    }
    releaseLock(lockPath);
  }
}

/**
 * Atomically rewrite the live queue with the remaining (unprocessed) entries
 * and delete rotated archive files.
 *
 * Writes to a temp file in the same directory, then renames — atomic on most
 * filesystems (including Windows NTFS) so a crash mid-rewrite cannot corrupt
 * the queue.
 *
 * @param {string} queuePath - Live queue path.
 * @param {{ path: string }[]} files - Files read this cycle (rotated ones get deleted).
 * @param {object[]} remaining - Entries to keep in the live queue.
 */
function rewriteQueue(queuePath, files, remaining) {
  const dir = dirname(queuePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const tmpPath = queuePath + '.tmp';
  const content = remaining.map((e) => JSON.stringify(e)).join('\n') + (remaining.length ? '\n' : '');
  writeFileSync(tmpPath, content);

  // Delete rotated archives first so the rename lands cleanly.
  for (const f of files) {
    if (f.path === queuePath) continue;
    try {
      unlinkSync(f.path);
    } catch {
      // Best-effort.
    }
  }

  try {
    renameSync(tmpPath, queuePath);
  } catch {
    // Some Windows versions reject rename over an existing file; fall back to
    // truncate-then-rename of the tmp file content.
    try {
      if (existsSync(queuePath)) unlinkSync(queuePath);
      renameSync(tmpPath, queuePath);
    } catch {
      // Last resort: write directly. Not atomic, but preserves data.
      writeFileSync(queuePath, content);
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        /* noop */
      }
    }
  }

  // If nothing remains, remove the now-empty live queue so the idle/exit
  // semantics ("queue empty") are observable on disk.
  if (remaining.length === 0) {
    try {
      if (existsSync(queuePath) && statSync(queuePath).size === 0) unlinkSync(queuePath);
    } catch {
      /* noop */
    }
  }
}

// ── Default store factory (real createLedgerOnlyStore, lazy) ─────────────

let _defaultFactory;
async function defaultStoreFactory(dbPath) {
  if (!_defaultFactory) {
    // Relative path to the compiled agent-memory-mcp submodule. Resolved at
    // call time so the drainer CLI only pulls in SQLite when actually run (not
    // when tests inject their own mock storeFactory).
    const mod = await import('../../../agent-memory-mcp/dist/compose.js');
    _defaultFactory = mod.createLedgerOnlyStore;
  }
  if (!_defaultFactory) throw new Error('createLedgerOnlyStore not found in agent-memory-mcp');
  return _defaultFactory(dbPath);
}

// ── CLI entry point ──────────────────────────────────────────────────────

/**
 * CLI main: parse the project root argument and run the drainer.
 *
 * @param {string[]} [argv] - CLI args (default: process.argv.slice(2)).
 */
export async function main(argv = process.argv.slice(2)) {
  const projectRoot = argv[0] ?? process.cwd();
  const result = await runDrain(projectRoot);
  if (result.exitReason === 'locked') {
    // Another drainer holds the lock — exit silently.
    process.exit(0);
  }
  process.exit(0);
}

// Run only when invoked directly as a CLI.
const isMain = (() => {
  try {
    return process.argv[1] && (process.argv[1].endsWith('capture-drain.mjs'));
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((err) => {
    console.error('capture-drain failed:', err);
    process.exit(1);
  });
}
