#!/usr/bin/env node
import { resolve, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { hashSymbol } from '../src/hash.mjs';

import { ensureProjectMemoryContextDirs, readJsonArtifact, writeJsonArtifact } from '../src/artifacts.mjs';
import { extractTopLevelSymbols } from '../src/symbol-extractor.mjs';
import { attachGraphNodeIds } from '../src/graph-node-resolver.mjs';
import { appendSyncEntries, createSyncEntry, clearManifest } from '../src/sync-manifest.mjs';
import { spawnBackground } from '../src/platform.mjs';
import { runGraphifyUpdate } from '../src/graphify-runner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_MAIN = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(process.argv[2] || process.cwd());

function log(msg) { console.error(`[sanitize] ${msg}`); }

function safeKey(key) {
  return key.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

function codeHash(content) {
  return hashSymbol(content);
}

async function findSourceFiles(projectRoot) {
  const exts = new Set(['.ts', '.mjs', '.js', '.cs']);
  const ignore = ['node_modules', 'dist', '.git', 'bin', 'obj', '.opencode', '.planning', 'graphify-out'];
  const results = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (ignore.some(i => full.includes(i))) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (Array.from(exts).some(e => entry.name.endsWith(e))) {
        results.push(relative(projectRoot, full).replace(/\\/g, '/'));
      }
    }
  }

  await walk(projectRoot);
  return results;
}

async function extractCurrentSymbols(projectRoot, files) {
  const allSymbols = [];
  for (const file of files) {
    try {
      const content = await readFile(resolve(projectRoot, file), 'utf8');
      const symbols = await extractTopLevelSymbols({ filePath: file, content });
      for (const sym of symbols) {
        sym.codeHash = await codeHash(
          content.split('\n').slice(sym.range.startLine - 1, sym.range.endLine).join('\n')
        );
      }
      allSymbols.push(...symbols);
    } catch { /* skip unreadable files */ }
  }
  return allSymbols;
}

