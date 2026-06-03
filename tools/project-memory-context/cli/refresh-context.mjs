import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
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

const __dirname = dirname(fileURLToPath(import.meta.url));

function log(msg) { console.error(`[refresh-context] ${msg}`); }

function safeKey(key) {
  return key.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

async function hashCodeFragment(content, startLine, endLine) {
  return hashSymbol(content.split('\n').slice(startLine - 1, endLine).join('\n'));
}

export async function refreshContext(projectRoot, options = {}) {
  const { enrich = false } = options;
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
  await runGraphifyUpdate(projectRoot, { log });

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

  let existingGraph = await readJsonArtifact(resolve(dirs.graph, 'graph.json'), { nodes: [], edges: [] });

  log('Extracting symbols from changed files...');
  const changedFileSymbols = [];
  for (const file of changedFiles) {
    try {
      const content = await readFile(resolve(projectRoot, file), 'utf8');
      const symbols = await extractTopLevelSymbols({ filePath: file, content });
      for (const sym of symbols) {
        sym.codeHash = await hashCodeFragment(content, sym.range.startLine, sym.range.endLine);
      }
      changedFileSymbols.push(...symbols);
    } catch { /* skip unreadable */ }
  }

  const resolvedChangedSymbols = attachGraphNodeIds({ symbols: changedFileSymbols, graph: existingGraph });

  const existingWorklist = await readJsonArtifact(resolve(dirs.enrichment, 'worklist.json'), []);

  const changedFileSet = new Set(changedFiles);
  const removedFileSet = new Set(fileDelta.removed);
  const unchangedWorklistEntries = existingWorklist.filter(
    entry => !changedFileSet.has(entry.filePath) && !removedFileSet.has(entry.filePath)
  );

  const allCurrentSymbols = [...resolvedChangedSymbols, ...unchangedWorklistEntries];
  const symbolDelta = computeSymbolDelta(allCurrentSymbols, existingWorklist);

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

  if (enrich && result.pendingEnrichment > 0) {
    const enrichQueueScript = resolve(dirname(fileURLToPath(import.meta.url)), 'enrich-queue.mjs');
    spawnBackground(process.execPath, [enrichQueueScript], { cwd: projectRoot });
    log(`Launched background enrichment (${result.pendingEnrichment} pending).`);
    result.enrichLaunched = true;
  } else if (result.pendingEnrichment > 0) {
    log(`Tip: run \`pmc refresh-context --enrich\` or \`pmc enrich .\` to enrich ${result.pendingEnrichment} pending symbol(s).`);
  }

  console.log(JSON.stringify(result, null, 2));
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
