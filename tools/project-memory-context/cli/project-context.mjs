#!/usr/bin/env node
import { basename, join, resolve, dirname } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { ensureProjectMemoryContextDirs, writeJsonArtifact, readJsonArtifact } from '../src/artifacts.mjs';
import { detectStackContext } from '../src/extractors/stack-extractor.mjs';
import { detectStructureContext } from '../src/extractors/structure-extractor.mjs';
import { detectArchitectureContext } from '../src/extractors/architecture-extractor.mjs';
import { detectRulesContext } from '../src/extractors/rules-extractor.mjs';
import { createDeclaredProjectContextTemplates } from '../src/declared-intake.mjs';
import { materializeProjectContextMemories } from '../src/materializer.mjs';
import { renderProjectContextMarkdown } from '../src/markdown-renderer.mjs';
import { detectChangedFilesFromHashes } from '../src/change-detector.mjs';
import { detectInvalidatedProjectContextKinds } from '../src/invalidation-matrix.mjs';
import { appendSyncEntries, createSyncEntry } from '../src/sync-manifest.mjs';
import { buildMinimapChunk } from '../src/minimap.mjs';

function log(message) {
  console.error(`[project-context] ${message}`);
}

async function readText(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

const TRACKED_FILES = ['package.json', 'tsconfig.json', 'README.md'];

async function buildDetectedContext(projectRoot) {
  const stack = await detectStackContext(projectRoot);
  const structure = await detectStructureContext(projectRoot);
  const architecture = await detectArchitectureContext({ graph: { nodes: structure.entryPoints.map((entry) => ({ label: entry })), edges: [] } });
  const rules = await detectRulesContext({ readmeText: await readText(join(projectRoot, 'README.md')) });
  return { stack, structure, architecture, rules };
}

function buildDeclaredContext() {
  return {
    architectureTarget: { architecture: '' },
    technicalRules: { rules: [] },
    projectRequirements: { requirements: [] },
    knownIssuesAndFixes: { items: [] },
  };
}

/**
 * Load graph + analysis artifacts and build the module-minimap chunk.
 * Returns null gracefully if graph.json doesn't exist yet.
 */
async function buildMinimap(projectRoot, dirs, projectSlug, updatedAt) {
  const graphPath = join(dirs.graph, 'graph.json');
  const analysisPath = join(projectRoot, '.graphify_analysis.json');
  const [graph, analysis] = await Promise.all([
    readJsonArtifact(graphPath, null),
    readJsonArtifact(analysisPath, null),
  ]);
  if (!graph) return null;
  return buildMinimapChunk({ graph, analysis: analysis ?? {}, projectSlug, updatedAt });
}

async function writeMemories(dirs, memories) {
  for (const memory of memories) {
    const jsonName = `${memory.kind}.json`;
    const markdownName = `${memory.kind.toUpperCase()}.md`;
    await writeJsonArtifact(join(dirs.projectContextMaterialized, jsonName), memory);
    const markdown = renderProjectContextMarkdown(memory);
    await mkdir(dirname(join(dirs.projectContextMarkdown, markdownName)), { recursive: true });
    await writeFile(join(dirs.projectContextMarkdown, markdownName), markdown, 'utf8');
  }
}

async function computeHashes(projectRoot, files) {
  const hashes = {};
  for (const file of files) {
    try {
      const content = await readFile(join(projectRoot, file), 'utf8');
      hashes[file] = createHash('sha256').update(content).digest('hex');
    } catch {}
  }
  return hashes;
}

async function runBootstrap(projectRoot, dirs) {
  const updatedAt = new Date().toISOString();
  const detected = await buildDetectedContext(projectRoot);
  const declared = buildDeclaredContext();

  const templates = createDeclaredProjectContextTemplates();
  for (const [fileName, payload] of Object.entries(templates)) {
    await writeJsonArtifact(join(dirs.projectContextDeclared, fileName), payload);
  }

  const projectSlug = basename(projectRoot).toLowerCase();
  const memories = materializeProjectContextMemories({
    projectSlug,
    detected,
    declared,
    updatedAt,
  });

  const minimapChunk = await buildMinimap(projectRoot, dirs, projectSlug, updatedAt);
  if (minimapChunk) memories.push(minimapChunk);

  await writeMemories(dirs, memories);

  const nextHashes = await computeHashes(projectRoot, TRACKED_FILES);
  await writeJsonArtifact(join(dirs.projectContextState, 'content-hashes.json'), { hashes: nextHashes });
  await writeJsonArtifact(join(dirs.projectContextState, 'last-run.json'), { updatedAt, count: memories.length });

  const syncEntries = memories.map((memory) => createSyncEntry({
    action: 'upsert',
    keyTag: `key:${memory.memory_key}`,
    content: `# ${memory.title}\n\n${memory.summary}\n\n${memory.body}`,
    category: 'architecture',
    tags: [...memory.tags, `key:${memory.memory_key}`],
    source: 'project-context',
  }));
  await appendSyncEntries(dirs.enrichment, syncEntries);

  log(`Wrote ${memories.length} project-context memories.`);
  log(`Appended ${syncEntries.length} sync-manifest entries.`);
}

async function runRefresh(projectRoot, dirs) {
  const updatedAt = new Date().toISOString();
  const projectSlug = basename(projectRoot).toLowerCase();

  const nextHashes = await computeHashes(projectRoot, TRACKED_FILES);
  const previousState = await readJsonArtifact(join(dirs.projectContextState, 'content-hashes.json'), { hashes: {} });
  const changed = detectChangedFilesFromHashes(previousState.hashes, nextHashes);
  const invalidatedKinds = detectInvalidatedProjectContextKinds(changed);

  // Check if the module-minimap needs updating (graph may have changed independently
  // of TRACKED_FILES via `graphify update`, so we compare content hashes).
  const newMinimapChunk = await buildMinimap(projectRoot, dirs, projectSlug, updatedAt);
  const previousMinimap = await readJsonArtifact(
    join(dirs.projectContextMaterialized, 'module-minimap.json'),
    null,
  );
  const minimapChanged = newMinimapChunk != null
    && newMinimapChunk.content_hash !== previousMinimap?.content_hash;

  if (invalidatedKinds.length === 0 && !minimapChanged) {
    log('No changes detected. Nothing to refresh.');
    return;
  }

  const toRewrite = [];
  const invalidatedSet = new Set(invalidatedKinds);

  if (invalidatedKinds.length > 0) {
    log(`Changed files: ${changed.join(', ')}`);
    log(`Invalidated kinds: ${invalidatedKinds.join(', ')}`);

    const detected = await buildDetectedContext(projectRoot);
    const declared = buildDeclaredContext();

    const allMemories = materializeProjectContextMemories({ projectSlug, detected, declared, updatedAt });
    toRewrite.push(...allMemories.filter((m) => invalidatedSet.has(m.kind)));
  }

  if (minimapChanged) {
    log('Graph changed — refreshing module-minimap.');
    toRewrite.push(newMinimapChunk);
  }

  await writeMemories(dirs, toRewrite);

  const syncEntries = toRewrite.map((memory) => createSyncEntry({
    action: 'upsert',
    keyTag: `key:${memory.memory_key}`,
    content: `# ${memory.title}\n\n${memory.summary}\n\n${memory.body}`,
    category: 'architecture',
    tags: [...memory.tags, `key:${memory.memory_key}`],
    source: 'project-context-refresh',
  }));
  await appendSyncEntries(dirs.enrichment, syncEntries);

  const affectsArchitecture = invalidatedSet.has('architecture-current') || invalidatedSet.has('structure-summary');
  if (affectsArchitecture) {
    await markEnrichedSymbolsStale(dirs, projectSlug);
  }

  await writeJsonArtifact(join(dirs.projectContextState, 'content-hashes.json'), { hashes: nextHashes });
  await writeJsonArtifact(join(dirs.projectContextState, 'last-run.json'), { updatedAt, count: toRewrite.length });

  log(`Refreshed ${toRewrite.length} memories.`);
  log(`Appended ${syncEntries.length} sync-manifest entries.`);
  if (affectsArchitecture) {
    log('Marked enriched symbols as stale (architecture/structure changed).');
  }
}

async function markEnrichedSymbolsStale(dirs, projectSlug) {
  const worklistPath = join(dirs.enrichment, 'worklist.json');
  let worklist;
  try {
    worklist = JSON.parse(await readFile(worklistPath, 'utf8'));
  } catch {
    log('  No worklist found, skipping stale marking.');
    return;
  }

  const staleEntries = [];
  let staleCount = 0;
  for (const entry of worklist) {
    if (entry.status === 'enriched') {
      entry.status = 'stale';
      entry.staleReason = 'base-memory-changed';
      entry.staleAt = new Date().toISOString();
      staleCount++;
      staleEntries.push(createSyncEntry({
        action: 'delete',
        keyTag: `key:symbol:${entry.symbolKey.replace(/[^a-zA-Z0-9_-]+/g, '_')}`,
        category: 'architecture',
        tags: ['symbol', entry.language, entry.kind, `project:${projectSlug}`, `file:${entry.filePath}`, `key:symbol:${entry.symbolKey.replace(/[^a-zA-Z0-9_-]+/g, '_')}`],
        source: 'project-context-refresh',
        symbolKey: entry.symbolKey,
      }));
    }
  }

  if (staleCount > 0) {
    await writeFile(worklistPath, `${JSON.stringify(worklist, null, 2)}\n`, 'utf8');
    await appendSyncEntries(dirs.enrichment, staleEntries);
    log(`  Marked ${staleCount} enriched symbols as stale in worklist.`);
    log(`  Appended ${staleEntries.length} delete entries to sync-manifest.`);
  }
}

export async function runProjectContextCli(projectRoot, options = {}) {
  const refresh = !!options.refresh;
  log(`Target: ${projectRoot} (refresh=${refresh})`);

  const dirs = await ensureProjectMemoryContextDirs(projectRoot);

  if (refresh) {
    await runRefresh(projectRoot, dirs);
  } else {
    await runBootstrap(projectRoot, dirs);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const projectRoot = resolve(args.filter((a) => a !== '--refresh')[0] ?? process.cwd());
  await runProjectContextCli(projectRoot, { refresh });
}

main().catch((error) => {
  console.error('[project-context] FATAL:', error.message);
  process.exit(1);
});
