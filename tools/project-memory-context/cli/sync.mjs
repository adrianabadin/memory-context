#!/usr/bin/env node
import { readFile, open } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readSyncManifest, markEntriesSynced, getPendingEntries } from '../src/sync-manifest.mjs';
import { spawnBackground } from '../src/platform.mjs';
import { writeSyncState } from '../src/sync-state.mjs';
import { SyncLock } from '../src/sync-lock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.cwd();
const ENRICHMENT_DIR = resolve(PROJECT_ROOT, '.planning/project-memory-context/enrichment');
const LOOKUP_LIMIT = 100;

export const DEFAULT_CHECKPOINT_BATCH_SIZE = 25;
export const MAX_CHECKPOINT_BATCH_SIZE = 200;

export function resolveCheckpointBatchSize(value) {
  if (value === undefined || value === null) return DEFAULT_CHECKPOINT_BATCH_SIZE;
  const size = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(size) || size < 1 || size > MAX_CHECKPOINT_BATCH_SIZE) {
    throw new RangeError(
      `checkpointBatchSize must be an integer between 1 and ${MAX_CHECKPOINT_BATCH_SIZE} (got ${String(value)})`,
    );
  }
  return size;
}

async function loadAgentMemoryConfig() {
  const mcpPath = resolve(PROJECT_ROOT, '.mcp.json');
  let raw;
  try {
    raw = JSON.parse(await readFile(mcpPath, 'utf8'));
  } catch {
    throw new Error(`Could not read .mcp.json at ${mcpPath}`);
  }
  const server = raw?.mcpServers?.['agent-memory'];
  if (!server) throw new Error('No "agent-memory" server found in .mcp.json');
  return server;
}

function uniqueTags(tags = [], keyTag) {
  return [...new Set([...tags, keyTag].filter(Boolean))];
}

export function parseToolResult(result) {
  if (result?.isError) {
    const message = result.content?.[0]?.text ?? 'unknown error';
    throw new Error(message);
  }

  const text = result?.content?.[0]?.text;
  if (!text) {
    return null;
  }

  return JSON.parse(text);
}

export async function findMemoriesByKeyTag(client, keyTag) {
  const result = await client.callTool({
    name: 'search',
    arguments: {
      query: keyTag,
      tags: [keyTag],
      limit: LOOKUP_LIMIT,
    },
  });

  const data = parseToolResult(result) ?? { results: [] };
  return data.results.map((match) => match.memory);
}

export async function applySyncEntry(client, entry) {
  if (entry.action === 'upsert') {
    const symbolKey = entry.symbolKey;
    if (symbolKey !== undefined && symbolKey !== null && typeof symbolKey !== 'string') {
      throw new TypeError('symbolKey must be a string when provided');
    }

    const attachSymbol = async (memoryId) => {
      if (!symbolKey) return;
      if (!memoryId) throw new Error('Cannot attach symbol: stored memory id is missing');
      await client.callTool({
        name: 'attach_symbol',
        arguments: { memory_id: memoryId, symbol_key: symbolKey },
      }).then(parseToolResult);
    };
    const matches = (await findMemoriesByKeyTag(client, entry.key_tag))
      .slice()
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const payload = {
      content: entry.content,
      category: entry.category || 'architecture',
      tags: uniqueTags(entry.tags, entry.key_tag),
    };

    if (matches.length > 0) {
      const [primary, ...duplicates] = matches;
      await client.callTool({
        name: 'update',
        arguments: {
          id: primary.id,
          ...payload,
        },
      }).then(parseToolResult);

      for (const memory of duplicates) {
        await client.callTool({
          name: 'delete',
          arguments: { id: memory.id },
        }).then(parseToolResult);
      }

      await attachSymbol(primary.id);
      return;
    }

    const stored = await client.callTool({ name: 'store', arguments: payload }).then(parseToolResult);
    await attachSymbol(stored?.id ?? stored?.memory?.id);
    return;
  }

  if (entry.action === 'delete') {
    const matches = await findMemoriesByKeyTag(client, entry.key_tag);
    for (const memory of matches) {
      await client.callTool({
        name: 'delete',
        arguments: { id: memory.id },
      }).then(parseToolResult);
    }
    return;
  }

  throw new Error(`Unsupported sync action: ${entry.action}`);
}