async function sanitize(options = {}) {
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  log(`Target: ${projectRoot}`);
  const projectSlug = basename(projectRoot).toLowerCase();
  const dirs = await ensureProjectMemoryContextDirs(projectRoot);

  // runGraphifyUpdate is the shared async runner from src/graphify-runner.mjs.
  // It honors a default timeout (so a stuck graphify cannot block sanitize
  // indefinitely) and never throws — it warns and continues on every failure.
  const graphifyOptions = { log };
  if (options.graphifyTimeoutMs != null) graphifyOptions.timeoutMs = options.graphifyTimeoutMs;
  if (options.spawnImpl) graphifyOptions.spawnImpl = options.spawnImpl;
  if (options.resolveGraphifyFn) graphifyOptions.resolveGraphifyFn = options.resolveGraphifyFn;
  const graphifyResult = await runGraphifyUpdate(projectRoot, graphifyOptions);
  if (graphifyResult.timedOut) {
    log('Graphify update timed out — continuing with existing graph.');
  } else if (!graphifyResult.ran) {
    log('Graphify update skipped (binary missing or exited non-zero) — continuing with existing graph.');
  } else if (graphifyResult.copied.length > 0) {
    log(`Graphify update copied: ${graphifyResult.copied.join(', ')}`);
  }

  const graph = await readJsonArtifact(resolve(dirs.graph, 'graph.json'), { nodes: [], edges: [] });

  log('Scanning source files...');
  const files = await findSourceFiles(projectRoot);
  log(`Found ${files.length} source files.`);

  log('Extracting symbols...');
  const currentSymbols = await extractCurrentSymbols(projectRoot, files);
  const resolvedSymbols = attachGraphNodeIds({ symbols: currentSymbols, graph });
  log(`Extracted ${resolvedSymbols.length} symbols.`);

  const currentMap = new Map();
  for (const sym of resolvedSymbols) {
    currentMap.set(sym.symbolKey, sym);
  }

  const existingWorklist = await readJsonArtifact(resolve(dirs.enrichment, 'worklist.json'), []);
  const existingMap = new Map();
  for (const entry of existingWorklist) {
    existingMap.set(entry.symbolKey, entry);
  }

  const newEntries = [];
  const staleEntries = [];
  const removedEntries = [];
  const unchangedEntries = [];
  const syncOps = [];

  for (const [key, sym] of currentMap) {
    const existing = existingMap.get(key);
    if (!existing) {
      newEntries.push({
        ...sym,
        status: 'pending',
        memoryId: null,
      });
    } else if (existing.codeHash !== sym.codeHash) {
      staleEntries.push({
        ...sym,
        status: 'stale',
        staleReason: 'code-hash-changed',
        staleAt: new Date().toISOString(),
        memoryId: existing.memoryId || null,
      });
      syncOps.push(createSyncEntry({
        action: 'delete',
        keyTag: `key:symbol:${safeKey(key)}`,
        tags: ['symbol', sym.language, sym.kind, `project:${projectSlug}`, `file:${sym.filePath}`],
        source: 'sanitize',
        symbolKey: key,
      }));
    } else {
      unchangedEntries.push({
        ...existing,
        verifiedAt: new Date().toISOString(),
        status: existing.status === 'stale' ? 'stale' : existing.status,
      });
    }
  }

  for (const [key, existing] of existingMap) {
    if (!currentMap.has(key)) {
      removedEntries.push(existing);
      syncOps.push(createSyncEntry({
        action: 'delete',
        keyTag: `key:symbol:${safeKey(key)}`,
        tags: ['symbol', existing.language, existing.kind, `project:${projectSlug}`, `file:${existing.filePath}`],
        source: 'sanitize',
        symbolKey: key,
      }));
    }
  }

  const newWorklist = [
    ...newEntries,
    ...staleEntries,
    ...unchangedEntries,
  ];

  await writeJsonArtifact(resolve(dirs.enrichment, 'worklist.json'), newWorklist);

  if (syncOps.length > 0) {
    await appendSyncEntries(dirs.enrichment, syncOps);
  }

  const pendingCount = newWorklist.filter(e => e.status === 'pending' || e.status === 'stale').length;
  const enrichedCount = newWorklist.filter(e => e.status === 'enriched' || e.status === 'already_enriched').length;

  log('');
  log('=== Sanitize Report ===');
  log(`Total symbols: ${newWorklist.length}`);
  log(`New: ${newEntries.length}`);
  log(`Stale (code changed): ${staleEntries.length}`);
  log(`Removed: ${removedEntries.length}`);
  log(`Unchanged/verified: ${unchangedEntries.length}`);
  log(`Pending enrichment: ${pendingCount}`);
  log(`Already enriched: ${enrichedCount}`);
  log(`Sync-manifest operations: ${syncOps.length} (deletes for stale/removed)`);
  log('');

  if (pendingCount > 0 && !options.skipBackgroundEnrich) {
    const enrichCli = resolve(__dirname, 'enrich.mjs');
    const launchedPid = spawnBackground(process.execPath, [enrichCli, projectRoot], { cwd: projectRoot });
    log(`Background enrichment launched via spawnBackground (pid=${launchedPid})`);
    log(`  ${process.execPath} ${enrichCli} ${projectRoot}`);
  } else if (pendingCount > 0 && options.skipBackgroundEnrich) {
    log(`Skipping background enrichment (skipBackgroundEnrich=true, ${pendingCount} pending).`);
  }

  const result = {
    total: newWorklist.length,
    new: newEntries.length,
    stale: staleEntries.length,
    removed: removedEntries.length,
    unchanged: unchangedEntries.length,
    pendingEnrichment: pendingCount,
    enriched: enrichedCount,
    syncOps: syncOps.length,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (IS_MAIN) {
  sanitize().catch(err => {
    console.error('[sanitize] FATAL:', err.message);
    process.exit(1);
  });
}

export { sanitize };
