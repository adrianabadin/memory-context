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

      return;
    }

    await client.callTool({ name: 'store', arguments: payload }).then(parseToolResult);
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

export async function syncPendingEntries(client, pending, { markSynced = async () => {}, onProgress = () => {}, onError = () => {} } = {}) {
  let synced = 0;
  let errors = 0;

  for (const entry of pending) {
    try {
      await applySyncEntry(client, entry);
      await markSynced([entry.id]);
      synced += 1;
      onProgress({ synced, total: pending.length, entry });
    } catch (error) {
      errors += 1;
      onError({ error, entry, synced, total: pending.length });
    }
  }

  return { synced, errors };
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

  if (isDetach) {
    const outLog = resolve(enrichmentDir, 'sync-stdout.log');
    const errLog = resolve(enrichmentDir, 'sync-stderr.log');
    
    let outHandle, errHandle;
    try {
      outHandle = await openLogFile(outLog);
      errHandle = await openLogFile(errLog);
      
      const childArgs = [fileURLToPath(import.meta.url), '--background'];
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

    const acquired = await lock.acquire(process.pid);
    if (!acquired) {
      log(`[sync] Skip: another background sync is already running.`);
      return 0;
    }

    let heartbeatInterval;
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

    try {
      await writeSyncStateImpl(stateFile, syncState);

      const manifest = await readSyncManifestImpl(enrichmentDir);
      const pending = getPendingEntries(manifest);
      syncState.summary.pending = pending.length;

      await writeSyncStateImpl(stateFile, syncState);

      heartbeatInterval = setInterval(async () => {
        try {
          await lock.heartbeat();
          syncState.heartbeatAt = new Date().toISOString();
          await writeSyncStateImpl(stateFile, syncState);
        } catch (e) {
          // ignore
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

      const client = new ClientImpl({ name: 'pmc-sync', version: '1.0.0' });
      await client.connect(transport);

      const { synced, errors } = await syncPendingEntries(client, pending, {
        markSynced: (ids) => markEntriesSyncedImpl(enrichmentDir, ids),
        onProgress: async ({ synced: applied, total }) => {
          syncState.heartbeatAt = new Date().toISOString();
          syncState.summary.synced = applied;
          syncState.summary.pending = total - applied;
          await lock.heartbeat();
          await writeSyncStateImpl(stateFile, syncState);
        },
        onError: ({ error, entry }) => {
          errLogFn(`[sync] Entry ${entry.id} failed: ${error.message}`);
        },
      });

      clearInterval(heartbeatInterval);
      await client.close();

      syncState.status = 'finished';
      syncState.finishedAt = new Date().toISOString();
      syncState.summary.synced = synced;
      syncState.summary.errors = errors;
      syncState.summary.pending = 0;
      await writeSyncStateImpl(stateFile, syncState);
      await lock.release();
      return errors > 0 ? 1 : 0;
    } catch (err) {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      syncState.status = 'failed';
      syncState.finishedAt = new Date().toISOString();
      syncState.lastError = err.message;
      await writeSyncStateImpl(stateFile, syncState);
      await lock.release();
      errLogFn(`[sync] Background sync failed: ${err.message}`);
      return 1;
    }
  }

  // Foreground sync (no flags)
  const manifest = await readSyncManifestImpl(enrichmentDir);
  const pending = getPendingEntries(manifest);

  if (pending.length === 0) {
    log('[sync] Nothing to sync.');
    return 0;
  }

  const mcpConfig = await loadAgentMemoryConfigImpl();
  log(`[sync] ${pending.length} pending entries — starting agent-memory server...`);

  const transport = new StdioClientTransportImpl({
    command: mcpConfig.command,
    args: mcpConfig.args ?? [],
    env: { ...process.env, ...(mcpConfig.env ?? {}) },
  });

  const client = new ClientImpl({ name: 'pmc-sync', version: '1.0.0' });

  try {
    await client.connect(transport);
  } catch (err) {
    throw new Error(`Failed to connect to agent-memory: ${err.message}`);
  }

  const { synced, errors } = await syncPendingEntries(client, pending, {
    markSynced: (ids) => markEntriesSyncedImpl(enrichmentDir, ids),
    onProgress: ({ synced: applied, total }) => {
      process.stdout.write(`\r[sync] ${applied}/${total} synced...`);
    },
    onError: ({ error, entry }) => {
      errLogFn(`\n[sync] Entry ${entry.id} failed: ${error.message}`);
    },
  });

  await client.close();
  log(`\n[sync] Done. synced=${synced} errors=${errors}`);
  return errors > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => {
    if (code !== 0) process.exit(code);
  }).catch(err => {
    console.error('[sync] FATAL:', err.message);
    process.exit(1);
  });
}
