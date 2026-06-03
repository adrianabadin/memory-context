#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { appendProviderEvent, withRecordedAttempt } from '../src/enrichment-attempts.mjs';
import { PMC_ENRICHMENT_CONFIG_FILE, resolveEnrichmentConfig } from '../src/enrichment-config.mjs';
import { runEnrichmentWithFallback } from '../src/enrichment-driver.mjs';
import { countPromptTokens, estimateTokens } from '../src/providers/ollama-token-counter.mjs';
import { createCloudApiProvider } from '../src/providers/cloud-api-provider.mjs';
import { createLocalModelProvider } from '../src/providers/local-model-provider.mjs';
import { appendSubagentQueue } from '../src/subagent-queue.mjs';
import { appendSyncEntry, createSyncEntry } from '../src/sync-manifest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.cwd();

export function parseQueueConcurrency(rawValue) {
  const parsed = parseInt(rawValue || '8', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Select which worklist symbols to enrich in this run.
 *
 * @param {Array} worklist   Full worklist array.
 * @param {boolean} staleOnly  When true, only symbols with status 'stale' are selected
 *                             (symbols never enriched — status 'pending' — are skipped).
 *                             When false (default), both 'pending' and 'stale' are selected.
 * @returns {Array} Filtered array of symbols to enrich.
 */
export function selectWorkItems(worklist, staleOnly = false) {
  if (staleOnly) {
    return worklist.filter(s => s.status === 'stale');
  }
  return worklist.filter(s => s.status === 'pending' || s.status === 'stale');
}

const PMC_CONCURRENCY = parseQueueConcurrency(process.env.PMC_CONCURRENCY);
const PROJECT_SLUG = process.env.PMC_PROJECT_SLUG || basename(PROJECT_ROOT);
const TIMEOUT_MS = parseInt(process.env.PMC_TIMEOUT_MS || '300000', 10);
const REPORT_INTERVAL_MS = parseInt(process.env.PMC_REPORT_INTERVAL || '30000', 10);
// Timeout for the token-count probe request (num_predict:1 round-trip).
// Defaults to 30s; on timeout the chars/4 heuristic is used instead.
const TOKENIZE_TIMEOUT_MS = parseInt(process.env.PMC_TOKENIZE_TIMEOUT_MS || '30000', 10);

// When --stale-only is set, only re-enrich symbols that changed since last enrichment.
// Symbols with status 'pending' (never enriched) are skipped.
const STALE_ONLY = process.argv.includes('--stale-only');

let _worklist = [];
let _symbolIndex = {};
let _worklistFile = '';
let _symbolIndexFile = '';
let _enrichmentDir = '';
let _queueStateFile = '';
let _startedAt = '';

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

export async function saveWorklistMerged(worklistFile, memWorklist, { loadJson: _lj, saveJson: _sj } = {}) {
  const lj = _lj ?? loadJson;
  const sj = _sj ?? saveJson;
  let diskWorklist = [];
  try { diskWorklist = await lj(worklistFile); } catch {}
  const diskByKey = new Map(diskWorklist.map(e => [e.symbolKey, e]));
  for (const memEntry of memWorklist) {
    const diskEntry = diskByKey.get(memEntry.symbolKey);
    if (diskEntry?.status === 'enriched' && memEntry.status !== 'enriched' && memEntry.status !== 'already_enriched') {
      Object.assign(memEntry, diskEntry);
    }
  }
  await sj(worklistFile, memWorklist);
}

export async function saveSymbolIndexMerged(symbolIndexFile, memIndex, { loadJson: _lj, saveJson: _sj } = {}) {
  if (!symbolIndexFile) return;
  const lj = _lj ?? loadJson;
  const sj = _sj ?? saveJson;
  let diskIndex = {};
  try { diskIndex = await lj(symbolIndexFile); } catch {}
  for (const [key, diskEntry] of Object.entries(diskIndex)) {
    if (diskEntry?.status === 'enriched' && memIndex[key]?.status !== 'enriched') {
      memIndex[key] = diskEntry;
    }
  }
  await sj(symbolIndexFile, memIndex);
}

function safeKey(key) {
  return key.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

class SlotTracker {
  constructor(maxSlots) {
    this.maxSlots = maxSlots;
    this.slots = new Map();
    this.completedCount = 0;
    this.errorCount = 0;
    this.totalProcessed = 0;
  }

  allocate(symbol) {
    for (let i = 0; i < this.maxSlots; i++) {
      if (!this.slots.has(i)) {
        const startTime = Date.now();
        this.slots.set(i, { symbol, startTime });
        return i;
      }
    }
    return -1;
  }

  complete(slotIdx, result) {
    const slot = this.slots.get(slotIdx);
    if (!slot) return null;
    const elapsed = Date.now() - slot.startTime;
    this.slots.delete(slotIdx);
    this.completedCount++;
    this.totalProcessed++;
    return { ...slot, elapsed, result };
  }

  fail(slotIdx, error) {
    const slot = this.slots.get(slotIdx);
    if (!slot) return null;
    const elapsed = Date.now() - slot.startTime;
    this.slots.delete(slotIdx);
    this.errorCount++;
    this.totalProcessed++;
    return { ...slot, elapsed, error };
  }

  isFull() {
    return this.slots.size >= this.maxSlots;
  }

  activeCount() {
    return this.slots.size;
  }

  hasActiveSlots() {
    return this.slots.size > 0;
  }
}

function createAgentSubagentProvider() {
  return {
    kind: 'agent-subagent',
    isConfigured(context) {
      const { enabled = true, agentName = 'enrich' } = context?.config?.agentSubagent ?? {};
      if (!enabled) {
        return { ok: false, reason: 'agent-subagent is disabled' };
      }

      return { ok: true, provider: agentName };
    },
    async isAvailable() {
      return { ok: false, reason: 'agent-subagent is unavailable in cli context', errorType: 'provider' };
    },
    async enrich() {
      throw new Error('agent-subagent is unavailable in cli context');
    },
  };
}

async function buildSymbolPromptMeta(symbol, projectRoot) {
  const absoluteFile = resolve(projectRoot, symbol.filePath);
  const content = await readFile(absoluteFile, 'utf8');
  const lines = content.split('\n');
  const totalLines = lines.length;

  const codeSection = lines.slice(symbol.range.startLine - 1, symbol.range.endLine).join('\n');
  const importsSection = lines.slice(0, symbol.range.startLine - 1).filter(l => /^\s*import\b/.test(l) || /^\s*using\b/.test(l)).join('\n');

  const prompt = `Symbol: ${symbol.name}\nKind: ${symbol.kind}\nLanguage: ${symbol.language}\nLocation: ${symbol.filePath}:${symbol.range.startLine}-${symbol.range.endLine}\n\nContext (imports):\n${importsSection || '(none)'}\n\nCode:\n${codeSection}\n\nReturn a compact structured explanation with:\n- responsibility\n- primary inputs\n- output\n- immediate dependencies\n- role in module`;
  return { prompt, totalLines };
}

async function buildSymbolPrompt(symbol, projectRoot) {
  const { prompt } = await buildSymbolPromptMeta(symbol, projectRoot);
  return prompt;
}

export function shouldRouteToSubagent({ tokens, tokenThreshold, span, totalLines, coverageThreshold }) {
  const coverage = totalLines > 0 ? span / totalLines : 0;
  if (coverage >= coverageThreshold) return { route: true, reason: 'file-coverage', coverage };
  if (tokens >= tokenThreshold) return { route: true, reason: 'token-threshold', coverage };
  return { route: false, reason: 'ollama', coverage };
}

function applyAttemptsToEntry(entry, attempts) {
  let updated = { ...entry };
  for (const attempt of attempts ?? []) {
    updated = withRecordedAttempt(updated, attempt);
  }
  return updated;
}

function getLastAttemptMode(attempts) {
  return attempts?.length ? attempts[attempts.length - 1].mode ?? null : null;
}

function getLastAttemptError(attempts) {
  for (let idx = (attempts?.length ?? 0) - 1; idx >= 0; idx--) {
    const message = attempts[idx]?.errorMessage;
    if (message) {
      return message;
    }
  }

  return 'All enrichment providers failed';
}

function createQueueEnrichmentError(result) {
  const error = new Error(result.error);
  error.symbolKey = result.symbolKey;
  error.attempts = result.attempts;
  error.lastModeUsed = result.lastModeUsed;
  error.failedAt = result.failedAt;
  return error;
}

export function buildQueueSummary(worklist) {
  return {
    enriched: worklist.filter((entry) => entry.status === 'enriched' || entry.status === 'already_enriched').length,
    errors: worklist.filter((entry) => entry.status === 'error').length,
    pending: worklist.filter((entry) => entry.status === 'pending' || entry.status === 'stale').length,
    subagentQueued: worklist.filter((entry) => entry.status === 'subagent-queued').length,
  };
}

async function loadRuntimeEnrichmentConfig(projectRoot, env) {
  const projectConfig = await loadOptionalJson(resolve(projectRoot, '.opencode', PMC_ENRICHMENT_CONFIG_FILE));
  const globalConfig = await loadOptionalJson(resolve(homedir(), '.config', 'opencode', PMC_ENRICHMENT_CONFIG_FILE));
  return resolveEnrichmentConfig({ projectConfig, globalConfig, env });
}

function createQueueProviders() {
  return [
    createLocalModelProvider(),
    createCloudApiProvider(),
    createAgentSubagentProvider(),
  ];
}

/**
 * Persist a successful enrichment result to disk:
 * - Writes the <symbolKey>.memory.json file
 * - Updates the worklist entry → 'enriched'
 * - Updates symbolIndex
 * - Appends to sync-manifest for later agent-memory upsert
 *
 * Shared by the Ollama queue path and by `pmc subagent-apply`.
 *
 * @param {object} opts
 * @param {object} opts.symbol        - worklist symbol entry (symbolKey, name, language, kind, filePath, codeHash, graphNodeId)
 * @param {string} opts.content       - enrichment text (the model's response)
 * @param {string} opts.enrichedByTag - sync-manifest tag, e.g. 'enriched-by-queue' or 'enriched-by-subagent'
 * @param {string} opts.enrichmentDir
 * @param {Array}  opts.worklist      - in-memory worklist array (mutated in place)
 * @param {string} opts.worklistFile
 * @param {object} opts.symbolIndex   - in-memory symbol index (mutated in place)
 * @param {string} opts.symbolIndexFile
 * @param {string} opts.projectSlug
 * @param {Array}  [opts.attempts]    - enrichment attempt records to apply to worklist entry
 * @returns {Promise<{memoryId: string, enrichedAt: string}>}
 */
export async function persistEnrichmentSuccess({
  symbol,
  content,
  enrichedByTag = 'enriched-by-queue',
  source = 'enrich-queue',
  enrichmentDir,
  worklist,
  worklistFile,
  symbolIndex,
  symbolIndexFile,
  projectSlug,
  attempts = [],
}) {
  const memoryId = `queue-${safeKey(symbol.symbolKey)}`;
  const enrichedAt = new Date().toISOString();
  const memoryFile = resolve(enrichmentDir, `${safeKey(symbol.symbolKey)}.memory.json`);

  await saveJson(memoryFile, {
    content,
    category: 'architecture',
    tags: ['symbol', symbol.language, symbol.kind, `project:${projectSlug}`, `file:${symbol.filePath}`],
  });

  const wlEntry = worklist.find((entry) => entry.symbolKey === symbol.symbolKey);
  if (wlEntry) {
    Object.assign(wlEntry, applyAttemptsToEntry(wlEntry, attempts), {
      status: 'enriched',
      memoryId,
      enrichedAt,
      error: undefined,
      failedAt: undefined,
    });
  }

  symbolIndex[symbol.symbolKey] = {
    memoryId,
    graphNodeId: wlEntry?.graphNodeId ?? symbol.graphNodeId ?? null,
    codeHash: symbol.codeHash,
    status: 'enriched',
    lastEnrichedAt: enrichedAt,
  };

  await saveWorklistMerged(worklistFile, worklist);
  if (symbolIndexFile) {
    await saveSymbolIndexMerged(symbolIndexFile, symbolIndex);
  }

  try {
    await appendSyncEntry(enrichmentDir, createSyncEntry({
      action: 'upsert',
      keyTag: `key:symbol:${safeKey(symbol.symbolKey)}`,
      content: `## ${symbol.name}\n\n${content}`,
      category: 'architecture',
      tags: ['symbol', symbol.language, symbol.kind, `project:${projectSlug}`, `file:${symbol.filePath}`, enrichedByTag],
      source,
      symbolKey: symbol.symbolKey,
    }));
  } catch (syncErr) {
    console.error(`[queue] WARN: sync-manifest append failed for ${symbol.name}: ${syncErr.message}`);
  }

  return { memoryId, enrichedAt };
}

export async function runQueueSymbolEnrichment({
  symbol,
  projectRoot,
  projectSlug,
  timeoutMs,
  enrichmentDir,
  worklist,
  worklistFile,
  symbolIndex = {},
  symbolIndexFile = '',
  config,
  providers,
  env = process.env,
  // Accept a pre-built prompt to avoid rebuilding when already counted tokens.
  prompt: prebuiltPrompt,
  runEnrichmentWithFallbackImpl = runEnrichmentWithFallback,
}) {
  const prompt = prebuiltPrompt ?? await buildSymbolPrompt(symbol, projectRoot);
  const result = await runEnrichmentWithFallbackImpl({
    request: { prompt, timeoutMs },
    config,
    providers,
    env,
  });
  const wlEntry = worklist.find((entry) => entry.symbolKey === symbol.symbolKey);

  for (const attempt of result.attempts ?? []) {
    await appendProviderEvent(enrichmentDir, {
      symbolKey: symbol.symbolKey,
      name: symbol.name,
      ...attempt,
    });
  }

  if (result.status === 'succeeded') {
    const { memoryId, enrichedAt } = await persistEnrichmentSuccess({
      symbol,
      content: result.content,
      enrichedByTag: 'enriched-by-queue',
      enrichmentDir,
      worklist,
      worklistFile,
      symbolIndex,
      symbolIndexFile,
      projectSlug,
      attempts: result.attempts,
    });

    return {
      status: 'enriched',
      symbolKey: symbol.symbolKey,
      memoryId,
      memoryContent: result.content,
      language: symbol.language,
      kind: symbol.kind,
      filePath: symbol.filePath,
      projectSlug,
      codeHash: symbol.codeHash,
      attempts: result.attempts ?? [],
      lastModeUsed: wlEntry?.lastModeUsed ?? result.mode ?? getLastAttemptMode(result.attempts),
      enrichedAt,
    };
  }

  const error = getLastAttemptError(result.attempts);
  const failedAt = new Date().toISOString();

  if (wlEntry) {
    Object.assign(wlEntry, applyAttemptsToEntry(wlEntry, result.attempts), {
      status: 'error',
      error,
      failedAt,
    });
  }

  symbolIndex[symbol.symbolKey] = {
    memoryId: null,
    graphNodeId: wlEntry?.graphNodeId ?? symbol.graphNodeId ?? null,
    codeHash: symbol.codeHash,
    status: 'error',
    lastEnrichedAt: failedAt,
  };

  await saveWorklistMerged(worklistFile, worklist);
  if (symbolIndexFile) {
    await saveSymbolIndexMerged(symbolIndexFile, symbolIndex);
  }

  const failure = {
    status: 'error',
    symbolKey: symbol.symbolKey,
    error,
    attempts: result.attempts ?? [],
    lastModeUsed: wlEntry?.lastModeUsed ?? getLastAttemptMode(result.attempts),
    failedAt,
  };

  throw createQueueEnrichmentError(failure);
}

export function buildQueueState({ status, pid, startedAt, heartbeatAt, finishedAt = null, lastError = null, summary }) {
  return {
    status,
    pid,
    startedAt,
    heartbeatAt,
    finishedAt,
    lastError,
    summary: {
      pending: summary?.pending ?? 0,
      enriched: summary?.enriched ?? 0,
      errors: summary?.errors ?? 0,
    },
  };
}

export async function writeQueueState(input) {
  await saveJson(input.queueStateFile, buildQueueState(input));
}

export async function finalizeQueueState(input) {
  await writeQueueState(input);
}

async function checkpointSave() {
  if (!_worklistFile) return;
  console.error('\n[checkpoint] Saving progress...');
  await saveWorklistMerged(_worklistFile, _worklist);
  await saveSymbolIndexMerged(_symbolIndexFile, _symbolIndex);
  const pending = _worklist.filter(s => s.status === 'pending').length;
  const enriched = _worklist.filter(s => s.status === 'enriched').length;
  const errors = _worklist.filter(s => s.status === 'error').length;
  console.error(`[checkpoint] Saved: pending=${pending} enriched=${enriched} errors=${errors}`);
}

process.on('SIGINT', async () => {
  console.error('\n[queue] Interrupted — checkpointing...');
  await checkpointSave();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error('\n[queue] Terminated — checkpointing...');
  await checkpointSave();
  process.exit(0);
});

async function main() {
  const enrichmentDir = resolve(PROJECT_ROOT, '.planning/project-memory-context/enrichment');
  await mkdir(enrichmentDir, { recursive: true });

  const worklistFile = resolve(enrichmentDir, 'worklist.json');
  const symbolIndexFile = resolve(enrichmentDir, 'symbol-index.json');

  _worklistFile = worklistFile;
  _symbolIndexFile = symbolIndexFile;

  let worklist;
  try {
    worklist = await loadJson(worklistFile);
  } catch {
    console.error('[queue] No worklist found. Run Stage A first.');
    process.exit(1);
  }

  let symbolIndex = {};
  try { symbolIndex = await loadJson(symbolIndexFile); } catch {}

  const enrichmentConfig = await loadRuntimeEnrichmentConfig(PROJECT_ROOT, process.env);
  const providers = createQueueProviders();

  _enrichmentDir = enrichmentDir;
  _worklist = worklist;
  _symbolIndex = symbolIndex;

  const queueStateFile = resolve(enrichmentDir, 'queue-state.json');
  _queueStateFile = queueStateFile;

  for (const entry of worklist) {
    if (entry.status === 'enriched' && entry.memoryId) {
      entry.status = 'already_enriched';
      console.error(`[resume] Skipping ${entry.name} (${entry.symbolKey}) — already enriched`);
    }
  }

  const pending = selectWorkItems(worklist, STALE_ONLY);
  const alreadyEnriched = worklist.filter(s => s.status === 'already_enriched').length;
  const staleCount = worklist.filter(s => s.status === 'stale').length;
  const total = worklist.length;

  if (pending.length === 0) {
    const summary = buildQueueSummary(worklist);
    await finalizeQueueState({
      queueStateFile,
      status: 'finished',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      summary,
    });
    console.log(JSON.stringify({ complete: true, total, enriched: summary.enriched, errors: summary.errors }));
    return;
  }

  _startedAt = new Date().toISOString();
  await writeQueueState({
    queueStateFile,
    status: 'running',
    pid: process.pid,
    startedAt: _startedAt,
    heartbeatAt: _startedAt,
    summary: buildQueueSummary(worklist),
  });

  const threshold = enrichmentConfig.subagentTokenThreshold ?? 5000;
  const coverageThreshold = enrichmentConfig.fileCoverageThreshold ?? 0.8;
  console.error(`[queue] Starting sequential enrichment: ${pending.length} pending (${staleCount} stale), ${alreadyEnriched} already enriched`);
  console.error(`[queue] Modes: ${enrichmentConfig.preferredModes.join(', ')} | Local: ${enrichmentConfig.localModel.baseUrl} | Model: ${enrichmentConfig.localModel.model} | Timeout: ${TIMEOUT_MS}ms per symbol`);
  console.error(`[queue] Token routing: threshold=${threshold} | File coverage threshold=${Math.round(coverageThreshold * 100)}% | Tokenize timeout: ${TOKENIZE_TIMEOUT_MS}ms | Ollama concurrency: 1 (sequential)\n`);

  const results = [];
  const errors = [];
  const subagentQueued = [];
  const startTime = Date.now();
  let lastHeartbeat = Date.now();

  for (const symbol of pending) {
    const symbolStart = Date.now();

    // 1. Build prompt (also returns totalLines for file-coverage check)
    let prompt;
    let totalLines = 0;
    try {
      ({ prompt, totalLines } = await buildSymbolPromptMeta(symbol, PROJECT_ROOT));
    } catch (err) {
      console.error(`[queue] ERROR building prompt for ${symbol.name}: ${err.message}`);
      errors.push({ symbolKey: symbol.symbolKey, error: err.message, elapsed: 0, failedAt: new Date().toISOString() });
      const wlEntry = worklist.find((s) => s.symbolKey === symbol.symbolKey);
      if (wlEntry) {
        wlEntry.status = 'error';
        wlEntry.error = err.message;
        wlEntry.failedAt = new Date().toISOString();
      }
      await saveWorklistMerged(worklistFile, worklist);
      continue;
    }

    const span = (symbol.range?.endLine ?? 0) - (symbol.range?.startLine ?? 0) + 1;

    // 2. Count tokens via Ollama prompt_eval_count (num_predict:1).
    //    Falls back to chars/4 heuristic on error or timeout.
    let tokens;
    try {
      const counted = await countPromptTokens({
        baseUrl: enrichmentConfig.localModel.baseUrl,
        model: enrichmentConfig.localModel.model,
        prompt,
        timeoutMs: TOKENIZE_TIMEOUT_MS,
      });
      tokens = counted !== null ? counted : estimateTokens(prompt);
    } catch {
      tokens = estimateTokens(prompt);
    }

    // 3. Route: file-coverage check takes priority, then token threshold
    const routing = shouldRouteToSubagent({ tokens, tokenThreshold: threshold, span, totalLines, coverageThreshold });
    if (routing.route) {
      // Emit to subagent queue — the /enrich skill will drain this with Task subagents
      try {
        await appendSubagentQueue(_enrichmentDir, {
          symbolKey: symbol.symbolKey,
          name: symbol.name,
          filePath: symbol.filePath,
          language: symbol.language,
          kind: symbol.kind,
          tokenCount: tokens,
          prompt,
          queuedAt: new Date().toISOString(),
        });
      } catch (qErr) {
        console.error(`[queue] WARN: failed to write subagent-queue for ${symbol.name}: ${qErr.message}`);
      }

      const wlEntry = worklist.find((s) => s.symbolKey === symbol.symbolKey);
      if (wlEntry) wlEntry.status = 'subagent-queued';
      await saveWorklistMerged(worklistFile, worklist);

      const elapsed = Date.now() - symbolStart;
      subagentQueued.push({ symbolKey: symbol.symbolKey, tokenCount: tokens });
      const coveragePct = Math.round(routing.coverage * 100);
      console.error(`[route] ${symbol.name} → subagent-queued (${routing.reason}: ${tokens} tokens, ${coveragePct}% file coverage, ${elapsed}ms)`);
    } else {
      // 4. Enrich via Ollama — sequential, awaited
      try {
        const result = await runQueueSymbolEnrichment({
          symbol,
          projectRoot: PROJECT_ROOT,
          projectSlug: PROJECT_SLUG,
          timeoutMs: TIMEOUT_MS,
          enrichmentDir: _enrichmentDir,
          worklist,
          worklistFile,
          symbolIndex,
          symbolIndexFile,
          config: enrichmentConfig,
          providers,
          env: process.env,
          prompt, // pass pre-built prompt — no double round-trip
        });
        const elapsed = Date.now() - symbolStart;
        console.error(`[queue] DONE ${symbol.name} (${symbol.filePath}) — ${Math.round(elapsed / 1000)}s — ${tokens} tokens`);
        results.push({ symbolKey: symbol.symbolKey, memoryId: result.memoryId, elapsed });
      } catch (err) {
        const elapsed = Date.now() - symbolStart;
        console.error(`[queue] ERROR ${symbol.name}: ${err.message} (${Math.round(elapsed / 1000)}s)`);
        errors.push({ symbolKey: symbol.symbolKey, error: err.message, elapsed, failedAt: err.failedAt ?? null });

        const wlEntry = worklist.find((s) => s.symbolKey === symbol.symbolKey);
        if (wlEntry) {
          wlEntry.status = 'error';
          wlEntry.error = err.message;
          wlEntry.failedAt = new Date().toISOString();
        }
        await saveWorklistMerged(worklistFile, worklist);
      }
    }

    // 5. Periodic heartbeat (non-blocking)
    if (Date.now() - lastHeartbeat >= REPORT_INTERVAL_MS) {
      const elapsedTotal = Date.now() - startTime;
      const done = results.length + errors.length + subagentQueued.length;
      console.error(`[queue status] done=${done} queued-subagent=${subagentQueued.length} errors=${errors.length} elapsed=${Math.round(elapsedTotal / 1000)}s`);
      await writeQueueState({
        queueStateFile,
        status: 'running',
        pid: process.pid,
        startedAt: _startedAt,
        heartbeatAt: new Date().toISOString(),
        summary: buildQueueSummary(worklist),
      }).catch(() => {});
      lastHeartbeat = Date.now();
    }
  }

  await checkpointSave();

  for (const r of results) {
    const entry = worklist.find(s => s.symbolKey === r.symbolKey);
    if (entry) {
      symbolIndex[r.symbolKey] = {
        memoryId: r.memoryId,
        graphNodeId: entry.graphNodeId ?? null,
        codeHash: entry.codeHash,
        status: 'enriched',
        lastEnrichedAt: entry.enrichedAt,
      };
    }
  }
  for (const err of errors) {
    const entry = worklist.find(s => s.symbolKey === err.symbolKey);
    if (entry) {
      symbolIndex[err.symbolKey] = {
        memoryId: null,
        graphNodeId: entry.graphNodeId ?? null,
        codeHash: entry.codeHash,
        status: 'error',
        lastEnrichedAt: err.failedAt || null,
      };
    }
  }
  await saveSymbolIndexMerged(symbolIndexFile, symbolIndex);

  const totalElapsed = Date.now() - startTime;
  const summary = buildQueueSummary(worklist);
  const avgTime = results.length > 0 ? results.reduce((a, r) => a + r.elapsed, 0) / results.length : 0;

  const finishedAt = new Date().toISOString();
  await finalizeQueueState({
    queueStateFile,
    status: 'finished',
    pid: process.pid,
    startedAt: _startedAt,
    heartbeatAt: finishedAt,
    finishedAt,
    summary,
  });

  const retryLaunch = await maybeLaunchRetryErrors({
    projectRoot: PROJECT_ROOT,
    enrichmentDir,
    summary,
    loadRetryState: async () => loadOptionalJson(resolve(enrichmentDir, 'retry-state.json')),
  });

  if (retryLaunch.launched) {
    console.error(`[queue] Auto-launched retry-errors in background -> ${retryLaunch.stdoutPath}`);
  } else if (retryLaunch.reason === 'already-running') {
    console.error('[queue] Retry-errors already running; skipping second launch');
  }

  if (summary.subagentQueued > 0) {
    console.error(`[queue] ${summary.subagentQueued} symbol(s) routed to subagent-queue.json — run /enrich skill to process them (up to 5 Task subagents in parallel).`);
  }

  console.log(JSON.stringify({
    complete: summary.pending === 0 && summary.subagentQueued === 0,
    total: worklist.length,
    enriched: summary.enriched,
    errors: summary.errors,
    pending: summary.pending,
    subagentQueued: summary.subagentQueued,
    totalElapsedSeconds: Math.round(totalElapsed / 1000),
    avgSymbolTimeSeconds: Math.round(avgTime / 1000),
    resultsPerSecond: Math.round((results.length / (totalElapsed / 1000)) * 100) / 100,
    timing: results.map((r) => ({ symbolKey: r.symbolKey, seconds: Math.round(r.elapsed / 1000) })),
  }, null, 2));
}

export async function maybeLaunchRetryErrors({
  projectRoot,
  enrichmentDir,
  summary,
  loadRetryState = async () => null,
  spawnRetryProcess = launchRetryProcess,
}) {
  if ((summary?.errors ?? 0) === 0) {
    return { launched: false, reason: 'no-errors' };
  }

  const retryState = await loadRetryState();
  if (retryState?.status === 'running') {
    return { launched: false, reason: 'already-running', retryState };
  }

  const scriptPath = resolve(__dirname, 'retry-errors.mjs');
  const stdoutPath = resolve(enrichmentDir, 'retry-stdout.log');
  const stderrPath = resolve(enrichmentDir, 'retry-stderr.log');
  const startedAt = new Date().toISOString();
  const pid = process.pid;

  await writeRetryState({
    enrichmentDir,
    status: 'running',
    pid,
    projectRoot,
    startedAt,
    heartbeatAt: startedAt,
  });

  await spawnRetryProcess({ projectRoot, scriptPath, stdoutPath, stderrPath });
  return { launched: true, reason: 'spawned', stdoutPath, stderrPath };
}

async function launchRetryProcess({ projectRoot, scriptPath, stdoutPath, stderrPath }) {
  const stdout = await open(stdoutPath, 'a');
  const stderr = await open(stderrPath, 'a');
  const child = spawn(process.execPath, [scriptPath, projectRoot, '--concurrency', '1', '--timeout', String(TIMEOUT_MS)], {
    detached: true,
    stdio: ['ignore', stdout.fd, stderr.fd],
    cwd: projectRoot,
  });
  child.unref();
  stdout.close();
  stderr.close();
}

export async function writeRetryState({ enrichmentDir, status, pid, projectRoot, startedAt, heartbeatAt, finishedAt = null, lastError = null }) {
  const retryStateFile = resolve(enrichmentDir, 'retry-state.json');
  await saveJson(retryStateFile, { status, pid, projectRoot, startedAt, heartbeatAt, finishedAt, lastError });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (err) => {
    try {
      const summary = Array.isArray(_worklist) ? buildQueueSummary(_worklist) : { pending: 0, enriched: 0, errors: 0 };
      const enrichmentDir = _enrichmentDir || resolve(PROJECT_ROOT, '.planning/project-memory-context/enrichment');
      await finalizeQueueState({
        queueStateFile: resolve(enrichmentDir, 'queue-state.json'),
        status: 'failed',
        pid: process.pid,
        startedAt: _startedAt || new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        lastError: err.message,
        summary,
      });
    } catch {}
    console.error('[fatal]', err.message);
    process.exit(1);
  });
}
