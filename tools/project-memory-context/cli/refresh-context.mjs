import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildErrorPayloads } from '../src/global-sync.mjs';
import { existsSync } from 'node:fs';
import { ensureProjectMemoryContextDirs, readJsonArtifact, writeJsonArtifact } from '../src/artifacts.mjs';
import { hashSymbol } from '../src/hash.mjs';
import { computeFileHashes, loadHashStore, saveHashStore, detectChangedFiles } from '../src/file-hash-store.mjs';
import { extractTopLevelSymbols } from '../src/symbol-extractor.mjs';
import { attachGraphNodeIds } from '../src/graph-node-resolver.mjs';
import { computeSymbolDelta } from '../src/symbol-delta.mjs';
import { appendSyncEntries, createSyncEntry } from '../src/sync-manifest.mjs';
import { runGraphifyUpdate } from '../src/graphify-runner.mjs';
import { spawnBackground } from '../src/platform.mjs';
import { openGraphDb } from '../src/graph-store/graph-db.mjs';
import { executeNativePipeline } from '../src/native-pipeline.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function log(msg) { console.error(`[refresh-context] ${msg}`); }

/**
 * Default timeout (ms) for the global MCP sync round-trip. A refresh must
 * not hang on the agent-memory handshake — a slow or stuck sync is logged
 * and refresh returns normally.
 */
export const DEFAULT_SYNC_TIMEOUT_MS = 15_000;

/**
 * Race a promise against a timeout. Rejects with a descriptive error on
 * timeout so the caller can log it and continue. Never throws on its own
 * — the underlying promise's errors are propagated normally.
 */
