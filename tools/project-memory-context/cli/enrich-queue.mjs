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
import { createCloudApiProvider } from '../src/providers/cloud-api-provider.mjs';
import { createLocalModelProvider } from '../src/providers/local-model-provider.mjs';
import { appendSyncEntry, createSyncEntry } from '../src/sync-manifest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');

export function parseQueueConcurrency(rawValue) {
  const parsed = parseInt(rawValue || '8', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

const PMC_CONCURRENCY = parseQueueConcurrency(process.env.PMC_CONCURRENCY);
const PROJECT_SLUG = process.env.PMC_PROJECT_SLUG || basename(PROJECT_ROOT);
const TIMEOUT_MS = parseInt(process.env.PMC_TIMEOUT_MS || '300000', 10);
const REPORT_INTERVAL_MS = parseInt(process.env.PMC_REPORT_INTERVAL || '30000', 10);

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

async function buildSymbolPrompt(symbol, projectRoot) {
  const absoluteFile = resolve(projectRoot, symbol.filePath);
  const content = await readFile(absoluteFile, 'utf8');
  const lines = content.split('\n');

  const codeSection = lines.slice(symbol.range.startLine - 1, symbol.range.endLine).join('\n');
  const importsSection = lines.slice(0, symbol.range.startLine - 1).filter(l => /^\s*import\b/.test(l) || /^\s*using\b/.test(l)).join('\n');

  return `Symbol: ${symbol.name}\nKind: ${symbol.kind}\nLanguage: ${symbol.language}\nLocation: ${symbol.filePath}:${symbol.range.startLine}-${symbol.range.endLine}\n\nContext (imports):\n${importsSection || '(none)'}\n\nCode:\n${codeSection}\n\nReturn a compact structured explanation with:\n- responsibility\n- primary inputs\n- output\n- immediate dependencies\n- role in module`;
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
  runEnrichmentWithFallbackImpl = runEnrichmentWithFallback,
}) {
  const prompt = await buildSymbolPrompt(symbol, projectRoot);
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
    const memoryId = `queue-${safeKey(symbol.symbolKey)}`;
    const enrichedAt = new Date().toISOString();
    const memoryFile = resolve(enrichmentDir, `${safeKey(symbol.symbolKey)}.memory.json`);
    await saveJson(memoryFile, {
      content: result.content,
      category: 'architecture',
      tags: ['symbol', symbol.language, symbol.kind, `project:${projectSlug}`, `file:${symbol.filePath}`],
    });

    if (wlEntry) {
      Object.assign(wlEntry, applyAttemptsToEntry(wlEntry, result.attempts), {
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

    await saveJson(worklistFile, worklist);
    if (symbolIndexFile) {
      await saveJson(symbolIndexFile, symbolIndex);
    }

    try {
      await appendSyncEntry(enrichmentDir, createSyncEntry({
        action: 'upsert',
        keyTag: `key:symbol:${safeKey(symbol.symbolKey)}`,
        content: `## ${symbol.name}\n\n${result.content}`,
        category: 'architecture',
        tags: ['symbol', symbol.language, symbol.kind, `project:${projectSlug}`, `file:${symbol.filePath}`, 'enriched-by-queue'],
        source: 'enrich-queue',
        symbolKey: symbol.symbolKey,
      }));
    } catch (syncErr) {
      console.error(`[queue] WARN: sync-manifest append failed for ${symbol.name}: ${syncErr.message}`);
    }

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

  await saveJson(worklistFile, worklist);
  if (symbolIndexFile) {
    await saveJson(symbolIndexFile, symbolIndex);
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
  await saveJson(_worklistFile, _worklist);
  await saveJson(_symbolIndexFile, _symbolIndex);
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

  const pending = worklist.filter(s => s.status === 'pending' || s.status === 'stale');
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

  console.error(`[queue] Starting continuous enrichment: ${pending.length} pending (${staleCount} stale), ${alreadyEnriched} already enriched, ${PMC_CONCURRENCY} parallel slots`);
  console.error(`[queue] Modes: ${enrichmentConfig.preferredModes.join(', ')} | Local: ${enrichmentConfig.localModel.baseUrl} | Model: ${enrichmentConfig.localModel.model} | Timeout: ${TIMEOUT_MS}ms per symbol\n`);

  const tracker = new SlotTracker(PMC_CONCURRENCY);
  const queue = [...pending];
  const results = [];
  const errors = [];

  const startTime = Date.now();

  async function dispatchNext() {
    if (queue.length === 0) return null;
    const symbol = queue.shift();
    const slotIdx = tracker.allocate(symbol);
    if (slotIdx === -1) {
      queue.unshift(symbol);
      return null;
    }

    runQueueSymbolEnrichment({
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
    })
      .then(async (result) => {
        const completion = tracker.complete(slotIdx, result);

        console.error(`[slot ${slotIdx}] DONE ${symbol.name} (${symbol.filePath}) — ${Math.round(completion.elapsed / 1000)}s — queuing next`);
        results.push({ symbolKey: symbol.symbolKey, memoryId: result.memoryId, elapsed: completion.elapsed });

        dispatchNext();
      })
      .catch(async (err) => {
        const failure = tracker.fail(slotIdx, err.message);
        console.error(`[slot ${slotIdx}] ERROR ${symbol.name}: ${err.message} (${Math.round(failure.elapsed / 1000)}s)`);
        errors.push({ symbolKey: symbol.symbolKey, error: err.message, elapsed: failure.elapsed, failedAt: err.failedAt ?? null });

        const wlEntry = worklist.find(s => s.symbolKey === symbol.symbolKey);
        if (wlEntry) {
          wlEntry.status = 'error';
          wlEntry.error = err.message;
          wlEntry.failedAt = new Date().toISOString();
        }

        await saveJson(worklistFile, worklist);

        dispatchNext();
      });

    return slotIdx;
  }

  const initPromises = [];
  for (let i = 0; i < PMC_CONCURRENCY && queue.length > 0; i++) {
    initPromises.push(dispatchNext());
  }

  await Promise.all(initPromises);

  await new Promise((resolve) => {
    const checkInterval = setInterval(async () => {
      if (!tracker.hasActiveSlots() && queue.length === 0) {
        clearInterval(checkInterval);
        resolve();
      } else {
        const elapsedTotal = Date.now() - startTime;
        const remaining = queue.length;
        const active = tracker.activeCount();
        const done = results.length + errors.length;
        console.error(`[queue status] done=${done} active=${active} queued=${remaining} elapsed=${Math.round(elapsedTotal / 1000)}s`);
        await writeQueueState({
          queueStateFile,
          status: 'running',
          pid: process.pid,
          startedAt: _startedAt,
          heartbeatAt: new Date().toISOString(),
          summary: buildQueueSummary(worklist),
        }).catch(() => {});
      }
    }, REPORT_INTERVAL_MS);
  });

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
  await saveJson(symbolIndexFile, symbolIndex);

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

  console.log(JSON.stringify({
    complete: summary.pending === 0,
    total: worklist.length,
    enriched: summary.enriched,
    errors: summary.errors,
    pending: summary.pending,
    totalElapsedSeconds: Math.round(totalElapsed / 1000),
    avgSymbolTimeSeconds: Math.round(avgTime / 1000),
    resultsPerSecond: Math.round((results.length / (totalElapsed / 1000)) * 100) / 100,
    timing: results.map(r => ({ symbolKey: r.symbolKey, seconds: Math.round(r.elapsed / 1000) })),
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

  const scriptPath = resolve(PROJECT_ROOT, 'tools/project-memory-context/cli/retry-errors.mjs');
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
