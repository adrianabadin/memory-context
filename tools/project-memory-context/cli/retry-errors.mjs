#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendProviderEvent } from '../src/enrichment-attempts.mjs';
import { resolveEnrichmentConfig, PMC_ENRICHMENT_CONFIG_FILE } from '../src/enrichment-config.mjs';
import { runEnrichmentWithFallback } from '../src/enrichment-driver.mjs';
import { createLocalModelProvider } from '../src/providers/local-model-provider.mjs';
import { createCloudApiProvider } from '../src/providers/cloud-api-provider.mjs';
import { appendSyncEntry, createSyncEntry } from '../src/sync-manifest.mjs';
import { MAX_RETRY_ITERATIONS, runRetryLoop } from '../src/retry-errors-runner.mjs';
import { homedir } from 'node:os';

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

function safeKey(key) {
  return key.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

async function buildSymbolPrompt(symbol, projectRoot, maxCodeLines = 80) {
  const absoluteFile = resolve(projectRoot, symbol.filePath);
  const content = await readFile(absoluteFile, 'utf8');
  const lines = content.split('\n');
  const totalSymbolLines = symbol.range.endLine - symbol.range.startLine + 1;
  let codeSection = lines.slice(symbol.range.startLine - 1, symbol.range.endLine).join('\n');
  let truncated = false;
  if (totalSymbolLines > maxCodeLines) {
    const header = lines.slice(symbol.range.startLine - 1, symbol.range.startLine - 1 + Math.floor(maxCodeLines * 0.6)).join('\n');
    const footer = lines.slice(symbol.range.endLine - Math.floor(maxCodeLines * 0.4), symbol.range.endLine).join('\n');
    codeSection = header + '\n  // ... truncated ...\n' + footer;
    truncated = true;
  }
  const importsSection = lines.slice(0, symbol.range.startLine - 1).filter(l => /^\s*import\b/.test(l) || /^\s*using\b/.test(l)).join('\n');
  return `Symbol: ${symbol.name}\nKind: ${symbol.kind}\nLanguage: ${symbol.language}\nLocation: ${symbol.filePath}:${symbol.range.startLine}-${symbol.range.endLine}${truncated ? ` (truncated from ${totalSymbolLines} lines)` : ''}\n\nContext (imports):\n${importsSection || '(none)'}\n\nCode:\n${codeSection}\n\nReturn a compact structured explanation (max 150 words) with:\n- responsibility\n- primary inputs\n- output\n- immediate dependencies\n- role in module`;
}

function parseArgs(argv) {
  const args = { timeoutMs: 600000, model: null, baseUrl: null, reportFile: null, limit: null };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--timeout' && argv[i + 1]) { args.timeoutMs = parseInt(argv[++i], 10); }
    else if (arg === '--model' && argv[i + 1]) { args.model = argv[++i]; }
    else if (arg === '--base-url' && argv[i + 1]) { args.baseUrl = argv[++i]; }
    else if (arg === '--report' && argv[i + 1]) { args.reportFile = argv[++i]; }
    else if (arg === '--limit' && argv[i + 1]) { args.limit = parseInt(argv[++i], 10); }
    else if (arg === '--help' || arg === '-h') { args.help = true; }
  }
  return args;
}