function withTimeout(promise, ms, label) {
  let handle;
  const timeout = new Promise((_, reject) => {
    handle = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(handle));
}

function computeProjectId(rootPath) {
  const normalised = rootPath.replace(/\\/g, '/').toLowerCase();
  return createHash('sha256').update(normalised).digest('hex');
}

async function trySyncProjectToGlobal(projectRoot, dirs, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;

  const mcpPath = resolve(projectRoot, '.mcp.json');
  let serverConfig;
  try {
    const raw = JSON.parse(await readFile(mcpPath, 'utf8'));
    serverConfig = raw?.mcpServers?.['agent-memory'];
  } catch {
    return;
  }
  if (!serverConfig) return;

  const projectId = computeProjectId(projectRoot);
  const projectName = basename(projectRoot);

  // Gather metadata from existing project-context artifacts
  const architecturePath = resolve(dirs.projectContextMarkdown, 'ARCHITECTURE-CURRENT.md');
  const [architectureText, minimapText] = await Promise.all([
    readFile(architecturePath, 'utf8').catch(() => null),
    readFile(resolve(dirs.projectContextMarkdown, 'MODULE-MINIMAP.md'), 'utf8').catch(() => null),
  ]);

  const errorPayloads = await buildErrorPayloads(
    resolve(projectRoot, '.planning', 'project-memory-context'),
    projectId,
  );

  const realClient = new Client({ name: 'pmc-refresh', version: '1.0.0' });
  const realTransport = new StdioClientTransport({
    command: serverConfig.command,
    args: serverConfig.args ?? [],
    env: { ...process.env, ...serverConfig.env },
  });
  // Allow tests to inject a fake client/transport so they can simulate
  // a stalled MCP handshake without spawning real processes.
  const client = options.client ?? realClient;
  const transport = options.transport ?? realTransport;

  try {
    await withTimeout(client.connect(transport), timeoutMs, 'mcp connect');

    // Ensure project is registered (idempotent)
    await withTimeout(
      client.callTool({
        name: 'register_project',
        arguments: { name: projectName, rootPath: projectRoot },
      }),
      timeoutMs,
      'mcp register_project',
    );

    // Sync metadata
    const metadataArgs = { projectId };
    if (architectureText) metadataArgs.architecture = architectureText.slice(0, 2000);
    if (minimapText) metadataArgs.minimap = { summary: minimapText.slice(0, 1000) };
    await withTimeout(
      client.callTool({ name: 'sync_project_metadata', arguments: metadataArgs }),
      timeoutMs,
      'mcp sync_project_metadata',
    );

    // Auto-promote errors
    for (const payload of errorPayloads) {
      await withTimeout(
        client.callTool({ name: 'record_error', arguments: payload }),
        timeoutMs,
        'mcp record_error',
      );
    }

    log(`Global context synced (${errorPayloads.length} errors promoted)`);
  } catch (err) {
    log(`Global context sync skipped (non-fatal): ${err.message}`);
  } finally {
    try {
      await withTimeout(client.close(), timeoutMs, 'mcp close');
    } catch { /* ignore */ }
  }
}

function safeKey(key) {
  return key.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

async function hashCodeFragment(content, startLine, endLine) {
  return hashSymbol(content.split('\n').slice(startLine - 1, endLine).join('\n'));
}

export async function refreshContext(projectRoot, options = {}) {
  const {
    enrich = false,
    runGraphifyUpdate: runGraphifyUpdateImpl = runGraphifyUpdate,
  } = options;
  const log = options.log ?? ((msg) => console.error(`[refresh-context] ${msg}`));
  const projectSlug = basename(projectRoot).toLowerCase();
  const dirs = await ensureProjectMemoryContextDirs(projectRoot);

  log('Computing file hashes...');
  const currentHashes = await computeFileHashes(projectRoot);

  const hashStorePath = resolve(dirs.enrichment, 'hash-store.json');
  const previousHashes = await loadHashStore(hashStorePath);

  const fileDelta = detectChangedFiles(previousHashes, currentHashes);
  const changedFiles = [...fileDelta.added, ...fileDelta.modified];
  const totalChanges = changedFiles.length + fileDelta.removed.length;

  if (totalChanges === 0) {
    log('No changes detected.');
    return { total: 0, added: 0, modified: 0, removed: 0, newSymbols: 0, staleSymbols: 0, removedSymbols: 0 };
  }

  log(`Changes: ${fileDelta.added.length} added, ${fileDelta.modified.length} modified, ${fileDelta.removed.length} removed`);

  // Refresh the graph before resolving symbol node IDs so attachGraphNodeIds
  // can link new/changed symbols to up-to-date nodes (with startLine, edges, community).
  await runGraphifyUpdateImpl(projectRoot, { log });

  // Rebuild graph.db so get-context queries use the updated graph.
  const graphJsonPath = resolve(dirs.graph, 'graph.json');
  const graphDbPath   = resolve(dirs.graph, 'graph.db');
  if (existsSync(graphJsonPath)) {
    let store;
    try {
      store = openGraphDb(graphDbPath, graphJsonPath);
      log('graph.db refreshed ✓');
    } catch (err) {
      log(`graph.db rebuild failed (non-fatal): ${err.message}\n${err.stack ?? ''}`);
    } finally {
      try { store?.close(); } catch { /* ignore close errors */ }
    }
  }

  log('Extracting symbols and running native pipeline over current eligible sources...');
  const existingWorklist = await readJsonArtifact(resolve(dirs.enrichment, 'worklist.json'), []);
  const { resolvedSymbols } = await executeNativePipeline({
    projectRoot,
    dirs,
    replace: true,
    log,
  });

  const symbolDelta = computeSymbolDelta(resolvedSymbols, existingWorklist);

  const syncOps = [];

  for (const sym of symbolDelta.stale) {
    syncOps.push(createSyncEntry({
      action: 'delete',
      keyTag: `key:symbol:${safeKey(sym.symbolKey)}`,
      tags: ['symbol', sym.language, sym.kind, `project:${projectSlug}`, `file:${sym.filePath}`],
      source: 'refresh-context',
      symbolKey: sym.symbolKey,
    }));
  }

  for (const sym of symbolDelta.removed) {
    syncOps.push(createSyncEntry({
      action: 'delete',
      keyTag: `key:symbol:${safeKey(sym.symbolKey)}`,
      tags: ['symbol', sym.language, sym.kind, `project:${projectSlug}`, `file:${sym.filePath}`],
      source: 'refresh-context',
      symbolKey: sym.symbolKey,
    }));
  }

  const newWorklist = [
    ...symbolDelta.new,
    ...symbolDelta.stale,
    ...symbolDelta.unchanged,
  ];

  await writeJsonArtifact(resolve(dirs.enrichment, 'worklist.json'), newWorklist);

  if (syncOps.length > 0) {
    await appendSyncEntries(dirs.enrichment, syncOps);
  }

  await saveHashStore(hashStorePath, currentHashes);

  const pendingCount = newWorklist.filter(e => e.status === 'pending' || e.status === 'stale').length;

  const result = {
    total: totalChanges,
    added: fileDelta.added.length,
    modified: fileDelta.modified.length,
    removed: fileDelta.removed.length,
    newSymbols: symbolDelta.new.length,
    staleSymbols: symbolDelta.stale.length,
    removedSymbols: symbolDelta.removed.length,
    syncOps: syncOps.length,
    pendingEnrichment: pendingCount,
  };

  log('');
  log('=== Refresh Report ===');
  log(`File changes: ${result.added} added, ${result.modified} modified, ${result.removed} removed`);
  log(`Symbol deltas: ${result.newSymbols} new, ${result.staleSymbols} stale, ${result.removedSymbols} removed`);
  log(`Sync-manifest operations: ${result.syncOps}`);
  log(`Pending enrichment: ${result.pendingEnrichment}`);

  const isEnriching = enrich && result.pendingEnrichment > 0;
  const spawnBackgroundImpl = options.spawnBackground ?? spawnBackground;
  if (isEnriching) {
    const enrichQueueScript = resolve(dirname(fileURLToPath(import.meta.url)), 'enrich-queue.mjs');
    spawnBackgroundImpl(process.execPath, [enrichQueueScript], { cwd: projectRoot });
    log(`Launched background enrichment (${result.pendingEnrichment} pending).`);
    result.enrichLaunched = true;
  } else {
    if (result.pendingEnrichment > 0) {
      log(`Tip: run \`pmc refresh-context --enrich\` or \`pmc enrich .\` to enrich ${result.pendingEnrichment} pending symbol(s).`);
    }
    try {
      const syncScript = resolve(dirname(fileURLToPath(import.meta.url)), 'sync.mjs');
      const openImpl = options.open ?? open;

      const outLog = resolve(dirs.enrichment, 'sync-stdout.log');
      const errLog = resolve(dirs.enrichment, 'sync-stderr.log');

      let outHandle, errHandle;
      try {
        outHandle = await openImpl(outLog, 'a');
        errHandle = await openImpl(errLog, 'a');
        spawnBackgroundImpl(process.execPath, [syncScript, '--background'], {
          cwd: projectRoot,
          stdio: ['ignore', outHandle.fd, errHandle.fd],
        });
        log('Launched background sync.');
      } finally {
        if (outHandle) await outHandle.close();
        if (errHandle) await errHandle.close();
      }
    } catch (err) {
      log(`Failed to auto-spawn background sync (non-fatal): ${err.message}`);
    }
  }

  console.log(JSON.stringify(result, null, 2));

  // Sync to global context store (non-blocking, errors are swallowed).
  // trySyncProjectToGlobal has its own timeout — even if the agent-memory
  // handshake stalls, refresh returns within DEFAULT_SYNC_TIMEOUT_MS.
  const syncOptions = {};
  if (options.syncTimeoutMs != null) syncOptions.timeoutMs = options.syncTimeoutMs;
  if (options.syncClient) syncOptions.client = options.syncClient;
  if (options.syncTransport) syncOptions.transport = options.syncTransport;
  await trySyncProjectToGlobal(projectRoot, dirs, syncOptions).catch(() => {});

  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const projectRoot = resolve(args.find(a => !a.startsWith('--')) ?? process.cwd());
  const enrich = args.includes('--enrich');
  await refreshContext(projectRoot, { enrich });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('[refresh-context] FATAL:', err.message);
    process.exit(1);
  });
}

export { trySyncProjectToGlobal };
