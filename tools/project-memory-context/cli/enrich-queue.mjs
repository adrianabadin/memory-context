#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-coder-v2:16b-ctx32k';
const PMC_CONCURRENCY = parseInt(process.env.PMC_CONCURRENCY || '8', 10);
const PROJECT_SLUG = process.env.PMC_PROJECT_SLUG || basename(PROJECT_ROOT);
const TIMEOUT_MS = parseInt(process.env.PMC_TIMEOUT_MS || '300000', 10);
const REPORT_INTERVAL_MS = parseInt(process.env.PMC_REPORT_INTERVAL || '30000', 10);

let _worklist = [];
let _symbolIndex = {};
let _worklistFile = '';
let _symbolIndexFile = '';
let _enrichmentDir = '';

async function loadJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
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

async function callOllama(prompt) {
  const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.1, num_predict: 512 },
    }),
  });
  if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.response;
}

async function enrichSymbol(symbol, projectRoot, ollamaUrl, ollamaModel, projectSlug) {
  const absoluteFile = resolve(projectRoot, symbol.filePath);
  const content = await readFile(absoluteFile, 'utf8');
  const lines = content.split('\n');

  const codeSection = lines.slice(symbol.range.startLine - 1, symbol.range.endLine).join('\n');
  const importsSection = lines.slice(0, symbol.range.startLine - 1).filter(l => /^\s*import\b/.test(l) || /^\s*using\b/.test(l)).join('\n');

  const prompt = `Symbol: ${symbol.name}\nKind: ${symbol.kind}\nLanguage: ${symbol.language}\nLocation: ${symbol.filePath}:${symbol.range.startLine}-${symbol.range.endLine}\n\nContext (imports):\n${importsSection || '(none)'}\n\nCode:\n${codeSection}\n\nReturn a compact structured explanation with:\n- responsibility\n- primary inputs\n- output\n- immediate dependencies\n- role in module`;

  const response = await callOllama(prompt);

  return {
    symbolKey: symbol.symbolKey,
    memoryContent: response,
    language: symbol.language,
    kind: symbol.kind,
    filePath: symbol.filePath,
    projectSlug,
    codeHash: symbol.codeHash,
  };
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

  _enrichmentDir = enrichmentDir;
  _worklist = worklist;
  _symbolIndex = symbolIndex;

  for (const entry of worklist) {
    if (entry.status === 'enriched' && entry.memoryId) {
      entry.status = 'already_enriched';
      console.error(`[resume] Skipping ${entry.name} (${entry.symbolKey}) — already enriched`);
    }
  }

  const pending = worklist.filter(s => s.status === 'pending');
  const alreadyEnriched = worklist.filter(s => s.status === 'already_enriched').length;
  const total = worklist.length;

  if (pending.length === 0) {
    const enriched = worklist.filter(s => s.status === 'enriched').length;
    const errors = worklist.filter(s => s.status === 'error').length;
    console.log(JSON.stringify({ complete: true, total, enriched, errors }));
    return;
  }

  console.error(`[queue] Starting continuous enrichment: ${pending.length} pending, ${alreadyEnriched} already enriched, ${PMC_CONCURRENCY} parallel slots`);
  console.error(`[queue] Ollama: ${OLLAMA_URL} | Model: ${OLLAMA_MODEL} | Timeout: ${TIMEOUT_MS}ms per symbol\n`);

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

    enrichSymbol(symbol, PROJECT_ROOT, OLLAMA_URL, OLLAMA_MODEL, PROJECT_SLUG)
      .then(async (result) => {
        const completion = tracker.complete(slotIdx, result);

        const memoryFile = resolve(_enrichmentDir, `${safeKey(symbol.symbolKey)}.memory.json`);
        await saveJson(memoryFile, {
          content: result.memoryContent,
          category: 'architecture',
          tags: ['symbol', result.language, result.kind, `project:${result.projectSlug}`, `file:${result.filePath}`],
        });

        console.error(`[slot ${slotIdx}] DONE ${symbol.name} (${symbol.filePath}) — ${Math.round(completion.elapsed / 1000)}s — queuing next`);
        results.push({ symbolKey: symbol.symbolKey, memoryId: `queue-${safeKey(symbol.symbolKey)}`, elapsed: completion.elapsed });

        const wlEntry = worklist.find(s => s.symbolKey === symbol.symbolKey);
        if (wlEntry) {
          wlEntry.status = 'enriched';
          wlEntry.memoryId = `queue-${safeKey(symbol.symbolKey)}`;
          wlEntry.enrichedAt = new Date().toISOString();
        }

        await saveJson(worklistFile, worklist);

        dispatchNext();
      })
      .catch(async (err) => {
        const failure = tracker.fail(slotIdx, err.message);
        console.error(`[slot ${slotIdx}] ERROR ${symbol.name}: ${err.message} (${Math.round(failure.elapsed / 1000)}s)`);
        errors.push({ symbolKey: symbol.symbolKey, error: err.message, elapsed: failure.elapsed });

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
    const checkInterval = setInterval(() => {
      if (!tracker.hasActiveSlots() && queue.length === 0) {
        clearInterval(checkInterval);
        resolve();
      } else {
        const elapsedTotal = Date.now() - startTime;
        const remaining = queue.length;
        const active = tracker.activeCount();
        const done = results.length + errors.length;
        console.error(`[queue status] done=${done} active=${active} queued=${remaining} elapsed=${Math.round(elapsedTotal / 1000)}s`);
      }
    }, REPORT_INTERVAL_MS);
  });

  await checkpointSave();

  for (const r of results) {
    const entry = worklist.find(s => s.symbolKey === r.symbolKey);
    if (entry) {
      symbolIndex[r.symbolKey] = {
        memoryId: r.memoryId,
        graphNodeId: null,
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
        graphNodeId: null,
        codeHash: entry.codeHash,
        status: 'error',
        lastEnrichedAt: err.failedAt || null,
      };
    }
  }
  await saveJson(symbolIndexFile, symbolIndex);

  const totalElapsed = Date.now() - startTime;
  const enriched = worklist.filter(s => s.status === 'enriched').length;
  const errCount = worklist.filter(s => s.status === 'error').length;
  const stillPending = worklist.filter(s => s.status === 'pending').length;
  const avgTime = results.length > 0 ? results.reduce((a, r) => a + r.elapsed, 0) / results.length : 0;

  console.log(JSON.stringify({
    complete: stillPending === 0,
    total: worklist.length,
    enriched,
    errors: errCount,
    pending: stillPending,
    totalElapsedSeconds: Math.round(totalElapsed / 1000),
    avgSymbolTimeSeconds: Math.round(avgTime / 1000),
    resultsPerSecond: Math.round((results.length / (totalElapsed / 1000)) * 100) / 100,
    timing: results.map(r => ({ symbolKey: r.symbolKey, seconds: Math.round(r.elapsed / 1000) })),
  }, null, 2));
}

main().catch(err => {
  console.error('[fatal]', err.message);
  process.exit(1);
});