function printHelp() {
  console.log(`
PMC Retry Errors — Re-enriches symbols that failed using full provider fallback chain

Usage: node tools/project-memory-context/cli/retry-errors.mjs [options] [project-root]

Options:
  --timeout MS    Timeout per symbol in ms (default: 600000 = 10min)
  --model NAME    Ollama model name (default: from config)
  --base-url URL  Ollama base URL (default: http://localhost:11434)
  --limit N       Only retry first N error entries (default: all)
  --report PATH   Save JSON report to file (default: .planning/.../retry-report.json)
  -h, --help      Show this help
`);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const projectRoot = rawArgs.find(a => !a.startsWith('-')) || process.cwd();
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); return 0; }

  const enrichmentDir = resolve(projectRoot, '.planning/project-memory-context/enrichment');
  await mkdir(enrichmentDir, { recursive: true });

  const worklistFile = resolve(enrichmentDir, 'worklist.json');
  const symbolIndexFile = resolve(enrichmentDir, 'symbol-index.json');

  let worklist;
  try {
    worklist = await loadJson(worklistFile);
  } catch {
    console.error('[retry] No worklist found.');
    process.exit(1);
  }

  const errorEntries = worklist.filter(e => e.status === 'error');
  if (errorEntries.length === 0) {
    console.log('[retry] No error entries found in worklist. Nothing to retry.');
    return;
  }

  if (args.limit && args.limit < errorEntries.length) {
    console.error(`[retry] Limiting to first ${args.limit} of ${errorEntries.length} error entries`);
    errorEntries.splice(args.limit);
  }

  let symbolIndex = {};
  try { symbolIndex = await loadJson(symbolIndexFile); } catch {}

  const projectConfig = await loadOptionalJson(resolve(projectRoot, '.opencode', PMC_ENRICHMENT_CONFIG_FILE));
  const globalConfig = await loadOptionalJson(resolve(homedir(), '.config', 'opencode', PMC_ENRICHMENT_CONFIG_FILE));
  let config = resolveEnrichmentConfig({ projectConfig, globalConfig, env: process.env });

  if (args.model) {
    config.localModel.model = args.model;
  }
  if (args.baseUrl) {
    config.localModel.baseUrl = args.baseUrl;
  }

  const projectSlug = process.env.PMC_PROJECT_SLUG || basename(projectRoot);

  const providers = [
    createLocalModelProvider(),
    createCloudApiProvider(),
  ];

  console.error(`\n[retry] ═════════════════════════════════════════════════════`);
  console.error(`[retry] Retrying ${errorEntries.length} error symbols using full provider chain`);
  console.error(`[retry] Local Model: ${config.localModel.provider} | ${config.localModel.model} @ ${config.localModel.baseUrl}`);
  console.error(`[retry] Cloud API: ${config.cloudApi.provider} @ ${config.cloudApi.baseUrl}`);
  console.error(`[retry] Max iterations: ${MAX_RETRY_ITERATIONS} | Timeout: ${args.timeoutMs / 1000}s`);
  console.error(`[retry] ═════════════════════════════════════════════════════\n`);

  const retrySymbol = async (candidate, iteration) => {
    const startTime = Date.now();
    const entry = worklist.find(e => e.symbolKey === candidate.symbolKey);
    if (!entry) return { status: 'failed', elapsedMs: 0, attempts: [], failureReason: 'not found in worklist' };

    entry.status = 'pending';
    delete entry.error;
    delete entry.failedAt;

    try {
      const prompt = await buildSymbolPrompt(entry, projectRoot);
      const result = await runEnrichmentWithFallback({
        request: { prompt, timeoutMs: args.timeoutMs },
        config,
        providers,
        env: process.env,
      });

      const elapsed = Date.now() - startTime;

      for (const attempt of result.attempts ?? []) {
        await appendProviderEvent(enrichmentDir, { symbolKey: entry.symbolKey, name: entry.name, ...attempt });
      }

      if (result.status === 'succeeded') {
        const memoryId = `queue-${safeKey(entry.symbolKey)}`;
        const enrichedAt = new Date().toISOString();
        const memoryFile = resolve(enrichmentDir, `${safeKey(entry.symbolKey)}.memory.json`);

        await saveJson(memoryFile, {
          content: result.content,
          category: 'architecture',
          tags: ['symbol', entry.language, entry.kind, `project:${projectSlug}`, `file:${entry.filePath}`],
        });

        const newAttempts = [...(entry.attempts ?? []), ...(result.attempts ?? [])];
        Object.assign(entry, {
          status: 'enriched',
          memoryId,
          enrichedAt,
          error: undefined,
          failedAt: undefined,
          attempts: newAttempts,
        });

        symbolIndex[entry.symbolKey] = {
          memoryId,
          graphNodeId: entry.graphNodeId ?? null,
          codeHash: entry.codeHash,
          status: 'enriched',
          lastEnrichedAt: enrichedAt,
        };

        try {
          await appendSyncEntry(enrichmentDir, createSyncEntry({
            action: 'upsert',
            keyTag: `key:symbol:${safeKey(entry.symbolKey)}`,
            content: `## ${entry.name}\n\n${result.content}`,
            category: 'architecture',
            tags: ['symbol', entry.language, entry.kind, `project:${projectSlug}`, `file:${entry.filePath}`, 'enriched-by-retry'],
            source: 'retry-errors',
            symbolKey: entry.symbolKey,
          }));
        } catch (syncErr) {
          console.error(`[retry] WARN: sync append failed for ${entry.name}: ${syncErr.message}`);
        }

        console.error(`  [OK] iter ${iteration} | ${entry.name} (${entry.filePath}:${entry.range.startLine}) — ${Math.round(elapsed / 1000)}s`);

        await saveJson(worklistFile, worklist);
        await saveJson(symbolIndexFile, symbolIndex);

        return { status: 'succeeded', elapsedMs: elapsed, attempts: result.attempts ?? [], memoryId, contentPreview: result.content?.substring(0, 200) };
      } else {
        const lastError = result.attempts?.find(a => a.errorMessage)?.errorMessage ?? 'all providers failed';
        const newAttempts = [...(entry.attempts ?? []), ...(result.attempts ?? [])];
        Object.assign(entry, {
          status: 'error',
          error: lastError,
          failedAt: new Date().toISOString(),
          attempts: newAttempts,
        });

        symbolIndex[entry.symbolKey] = {
          memoryId: null,
          graphNodeId: entry.graphNodeId ?? null,
          codeHash: entry.codeHash,
          status: 'error',
          lastEnrichedAt: new Date().toISOString(),
        };

        console.error(`  [FAIL] iter ${iteration} | ${entry.name} — ${lastError} — ${Math.round(elapsed / 1000)}s`);

        await saveJson(worklistFile, worklist);
        await saveJson(symbolIndexFile, symbolIndex);

        return { status: 'failed', elapsedMs: elapsed, attempts: result.attempts ?? [], failureReason: lastError };
      }
    } catch (err) {
      const elapsed = Date.now() - startTime;
      entry.status = 'error';
      entry.error = err.message;
      entry.failedAt = new Date().toISOString();

      console.error(`  [ERR] iter ${iteration} | ${entry.name} — ${err.message} — ${Math.round(elapsed / 1000)}s`);

      await saveJson(worklistFile, worklist);
      await saveJson(symbolIndexFile, symbolIndex);

      return { status: 'failed', elapsedMs: elapsed, attempts: [], failureReason: err.message };
    }
  };

  const startedAt = new Date().toISOString();
  const result = await runRetryLoop({
    worklist,
    maxIterations: MAX_RETRY_ITERATIONS,
    retrySymbol,
  });

  const reportPath = args.reportFile || resolve(enrichmentDir, 'retry-report.json');
  await saveJson(reportPath, {
    startedAt,
    finishedAt: new Date().toISOString(),
    iterations: result.iterations,
    config: { model: config.localModel.model, baseUrl: config.localModel.baseUrl, timeoutMs: args.timeoutMs },
    symbols: result.symbols,
    summary: result.summary,
  });

  console.error(`\n[retry] ═════════════════════════════════════════════════════`);
  console.error(`[retry] DONE — ${result.summary.symbolsRecovered} recovered, ${result.summary.symbolsStillFailing} still failing in ${result.iterations} iterations`);
  console.error(`[retry] Report: ${reportPath}`);
  console.error(`[retry] ═════════════════════════════════════════════════════\n`);

  console.log(JSON.stringify({
    ok: true,
    command: 'retry-errors',
    total: result.summary.symbolsRetried,
    succeeded: result.summary.symbolsRecovered,
    failed: result.summary.symbolsStillFailing,
    iterations: result.iterations,
    maxIterationsReached: result.summary.maxIterationsReached,
    reportPath,
  }, null, 2));

  return result.summary.symbolsStillFailing > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main().catch(err => {
    console.error('[retry] FATAL:', err.message);
    return 1;
  });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
