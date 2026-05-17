#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-coder-v2:16b-ctx32k';
const PMC_BATCH_SIZE = parseInt(process.env.PMC_BATCH_SIZE || '8', 10);
const PROJECT_SLUG = process.env.PMC_PROJECT_SLUG || basename(PROJECT_ROOT);

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

function buildSubagentPrompt(symbol, projectRoot, ollamaUrl, ollamaModel, projectSlug) {
  return [
    `You are enriching ONE code symbol for project-memory-context.`,
    ``,
    `SYMBOL: ${JSON.stringify(symbol)}`,
    `PROJECT_ROOT: ${projectRoot}`,
    `OLLAMA_URL: ${ollamaUrl}`,
    `OLLAMA_MODEL: ${ollamaModel}`,
    ``,
    `STEPS (do all, in order):`,
    `1. Read the source file at the symbol's filePath (use Read tool), lines startLine to endLine PLUS imports above`,
    `2. Build a semantic prompt:`,
    `   "Symbol: ${symbol.name}\\nKind: ${symbol.kind}\\nLanguage: ${symbol.language}\\nLocation: ${symbol.filePath}:${symbol.range.startLine}-${symbol.range.endLine}\\n\\nReturn a compact structured explanation with:\\n- responsibility\\n- primary inputs\\n- output\\n- immediate dependencies\\n- role in module"`,
    `3. Call Ollama via bash:`,
    `   node -e "fetch('${ollamaUrl}/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:'${ollamaModel}',prompt:'YOUR_PROMPT',stream:false,options:{temperature:0.1,num_predict:512}})}).then(r=>r.json()).then(d=>process.stdout.write(d.response))"`,
    `4. Store memory using agent-memory_store tool:`,
    `   - content: the full Ollama response (structured explanation)`,
    `   - category: "architecture"`,
    `   - tags: ["symbol", "${symbol.language}", "${symbol.kind}", "project:${projectSlug}", "file:${symbol.filePath}"]`,
    `5. Return JSON: {"symbolKey":"${symbol.symbolKey}","memoryId":"...","status":"enriched","enrichedAt":"${new Date().toISOString()}"}`,
    ``,
    `IMPORTANT: Do NOT update any shared JSON files (worklist.json, symbol-index.json). Only: read code, call Ollama, store memory, return result.`,
  ].join('\n');
}

async function main() {
  const enrichmentDir = resolve(PROJECT_ROOT, '.planning/project-memory-context/enrichment');
  await mkdir(enrichmentDir, { recursive: true });

  const worklistFile = resolve(enrichmentDir, 'worklist.json');
  const symbolIndexFile = resolve(enrichmentDir, 'symbol-index.json');

  let worklist;
  try {
    worklist = await loadJson(worklistFile);
  } catch {
    console.error('[queue] No worklist found. Run Stage A first.');
    process.exit(1);
  }

  let symbolIndex = {};
  try { symbolIndex = await loadJson(symbolIndexFile); } catch {}

  const pending = worklist.filter(s => s.status === 'pending');
  const total = worklist.length;

  if (pending.length === 0) {
    const enriched = worklist.filter(s => s.status === 'enriched').length;
    const errors = worklist.filter(s => s.status === 'error').length;
    console.log(JSON.stringify({ complete: true, total, enriched, errors }));
    return;
  }

  console.log(JSON.stringify({
    mode: 'continuous-queue',
    targetConcurrency: PMC_BATCH_SIZE,
    totalPending: pending.length,
    totalSymbols: total,
  }));

  console.error(`[queue] Starting continuous enrichment with ${PMC_BATCH_SIZE} parallel slots`);
  console.error(`[queue] ${pending.length} symbols remaining of ${total} total`);
  console.error('[queue] Dispatch initial batch of 8 subagents via Task tool');

  const initialBatch = pending.slice(0, PMC_BATCH_SIZE);
  const remainingAfterInit = pending.slice(PMC_BATCH_SIZE);

  const symbolsToDispatch = [...initialBatch];
  const pendingQueue = [...remainingAfterInit];

  console.error(`[queue] Initial batch: ${initialBatch.length} dispatched, ${pendingQueue.length} queued`);
  console.error('[queue] As each subagent completes, dispatch the next from the queue');
  console.error('[queue] Batch manifest written for reference\n');

  const manifest = {
    mode: 'continuous-queue',
    projectRoot: PROJECT_ROOT,
    ollamaUrl: OLLAMA_URL,
    ollamaModel: OLLAMA_MODEL,
    projectSlug: PROJECT_SLUG,
    concurrency: PMC_BATCH_SIZE,
    totalSymbols: total,
    initialBatch: initialBatch.map(s => ({ symbolKey: s.symbolKey, name: s.name, filePath: s.filePath, kind: s.kind })),
    queuedBatch: pendingQueue.map(s => ({ symbolKey: s.symbolKey, name: s.name, filePath: s.filePath, kind: s.kind })),
    pendingResults: [],
  };

  const manifestFile = resolve(enrichmentDir, `queue-${Date.now()}.json`);
  await saveJson(manifestFile, manifest);

  console.log(JSON.stringify({
    manifestFile,
    initialBatch: initialBatch.map(s => s.symbolKey),
    queuedCount: pendingQueue.length,
  }));
}

main().catch(err => {
  console.error('[fatal]', err.message);
  process.exit(1);
});