export async function syncPendingEntries(client, pending, { markSynced = async () => {}, onProgress = () => {}, onError = () => {}, beforeEntry = async () => {}, checkpointBatchSize } = {}) {
  const batchSize = resolveCheckpointBatchSize(checkpointBatchSize);
  const total = pending.length;
  let synced = 0;
  let errors = 0;
  let halted = 0;
  let aborted = null;
  // Per-key ordering barrier: once an entry for a key fails, later entries
  // for the same key must not run on top of unknown predecessor state.
  const failedKeys = new Set();
  // Entries whose mutation succeeded but whose checkpoint is not durable yet.
  let buffer = [];

  // Observer notifications are best-effort by design: onProgress failures
  // are swallowed here (the background path logs its own state-write error)
  // so an already-committed entry is never re-attributed as an error —
  // durable progress lives in the manifest, not in progress reporting.
  const notifyProgress = async () => {
    try {
      await onProgress({ synced, total, pending: total - synced });
    } catch { /* progress reporting failure does not change durable counts */ }
  };

  // Commit a full batch: gate every member, then one durable checkpoint for
  // the whole batch. Any gate failure — syncAbort or not — aborts the whole
  // batch with zero commits: selectively committing around a failed gate
  // would let the next run re-apply the older uncommitted mutation after
  // the newer committed one, overwriting fresh content with stale content.
  const flush = async () => {
    if (buffer.length === 0 || aborted) return;
    const batch = buffer;
    buffer = [];
    for (const entry of batch) {
      try {
        await beforeEntry(entry, 'pre-checkpoint');
      } catch (error) {
        aborted = error?.syncAbort
          ? error.message
          : `checkpoint gate failed: ${error.message}`;
        return;
      }
    }
    try {
      await markSynced(batch.map((entry) => entry.id));
    } catch (error) {
      // A failed checkpoint is fatal, not a per-item error: applied but
      // uncommitted entries stay pending and are re-applied (idempotently)
      // by the next run instead of being counted as synced.
      aborted = `checkpoint failed: ${error.message}`;
      return;
    }
    synced += batch.length;
    await notifyProgress();
  };

  for (const entry of pending) {
    if (aborted) break;
    if (failedKeys.has(entry.key_tag)) {
      halted += 1;
      onError({
        error: new Error(`halted: an earlier entry for ${entry.key_tag} failed`),
        entry,
        synced,
        total,
        halted: true,
      });
      continue;
    }
    try {
      // Assertion hook: called before the mutation and again before the
      // checkpoint, so authority loss stops new MCP calls and prevents
      // counting unpersisted work as synced. A `syncAbort`-flagged error
      // halts the whole run; other errors stay per-entry failures.
      await beforeEntry(entry, 'pre-mutation');
      await applySyncEntry(client, entry);
    } catch (error) {
      if (error?.syncAbort) {
        aborted = error.message;
        break;
      }
      errors += 1;
      failedKeys.add(entry.key_tag);
      onError({ error, entry, synced, total });
      continue;
    }
    buffer.push(entry);
    if (buffer.length >= batchSize) await flush();
  }

  if (!aborted) await flush();
  return { synced, errors, halted, aborted };
}

