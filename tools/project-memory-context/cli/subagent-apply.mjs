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
import { persistEnrichmentSuccess, saveWorklistMerged } from './enrich-queue.mjs';
import { NARRATIVE_SCHEMA, validateNarrative } from '../src/cards/narrative-schema.mjs';
import { PROMPT_VERSION, normalizeSymbolKeys } from '../src/cards/prompt-v2.mjs';
import { queuedEvidenceCheck } from '../src/cards/narrative-cache.mjs';

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
Entries queued with narrative metadata (promptVersion/schema/knownGraphKeys)
must contain a JSON narrative that validates against the shared NARRATIVE_SCHEMA
before anything is persisted; invalid output marks the entry as error.
`);
}

/**
 * Validate an opt-in narrative queue entry against the transported metadata.
 * Returns null when the content is acceptable, otherwise the exact error that
 * must mark the entry as error instead of enriched.
 */
function narrativeProblem(entry, content) {
  if (entry.promptVersion !== PROMPT_VERSION) {
    return `unsupported narrative prompt version: ${entry.promptVersion ?? '(missing)'}`;
  }
  if (JSON.stringify(entry.schema ?? null) !== JSON.stringify(NARRATIVE_SCHEMA)) {
    return 'queued narrative schema does not match NARRATIVE_SCHEMA';
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (parseError) {
    return `narrative validation failed: Narrative must be a JSON object (invalid JSON: ${parseError.message})`;
  }

  let symbolKeys;
  try {
    // Explicit null or malformed stored collections reject; only an absent
    // collection normalizes to an empty (fail-closed) set.
    symbolKeys = normalizeSymbolKeys(entry.knownGraphKeys === undefined ? [] : entry.knownGraphKeys);
  } catch (keysError) {
    return `narrative validation failed: ${keysError.message}`;
  }

  const validation = validateNarrative(parsed, { symbolKeys });
  if (!validation.valid) {
    return `narrative validation failed: ${validation.errors.join('; ')}`;
  }
  return null;
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

  // Narrative entries (prompt v2) must validate against the transported schema
  // and known graph keys before anything is persisted. Legacy entries skip
  // this gate entirely and keep the exact original behavior.
  let persistedContent = content;
  let semanticSummaryOverride;
  if (entry.schema != null || entry.promptVersion != null) {
    const problem = narrativeProblem(entry, content);
    if (problem) {
      console.error(`[subagent-apply] ERROR: ${problem}`);
      await markSubagentError(enrichmentDir, entryId, problem);
      return 1;
    }
    const parsed = JSON.parse(persistedContent);
    const canonical = Object.fromEntries(NARRATIVE_SCHEMA.required.map((field) => [field, parsed[field]]));
    persistedContent = `${JSON.stringify(canonical, null, 2)}`;
    semanticSummaryOverride = canonical.summary;
  }

  // N5B (plan 3.5 / S11): entries carrying the complete opt-in fingerprint
  // evidence are re-derived against the ACTUAL current source bytes before
  // any accepted write. A source change (or an unavailable source, or
  // tampered/inconsistent evidence) rejects the apply: the queue entry is
  // marked `error`, the worklist entry is marked `stale` with reason
  // `queued-fingerprint-mismatch` for the next pass, and no memory file,
  // index record or sync-manifest entry is written.
  //
  // B3 correction: presence is decided by OWN PROPERTY, exactly like
  // appendSubagentQueue's "supplied" test — an explicit `null` (or any
  // malformed value) that a hand-edit planted is a REJECTED narrative
  // entry, never a silent downgrade into the legacy path; only an absent
  // field (legacy trio-only entries) keeps the original apply contract.
  let queuedEvidence = null;
  if (Object.hasOwn(entry, 'narrativeEvidence') && entry.narrativeEvidence !== undefined) {
    const check = await queuedEvidenceCheck({ entry, projectRoot });
    if (!check.ok) {
      console.error(`[subagent-apply] ERROR: ${check.problem}`);
      try {
        const staleWorklist = await loadJson(worklistFile);
        const target = staleWorklist.find((element) => element.symbolKey === entry.symbolKey);
        if (target) {
          target.status = 'stale';
          target.staleReason = 'queued-fingerprint-mismatch';
          await saveWorklistMerged(worklistFile, staleWorklist);
        }
      } catch (worklistError) {
        console.error(`[subagent-apply] WARN: could not mark ${entry.symbolKey} stale: ${worklistError.message}`);
      }
      await markSubagentError(enrichmentDir, entryId, check.problem);
      return 1;
    }
    queuedEvidence = check.evidence;
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

  // B2 correction: the transported proof is only valid while the worklist
  // entry still awaits THIS queued generation. If upstream invalidation
  // (e.g. callee-summary propagation) marked the entry `stale` after it was
  // queued, the queued context is superseded — accepting it would silently
  // trust outdated dependency knowledge, so reject before any accepted
  // write and let the next pass regenerate with current context. Legacy
  // entries without evidence keep their exact original apply contract.
  if (queuedEvidence) {
    const superseded = worklist.find((element) => element.symbolKey === entry.symbolKey);
    if (superseded?.status === 'stale') {
      const problem = `queued narrative evidence is superseded: ${entry.symbolKey} was marked stale after queueing (${superseded.staleReason ?? 'unknown reason'})`;
      console.error(`[subagent-apply] ERROR: ${problem}`);
      await markSubagentError(enrichmentDir, entryId, problem);
      return 1;
    }
  }

  // Build a symbol-like object from the queue entry
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
      content: persistedContent,
      semanticSummary: semanticSummaryOverride,
      enrichedByTag: 'enriched-by-subagent',
      enrichmentDir,
      worklist,
      worklistFile,
      symbolIndex,
      symbolIndexFile,
      projectSlug,
      attempts: [],
      // Only a validated, source-fresh apply persists the aligned bundle.
      ...(queuedEvidence ? { narrativeEvidence: queuedEvidence } : {}),
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
