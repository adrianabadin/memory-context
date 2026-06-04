#!/usr/bin/env node
/**
 * pmc subagent-apply
 *
 * Persists the enrichment result produced by a Claude Code Task subagent into
 * the same pipeline used by the Ollama queue:
 *   - Writes <symbolKey>.memory.json
 *   - Updates worklist.json entry → 'enriched'
 *   - Updates symbol-index.json
 *   - Appends upsert entry to sync-manifest.json
 *   - Marks the subagent-queue.json entry as 'done'
 *
 * Usage:
 *   pmc subagent-apply [project-root] --entry-id <id> --content-file <path>
 *
 * Arguments:
 *   project-root        Path to the project root (default: cwd)
 *   --entry-id          The subagent-queue entry id to claim and mark done
 *   --content-file      Path to a file containing the enrichment text
 *
 * The /enrich skill calls this after each Task subagent completes, passing the
 * subagent's output as a temp file and the queue entry id.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSubagentQueue, markSubagentDone, markSubagentError } from '../src/subagent-queue.mjs';
import { persistEnrichmentSuccess } from './enrich-queue.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function loadOptionalJson(path, fallback = null) {
  try {
    return await loadJson(path);
  } catch {
    return fallback;
  }
}

async function saveJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function parseArgs(args) {
  const result = { projectRoot: null, entryId: null, contentFile: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--entry-id' && args[i + 1]) {
      result.entryId = args[++i];
    } else if (args[i] === '--content-file' && args[i + 1]) {
      result.contentFile = resolve(args[++i]);
    } else if (!args[i].startsWith('--')) {
      result.projectRoot = resolve(args[i]);
    }
  }
  return result;
}

function printUsage() {
  console.log(`
subagent-apply — persist a Task subagent enrichment result into the PMC pipeline

Usage:
  pmc subagent-apply [project-root] --entry-id <id> --content-file <path>

Arguments:
  project-root        Path to the project root (default: current dir)
  --entry-id          subagent-queue entry id to mark as done
  --content-file      File containing the enrichment text from the subagent

The /enrich skill calls this after each Task subagent returns its result.
`);
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return 0;
  }

  const { projectRoot: argRoot, entryId, contentFile } = parseArgs(args);
  const projectRoot = argRoot ?? process.cwd();
  const projectSlug = process.env.PMC_PROJECT_SLUG || basename(projectRoot);

  if (!entryId) {
    console.error('[subagent-apply] ERROR: --entry-id is required');
    printUsage();
    return 1;
  }

  if (!contentFile) {
    console.error('[subagent-apply] ERROR: --content-file is required');
    printUsage();
    return 1;
  }

  const enrichmentDir = resolve(projectRoot, '.planning/project-memory-context/enrichment');
  const worklistFile = resolve(enrichmentDir, 'worklist.json');
  const symbolIndexFile = resolve(enrichmentDir, 'symbol-index.json');

  // Load subagent queue and find the entry
  const queue = await loadSubagentQueue(enrichmentDir);
  const entry = queue.entries.find((e) => e.id === entryId);

  if (!entry) {
    console.error(`[subagent-apply] ERROR: entry not found in subagent-queue.json: ${entryId}`);
    return 1;
  }

  if (entry.status === 'done') {
    console.error(`[subagent-apply] WARN: entry ${entryId} already done — skipping`);
    console.log(JSON.stringify({ skipped: true, reason: 'already-done', entryId }));
    return 0;
  }

  // Read enrichment content
  let content;
  try {
    content = await readFile(contentFile, 'utf8');
    content = content.trim();
  } catch (err) {
    console.error(`[subagent-apply] ERROR: cannot read content file: ${err.message}`);
    await markSubagentError(enrichmentDir, entryId, `content-file read error: ${err.message}`);
    return 1;
  }

  if (!content) {
    console.error('[subagent-apply] ERROR: content file is empty');
    await markSubagentError(enrichmentDir, entryId, 'empty content');
    return 1;
  }

  // Load worklist and symbol index
  let worklist;
  try {
    worklist = await loadJson(worklistFile);
  } catch (err) {
    console.error(`[subagent-apply] ERROR: cannot load worklist.json: ${err.message}`);
    return 1;
  }

  const symbolIndex = await loadOptionalJson(symbolIndexFile) ?? {};

  // Batch entry: content is a JSON array [{id, content}, ...]
  if (Array.isArray(entry.batchItems) && entry.batchItems.length > 0) {
    let batchResults;
    try {
      batchResults = JSON.parse(content);
      if (!Array.isArray(batchResults)) throw new Error('expected JSON array');
    } catch (err) {
      console.error(`[subagent-apply] ERROR: batch content must be a JSON array: ${err.message}`);
      await markSubagentError(enrichmentDir, entryId, `batch parse error: ${err.message}`);
      return 1;
    }

    const appliedMemoryIds = [];
    for (const result of batchResults) {
      const batchItem = entry.batchItems.find((b) => b.id === result.id);
      if (!batchItem) {
        console.error(`[subagent-apply] WARN: batch result id ${result.id} not found in batchItems — skipping`);
        continue;
      }
      const wlEntry = worklist.find((e) => e.symbolKey === batchItem.symbolKey);
      if (!wlEntry) {
        console.error(`[subagent-apply] WARN: symbolKey ${batchItem.symbolKey} not found in worklist — skipping`);
        continue;
      }
      const symbol = {
        symbolKey: batchItem.symbolKey,
        name: batchItem.name,
        filePath: wlEntry.filePath,
        language: wlEntry.language,
        kind: wlEntry.kind,
        codeHash: wlEntry.codeHash ?? null,
        graphNodeId: wlEntry.graphNodeId ?? null,
      };
      try {
        const { memoryId } = await persistEnrichmentSuccess({
          symbol,
          content: result.content,
          enrichedByTag: 'enriched-by-subagent',
          enrichmentDir,
          worklist,
          worklistFile,
          symbolIndex,
          symbolIndexFile,
          projectSlug,
          attempts: [],
        });
        appliedMemoryIds.push({ id: result.id, symbolKey: batchItem.symbolKey, name: batchItem.name, memoryId });
      } catch (err) {
        console.error(`[subagent-apply] ERROR: persistEnrichmentSuccess failed for ${batchItem.name}: ${err.message}`);
      }
    }

    await markSubagentDone(enrichmentDir, entryId, { memoryIds: appliedMemoryIds });
    console.log(JSON.stringify({ ok: true, entryId, batch: true, applied: appliedMemoryIds }));
    return 0;
  }

  // Single-symbol entry (original path)
  const symbol = {
    symbolKey: entry.symbolKey,
    name: entry.name,
    filePath: entry.filePath,
    language: entry.language,
    kind: entry.kind,
    codeHash: worklist.find((e) => e.symbolKey === entry.symbolKey)?.codeHash ?? null,
    graphNodeId: worklist.find((e) => e.symbolKey === entry.symbolKey)?.graphNodeId ?? null,
  };

  // Persist the enrichment result via the shared helper
  let memoryId;
  try {
    ({ memoryId } = await persistEnrichmentSuccess({
      symbol,
      content,
      enrichedByTag: 'enriched-by-subagent',
      enrichmentDir,
      worklist,
      worklistFile,
      symbolIndex,
      symbolIndexFile,
      projectSlug,
      attempts: [],
    }));
  } catch (err) {
    console.error(`[subagent-apply] ERROR: persistEnrichmentSuccess failed: ${err.message}`);
    await markSubagentError(enrichmentDir, entryId, err.message);
    return 1;
  }

  // Mark the subagent queue entry as done
  await markSubagentDone(enrichmentDir, entryId, { memoryId });

  console.log(JSON.stringify({
    ok: true,
    entryId,
    symbolKey: entry.symbolKey,
    name: entry.name,
    memoryId,
  }));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main().catch((err) => {
    console.error('[subagent-apply] FATAL:', err.message);
    return 1;
  });
  if (exitCode !== 0) process.exit(exitCode);
}
