#!/usr/bin/env node
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');

async function loadJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function saveJson(path, data) {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function safeKey(key) {
  return key.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

function buildSubagentPrompt(symbol, projectRoot, ollamaUrl, ollamaModel, projectSlug) {
  const imports = ''; // subagent reads file directly

  return [
    `You are enriching ONE code symbol for project-memory-context. Complete all steps.`,
    ``,
    `SYMBOL: ${JSON.stringify(symbol)}`,
    `PROJECT_ROOT: ${projectRoot}`,
    `OLLAMA_URL: ${ollamaUrl}`,
    `OLLAMA_MODEL: ${ollamaModel}`,
    ``,
    `STEPS:`,
    `1. Read the source file at the symbol's filePath (use Read tool), lines startLine to endLine + imports above`,
    `2. Build a semantic prompt with the code + context (imports)`,
    `3. Call Ollama via bash (node -e) and get the response`,
    `4. Store memory via agent-memory_store tool: content (formatted explanation), category "architecture", tags ["symbol", "${symbol.language}", "${symbol.kind}", "project:${projectSlug}", "file:${symbol.filePath}"]`,
    `5. Return JSON: {"symbolKey":"${symbol.symbolKey}","memoryId":"...","status":"enriched","enrichedAt":"${new Date().toISOString()}"}`,
    ``,
    `Do NOT update any shared JSON files. Only: read code, call Ollama, store memory, return result.`,
  ].join('\n');
}

async function callOllama(prompt, ollamaUrl, ollamaModel) {
  const resp = await fetch(`${ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ollamaModel, prompt, stream: false, options: { temperature: 0.1, num_predict: 512 } }),
  });
  if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.response;
}

async function enrichOneSymbol(symbol, projectRoot, ollamaUrl, ollamaModel, projectSlug) {
  const absoluteFile = resolve(projectRoot, symbol.filePath);
  const content = await readFile(absoluteFile, 'utf8');
  const lines = content.split('\n');

  const codeSection = lines.slice(symbol.range.startLine - 1, symbol.range.endLine).join('\n');
  const importsSection = lines.slice(0, symbol.range.startLine - 1).filter(l => /^\s*import\b/.test(l) || /^\s*using\b/.test(l)).join('\n');

  const prompt = `Symbol: ${symbol.name}\nKind: ${symbol.kind}\nLanguage: ${symbol.language}\nLocation: ${symbol.filePath}:${symbol.range.startLine}-${symbol.range.endLine}\n\nContext (imports):\n${importsSection || '(none)'}\n\nCode:\n${codeSection}\n\nReturn a compact structured explanation with:\n- responsibility\n- primary inputs\n- output\n- immediate dependencies\n- role in module`;

  const response = await callOllama(prompt, ollamaUrl, ollamaModel);

  const memoryPayload = {
    content: response,
    category: 'architecture',
    tags: ['symbol', symbol.language, symbol.kind, `project:${projectSlug}`, `file:${symbol.filePath}`],
  };

  return {
    symbolKey: symbol.symbolKey,
    memoryPayload,
    enrichedAt: new Date().toISOString(),
  };
}

async function main() {
  const [, , manifestPath] = process.argv;

  if (!manifestPath) {
    // No manifest - generate one from current worklist
    const worklistFile = resolve(PROJECT_ROOT, '.planning/project-memory-context/enrichment/worklist.json');
    const enrichmentDir = resolve(PROJECT_ROOT, '.planning/project-memory-context/enrichment');

    let worklist;
    try {
      worklist = await loadJson(worklistFile);
    } catch {
      console.error('[sync] No worklist found. Run Stage A first.');
      process.exit(1);
    }

    const pending = worklist.filter(s => s.status === 'pending');
    if (pending.length === 0) {
      console.log(JSON.stringify({ complete: true, total: worklist.length }));
      return;
    }

    const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
    const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-coder-v2:16b-ctx32k';
    const PMC_BATCH_SIZE = parseInt(process.env.PMC_BATCH_SIZE || '8', 10);
    const PROJECT_SLUG = process.env.PMC_PROJECT_SLUG || 'memory-context';

    const batch = pending.slice(0, PMC_BATCH_SIZE);

    console.error(`[sync] Processing ${batch.length} symbols in parallel...`);

    const results = [];
    const errors = [];

    await Promise.all(batch.map(async (symbol, i) => {
      try {
        console.error(`[${i + 1}/${batch.length}] ${symbol.name} (${symbol.filePath}:${symbol.range.startLine})`);
        const result = await enrichOneSymbol(symbol, PROJECT_ROOT, OLLAMA_URL, OLLAMA_MODEL, PROJECT_SLUG);

        // Save memory artifact
        const memoryFile = resolve(enrichmentDir, `${safeKey(symbol.symbolKey)}.memory.json`);
        await saveJson(memoryFile, result.memoryPayload);

        results.push({
          symbolKey: symbol.symbolKey,
          memoryId: `memory-file:${safeKey(symbol.symbolKey)}`,
          enrichedAt: result.enrichedAt,
          memoryFile,
        });

        // Update worklist entry
        const wlEntry = worklist.find(s => s.symbolKey === symbol.symbolKey);
        if (wlEntry) {
          wlEntry.status = 'enriched';
          wlEntry.memoryId = result.memoryId || `memory-file:${safeKey(symbol.symbolKey)}`;
          wlEntry.enrichedAt = result.enrichedAt;
        }

      } catch (err) {
        console.error(`[error] ${symbol.name}: ${err.message}`);
        errors.push({ symbolKey: symbol.symbolKey, error: err.message, failedAt: new Date().toISOString() });

        const wlEntry = worklist.find(s => s.symbolKey === symbol.symbolKey);
        if (wlEntry) {
          wlEntry.status = 'error';
          wlEntry.error = err.message;
          wlEntry.failedAt = new Date().toISOString();
        }
      }
    }));

    // Save updated worklist
    await saveJson(worklistFile, worklist);

    // Update symbol-index
    const symbolIndexFile = resolve(enrichmentDir, 'symbol-index.json');
    let symbolIndex = {};
    try { symbolIndex = await loadJson(symbolIndexFile); } catch {}

    for (const r of results) {
      const entry = worklist.find(s => s.symbolKey === r.symbolKey);
      if (entry) {
        symbolIndex[r.symbolKey] = {
          memoryId: r.memoryId,
          graphNodeId: entry.graphNodeId || null,
          codeHash: entry.codeHash,
          status: 'enriched',
          lastEnrichedAt: r.enrichedAt,
        };
      }
    }
    for (const err of errors) {
      const entry = worklist.find(s => s.symbolKey === err.symbolKey);
      if (entry) {
        symbolIndex[err.symbolKey] = {
          memoryId: null,
          graphNodeId: entry.graphNodeId || null,
          codeHash: entry.codeHash,
          status: 'error',
          lastEnrichedAt: err.failedAt,
        };
      }
    }
    await saveJson(symbolIndexFile, symbolIndex);

    const remaining = worklist.filter(s => s.status === 'pending').length;
    console.log(JSON.stringify({
      batch: batch.length,
      enriched: results.length,
      errors: errors.length,
      remaining,
      results: results.map(r => ({ symbolKey: r.symbolKey, memoryId: r.memoryId })),
    }));

  }
}

main().catch(err => {
  console.error('[fatal]', err.message);
  process.exit(1);
});