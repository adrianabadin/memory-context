#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PMC_ROOT = resolve(__dirname, '..', '..');
const PMC_CLI = __dirname;
const PROJECT_ROOT = process.cwd();

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-coder-v2:16b-ctx32k';
const MAX_PARALLEL = parseInt(process.env.PMC_CONCURRENCY || '8', 10);

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

function buildEnrichmentPrompt(symbol, codeSection, importsSection) {
  return `Symbol: ${symbol.name}
Kind: ${symbol.kind}
Language: ${symbol.language}
Location: ${symbol.filePath}:${symbol.range.startLine}-${symbol.range.endLine}

Context (imports):
${importsSection || '(none)'}

Code:
${codeSection}

Return a compact structured explanation with:
- responsibility
- primary inputs
- output
- immediate dependencies
- role in module`;
}

function parseSymbolKey(symbolKey) {
  const parts = symbolKey.split('|');
  return {
    language: parts[0],
    filePath: parts[1],
    namespace: parts[2],
    containerName: parts[3],
    kind: parts[4],
    name: parts[5],
    signature: parts[6] || '',
  };
}

async function enrichSymbolLocal(symbol) {
  const absoluteFile = resolve(PROJECT_ROOT, symbol.filePath);
  const content = await readFile(absoluteFile, 'utf8');
  const lines = content.split('\n');

  const codeSection = lines.slice(symbol.range.startLine - 1, symbol.range.endLine).join('\n');
  const importsSection = lines.slice(0, symbol.range.startLine - 1).filter(l => /^\s*import\b/.test(l) || /^\s*using\b/.test(l)).join('\n');

  const prompt = buildEnrichmentPrompt(symbol, codeSection, importsSection);

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

  if (!resp.ok) throw new Error(`Ollama ${resp.status}`);
  const data = await resp.json();
  return data.response;
}

async function storeMemory(symbol, memoryContent) {
  const enrichmentDir = resolve(PROJECT_ROOT, '.planning/project-memory-context/enrichment');

  const memoryFile = resolve(enrichmentDir, `${safeKey(symbol.symbolKey)}.memory.json`);
  await saveJson(memoryFile, {
    content: memoryContent,
    category: 'architecture',
    tags: ['symbol', symbol.language, symbol.kind, `project:${PROJECT_ROOT.split(/[/\\]/).pop()}`, `file:${symbol.filePath}`],
    enrichedAt: new Date().toISOString(),
    symbolKey: symbol.symbolKey,
  });

  return memoryFile;
}

async function updateWorklist(symbol, memoryId) {
  const worklistFile = resolve(PROJECT_ROOT, '.planning/project-memory-context/enrichment/worklist.json');
  const worklist = await loadJson(worklistFile);

  const entry = worklist.find(s => s.symbolKey === symbol.symbolKey);
  if (entry) {
    entry.status = 'enriched';
    entry.memoryId = memoryId;
    entry.enrichedAt = new Date().toISOString();
  }

  await saveJson(worklistFile, worklist);
}

async function callAgentMemoryStore(content, category, tags) {
  const result = spawnSync('node', [
    '-e',
    `
    const { spawnSync } = require('child_process');
    const { spawn } = require('child_process');
    const proc = spawn('npx', ['agent-memory-mcp', 'store', '--content', '${content.replace(/'/g, "\\'")}', '--category', '${category}', '--tags', '${tags.join(',')}'], { stdio: 'pipe' });
    let output = '';
    proc.stdout.on('data', d => output += d);
    proc.stderr.on('data', d => console.error(d));
    proc.on('close', code => { if (code !== 0) console.error('agent-memory store failed:', code); });
    `
  ], { stdio: 'inherit' });
}

async function processSymbol(symbol) {
  const startTime = Date.now();
  const symbolKey = symbol.symbolKey;
  const name = symbol.name;

  console.error(`[enrich-batch] Processing ${name} (${symbolKey})`);

  try {
    const memoryContent = await enrichSymbolLocal(symbol);
    const memoryId = safeKey(symbolKey);
    await storeMemory(symbol, memoryContent);
    await updateWorklist(symbol, memoryId);

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.error(`[enrich-batch] DONE ${name} — ${elapsed}s`);

    return { symbolKey, memoryId, memoryContent, status: 'enriched', elapsed };
  } catch (err) {
    console.error(`[enrich-batch] ERROR ${name}: ${err.message}`);
    return { symbolKey, status: 'error', error: err.message };
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(`
enrich-batch - Enrich multiple symbols in parallel using subagents

Usage:
  node enrich-batch.mjs <symbolKey1> <symbolKey2> ... <symbolKeyN>

Environment:
  PMC_CONCURRENCY  Max parallel subagents (default: 8)

Example:
  node enrich-batch.mjs "csharp|AclsTracker/Controls/AuthAvatarControl.xaml.cs|..." "csharp|AclsTracker/Controls/EventLogPanel.xaml.cs|..."
`);
    process.exit(0);
  }

  const worklistFile = resolve(PROJECT_ROOT, '.planning/project-memory-context/enrichment/worklist.json');

  let worklist;
  try {
    worklist = await loadJson(worklistFile);
  } catch {
    console.error('[enrich-batch] No worklist found. Run stage-b first.');
    process.exit(1);
  }

  const symbolKeys = args;
  const symbols = symbolKeys.map(sk => {
    const entry = worklist.find(s => s.symbolKey === sk);
    if (!entry) {
      const parsed = parseSymbolKey(sk);
      return { symbolKey: sk, ...parsed, range: { startLine: 1, endLine: 50 } };
    }
    return entry;
  }).filter(s => s.symbolKey);

  const pendingSymbols = symbols.filter(s => s.status !== 'enriched' && s.status !== 'already_enriched');

  if (pendingSymbols.length === 0) {
    console.error(`[enrich-batch] All ${symbols.length} symbols already enriched.`);
    console.log(JSON.stringify({ status: 'already_enriched', count: symbols.length }));
    return;
  }

  console.error(`[enrich-batch] Enriching ${pendingSymbols.length} symbols with ${MAX_PARALLEL} parallel slots`);

  const results = [];
  const queue = [...pendingSymbols];
  const active = [];

  async function dispatchNext() {
    if (queue.length === 0) return null;
    const symbol = queue.shift();
    return processSymbol(symbol).then(result => {
      results.push(result);
      dispatchNext();
    });
  }

  const init = [];
  for (let i = 0; i < Math.min(MAX_PARALLEL, queue.length); i++) {
    init.push(dispatchNext());
  }

  await Promise.all(init);

  const enriched = results.filter(r => r.status === 'enriched').length;
  const errors = results.filter(r => r.status === 'error').length;

  console.log(JSON.stringify({
    total: symbols.length,
    enriched,
    errors,
    results
  }, null, 2));
}

main().catch(err => {
  console.error('[enrich-batch] FATAL:', err.message);
  process.exit(1);
});