export async function main(argv = process.argv, deps = {}) {
  const spawnBackgroundImpl = deps.spawnBackground ?? spawnBackground;
  const SyncLockImpl = deps.SyncLock ?? SyncLock;
  const writeSyncStateImpl = deps.writeSyncState ?? writeSyncState;
  const ClientImpl = deps.Client ?? Client;
  const StdioClientTransportImpl = deps.StdioClientTransport ?? StdioClientTransport;
  const readSyncManifestImpl = deps.readSyncManifest ?? readSyncManifest;
  const markEntriesSyncedImpl = deps.markEntriesSynced ?? markEntriesSynced;
  const loadAgentMemoryConfigImpl = deps.loadAgentMemoryConfig ?? loadAgentMemoryConfig;
  const openLogFile = deps.openLogFile ?? (async (path) => open(path, 'a'));
  const log = deps.log ?? console.log;
  const errLogFn = deps.errLog ?? console.error;
  const projectRoot = deps.PROJECT_ROOT ?? PROJECT_ROOT;
  const enrichmentDir = deps.ENRICHMENT_DIR ?? ENRICHMENT_DIR;

  const isDetach = argv.includes('--detach');
  const isBackground = argv.includes('--background');

  // Validate the checkpoint knob up front, before any lock or state file is
  // touched, so a bad value fails fast in every mode.
  let checkpointBatchSize;
  if (argv.includes('--checkpoint-batch-size')) {
    const flagIndex = argv.indexOf('--checkpoint-batch-size');
    try {
      checkpointBatchSize = resolveCheckpointBatchSize(argv[flagIndex + 1]);
    } catch (error) {
      errLogFn(`[sync] Invalid --checkpoint-batch-size: ${error.message}`);
      return 1;
    }
  }

  if (isDetach) {
    const outLog = resolve(enrichmentDir, 'sync-stdout.log');
    const errLog = resolve(enrichmentDir, 'sync-stderr.log');
    
    let outHandle, errHandle;
    try {
      outHandle = await openLogFile(outLog);
      errHandle = await openLogFile(errLog);
      
      const childArgs = [fileURLToPath(import.meta.url), '--background'];
      if (checkpointBatchSize !== undefined) {
        childArgs.push('--checkpoint-batch-size', String(checkpointBatchSize));
      }
      const pid = spawnBackgroundImpl(process.execPath, childArgs, {
        cwd: projectRoot,
        stdio: ['ignore', outHandle.fd, errHandle.fd],
      });
      
      log(`[sync] Background sync worker launched (pid=${pid}). Logging to sync-stdout.log / sync-stderr.log.`);
      return 0;
    } finally {
      if (outHandle) await outHandle.close();
      if (errHandle) await errHandle.close();
    }
  }

  if (isBackground) {
    const lockFile = resolve(enrichmentDir, 'sync.lock');
    const stateFile = resolve(enrichmentDir, 'sync-state.json');
    const lock = new SyncLockImpl(lockFile);

    let acquired;
    try {
      acquired = await lock.acquire(process.pid);
    } catch (lockErr) {
      // Fail closed with the library's actionable diagnostic (e.g. orphaned
      // transition guard); no state file is touched without the lock.
      errLogFn(`[sync] Cannot acquire sync lock: ${lockErr.message}`);
      return 1;
    }
    if (!acquired) {
      log(`[sync] Skip: another background sync is already running.`);
      return 0;
    }

    let heartbeatInterval;
    // Created lazily; hoisted so the finally cleanup can close it exactly
    // once on every terminal path (success, connect failure, run failure).
    let mcpClient = null;
    let ownershipLost = false;
    let heartbeatError = null;
    const startedAt = new Date().toISOString();
    const syncState = {
      status: 'running',
      pid: process.pid,
      startedAt,
      heartbeatAt: startedAt,
      summary: {
        synced: 0,
        errors: 0,
        pending: 0,
      },
    };

    const noteOwnershipLost = (message) => {
      if (!ownershipLost) {
        ownershipLost = true;
        syncState.lastError = message;
        errLogFn(`[sync] Warning: ${message}`);
      }
    };
    // Refresh authority. Failures are retained (heartbeatError) and checked by
    // the pipeline between entries; the timer itself never throws.
    const noteHeartbeat = async () => {
      try {
        const ok = await lock.heartbeat();
        if (!ok) noteOwnershipLost('sync lock ownership lost; aborting remaining sync work');
        return ok;
      } catch (err) {
        heartbeatError = heartbeatError ?? err;
        errLogFn(`[sync] heartbeat failed: ${err.message}`);
        return false;
      }
    };
    // Assertion hook for the pipeline: no new mutation or checkpoint may
    // start once ownership authority is in doubt. Cached heartbeat/timer
    // flags are checked first, then the on-disk record is verified with the
    // read-only isOwner() probe, so a takeover between timer ticks (even
    // mid-batch) is caught before the next MCP call. A failed probe read
    // leaves authority unknown and fails closed as syncAbort.
    const assertStillOwned = async () => {
      let reason = null;
      if (ownershipLost) reason = syncState.lastError ?? 'sync lock ownership lost';
      else if (heartbeatError) reason = `heartbeat failed: ${heartbeatError.message}`;
      if (!reason) {
        let owned = false;
        try {
          owned = await lock.isOwner();
        } catch (err) {
          const error = new Error(`sync lock ownership check failed: ${err.message}`);
          error.syncAbort = true;
          throw error;
        }
        if (!owned) reason = 'sync lock ownership lost (verified against lock record)';
      }
      if (reason) {
        const error = new Error(reason);
        error.syncAbort = true;
        throw error;
      }
    };

    try {
      await writeSyncStateImpl(stateFile, syncState);

      const manifest = await readSyncManifestImpl(enrichmentDir);
      const pending = getPendingEntries(manifest);
      syncState.summary.pending = pending.length;

      await writeSyncStateImpl(stateFile, syncState);

      heartbeatInterval = setInterval(async () => {
        try {
          const ok = await noteHeartbeat();
          if (ok) {
            syncState.heartbeatAt = new Date().toISOString();
            await writeSyncStateImpl(stateFile, syncState);
          }
        } catch (e) {
          errLogFn(`[sync] heartbeat state write failed: ${e.message}`);
        }
      }, 10000);
      if (typeof heartbeatInterval.unref === 'function') {
        heartbeatInterval.unref();
      }

      if (pending.length === 0) {
        clearInterval(heartbeatInterval);
        syncState.status = 'finished';
        syncState.finishedAt = new Date().toISOString();
        await writeSyncStateImpl(stateFile, syncState);
        await lock.release();
        return 0;
      }

      const mcpConfig = await loadAgentMemoryConfigImpl();
      const transport = new StdioClientTransportImpl({
        command: mcpConfig.command,
        args: mcpConfig.args ?? [],
        env: { ...process.env, ...(mcpConfig.env ?? {}) },
      });

      mcpClient = new ClientImpl({ name: 'pmc-sync', version: '1.0.0' });
      await mcpClient.connect(transport);

      const { synced, errors, halted, aborted } = await syncPendingEntries(mcpClient, pending, {
        checkpointBatchSize,
        markSynced: (ids) => markEntriesSyncedImpl(enrichmentDir, ids),
        beforeEntry: assertStillOwned,
        onProgress: async ({ synced: applied, pending: pendingNow }) => {
          syncState.heartbeatAt = new Date().toISOString();
          syncState.summary.synced = applied;
          syncState.summary.pending = pendingNow;
          try {
            await noteHeartbeat();
            await writeSyncStateImpl(stateFile, syncState);
          } catch (e) {
            // Observers are best-effort: log the failure, never fail the run
            // or double-count entries that are already committed.
            errLogFn(`[sync] progress state write failed: ${e.message}`);
          }
        },
        onError: ({ error, entry }) => {
          errLogFn(`[sync] Entry ${entry.id} failed: ${error.message}`);
        },
      });

      clearInterval(heartbeatInterval);

      syncState.finishedAt = new Date().toISOString();
      syncState.summary.synced = synced;
      syncState.summary.errors = errors;
      // Truthful accounting: failed and halted entries stay pending in the
      // manifest, so pending is what was never committed.
      const pendingLeft = Math.max(0, pending.length - synced);

      if (aborted) {
        // Ownership/authority was lost mid-run: report a truthful failed
        // terminal state with the partial progress, never "finished".
        syncState.status = 'failed';
        syncState.summary.pending = pendingLeft;
        syncState.lastError = syncState.lastError ?? aborted;
        errLogFn(`[sync] Aborted: ${aborted}`);
        await writeSyncStateImpl(stateFile, syncState);
        await lock.release().catch((releaseErr) => {
          errLogFn(`[sync] lock release failed: ${releaseErr.message}`);
        });
        return 1;
      }

      if (halted > 0) {
        errLogFn(`[sync] ${halted} entries halted behind failed keys and remain pending`);
      }

      syncState.status = 'finished';
      syncState.summary.pending = pendingLeft;
      await writeSyncStateImpl(stateFile, syncState);
      await lock.release();
      return errors > 0 ? 1 : 0;
    } catch (err) {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      syncState.status = 'failed';
      syncState.finishedAt = new Date().toISOString();
      syncState.lastError = syncState.lastError ?? err.message;
      await writeSyncStateImpl(stateFile, syncState);
      await lock.release().catch((releaseErr) => {
        errLogFn(`[sync] lock release failed: ${releaseErr.message}`);
      });
      errLogFn(`[sync] Background sync failed: ${err.message}`);
      return 1;
    } finally {
      // Exactly-once MCP cleanup: the stdio child is spawned inside
      // connect, so every terminal path must close a created client —
      // including connect and mid-run failures, which previously skipped
      // the success-path-only close and leaked the child. Close failures
      // are logged and never mask the primary error or the terminal state.
      if (mcpClient) {
        try {
          await mcpClient.close();
        } catch (closeErr) {
          errLogFn(`[sync] MCP client close failed: ${closeErr.message}`);
        }
      }
    }
  }

  // Foreground sync (no flags). Shares the same exclusive lock as background
  // sync so the two can never run concurrently; fail fast when it is held.
  const lockFile = resolve(enrichmentDir, 'sync.lock');
  const fgLock = new SyncLockImpl(lockFile);
  const acquired = await fgLock.acquire(process.pid);
  if (!acquired) {
    log('[sync] Skip: another sync is already running (sync.lock is held). Retry after it finishes.');
    return 1;
  }

  // Created lazily; hoisted so the finally cleanup can close it exactly
  // once on every terminal path (success, connect failure, run failure).
  let fgClient = null;

  try {
    const manifest = await readSyncManifestImpl(enrichmentDir);
    const pending = getPendingEntries(manifest);

    if (pending.length === 0) {
      log('[sync] Nothing to sync.');
      return 0;
    }

    // Real ownership verification for foreground runs: the same read-only
    // probe the background pipeline uses, so a takeover between entries (or
    // between mutation and checkpoint) aborts new work instead of being
    // trusted blindly off the initial acquire.
    const assertFgOwned = async () => {
      let owned;
      try {
        owned = await fgLock.isOwner();
      } catch (err) {
        const error = new Error(`sync lock ownership check failed: ${err.message}`);
        error.syncAbort = true;
        throw error;
      }
      if (!owned) {
        const error = new Error('sync lock ownership lost');
        error.syncAbort = true;
        throw error;
      }
    };

    const mcpConfig = await loadAgentMemoryConfigImpl();
    log(`[sync] ${pending.length} pending entries — starting agent-memory server...`);

    const transport = new StdioClientTransportImpl({
      command: mcpConfig.command,
      args: mcpConfig.args ?? [],
      env: { ...process.env, ...(mcpConfig.env ?? {}) },
    });

    fgClient = new ClientImpl({ name: 'pmc-sync', version: '1.0.0' });

    try {
      await fgClient.connect(transport);
    } catch (err) {
      throw new Error(`Failed to connect to agent-memory: ${err.message}`);
    }

    const { synced, errors, halted, aborted } = await syncPendingEntries(fgClient, pending, {
      checkpointBatchSize,
      markSynced: (ids) => markEntriesSyncedImpl(enrichmentDir, ids),
      beforeEntry: assertFgOwned,
      onProgress: ({ synced: applied, total }) => {
        process.stdout.write(`\r[sync] ${applied}/${total} synced...`);
      },
      onError: ({ error, entry }) => {
        errLogFn(`\n[sync] Entry ${entry.id} failed: ${error.message}`);
      },
    });

    const haltedSuffix = halted > 0 ? ` halted=${halted}` : '';
    if (aborted) {
      // Fatal abort (checkpoint failure or lost authority): never exit 0.
      errLogFn(`[sync] Aborted: ${aborted}`);
      log(`\n[sync] Aborted. synced=${synced} errors=${errors}${haltedSuffix}`);
      return 1;
    }
    log(`\n[sync] Done. synced=${synced} errors=${errors}${haltedSuffix}`);
    return errors > 0 ? 1 : 0;
  } finally {
    // Exactly-once MCP cleanup before lock release: a created client is
    // closed on every path — success, connect failure, and mid-run
    // failure — so the stdio child never leaks. Close errors are logged
    // and never mask the primary failure.
    if (fgClient) {
      try {
        await fgClient.close();
      } catch (closeErr) {
        errLogFn(`[sync] MCP client close failed: ${closeErr.message}`);
      }
    }
    await fgLock.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => {
    if (code !== 0) process.exit(code);
  }).catch(err => {
    console.error('[sync] FATAL:', err.message);
    process.exit(1);
  });
}
