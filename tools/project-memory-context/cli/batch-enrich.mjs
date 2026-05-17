#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ensureProjectMemoryContextDirs, readJsonArtifact, writeJsonArtifact } from '../src/artifacts.mjs';
import { buildSemanticUnit } from '../src/semantic-unit.mjs';
import { buildEnrichmentArtifacts } from '../src/enrichment-artifacts.mjs';
import { updateWorklistEntry } from '../src/worklist-state.mjs';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-coder-v2:16b-ctx32k';
const PROJECT_SLUG = process.env.PMC_PROJECT_SLUG || 'memory-context';

const [, , rawLimit] = process.argv;
const limit = rawLimit ? parseInt(rawLimit, 10) : 10;

async function callOllama(prompt) {
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.1, num_predict: 512 },
    }),
  });
  if (!response.ok) {
    throw new Error(`Ollama ${response.status}: ${await response.text()}`);
  }
  const data = await response.json();
  return data.response;
}

function parseSemanticResponse(text) {
  const fields = {};
  const lines = text.split('\n');
  let currentKey = null;
  let currentValue = '';

  for (const line of lines) {
    const headerMatch = line.match(/^[-*]?\s*(responsibility|inputs?|output|dependencies?|role(?:\s+in\s+module)?|summary)\s*[:]/i);
    if (headerMatch) {
      if (currentKey) fields[currentKey] = currentValue.trim();
      currentKey = headerMatch[1].toLowerCase().replace(/\s+in\s+module/, '').replace(/s$/, '');
      currentValue = line.slice(headerMatch[0].length).trim();
    } else if (currentKey) {
      currentValue += ' ' + line.trim();
    }
  }
  if (currentKey) fields[currentKey] = currentValue.trim();

  return {
    findings: Object.entries(fields).map(([k, v]) => `${k}: ${v}`),
    summary: fields.summary || fields.responsibility || '',
  };
}

function safeKey(key) {
  return key.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

async function main() {
  const projectRoot = resolve(process.cwd());
  const dirs = await ensureProjectMemoryContextDirs(projectRoot);
  const worklistFile = `${dirs.enrichment}/worklist.json`;
  const worklist = await readJsonArtifact(worklistFile, []);

  const pending = worklist.filter((s) => s.status === 'pending');
  const toProcess = limit > 0 ? pending.slice(0, limit) : pending;

  if (toProcess.length === 0) {
    console.log(JSON.stringify({ message: 'No pending symbols', total: worklist.length, pending: 0 }));
    return;
  }

  console.error(`[batch-enrich] Processing ${toProcess.length}/${pending.length} pending symbols`);

  const results = [];
  const memoryPayloads = [];
  let updatedWorklist = worklist;
  let errors = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const symbol = toProcess[i];
    try {
      const absoluteFile = resolve(projectRoot, symbol.filePath);
      const content = await readFile(absoluteFile, 'utf8');
      const unit = buildSemanticUnit({ symbol, content });

      console.error(`[${i + 1}/${toProcess.length}] ${symbol.name} (${symbol.filePath}:${symbol.range.startLine})`);

      const rawResponse = await callOllama(unit.prompt);
      const report = parseSemanticResponse(rawResponse);
      const enrichedAt = new Date().toISOString();

      const artifacts = buildEnrichmentArtifacts({
        projectSlug: PROJECT_SLUG,
        job: symbol,
        report,
        memoryId: null,
        enrichedAt,
      });

      const fileStem = safeKey(symbol.symbolKey);
      const memoryFile = `${dirs.enrichment}/${fileStem}.memory.json`;
      await writeJsonArtifact(memoryFile, artifacts.memoryPayload);

      results.push({
        symbolKey: symbol.symbolKey,
        name: symbol.name,
        file: symbol.filePath,
        status: 'enriched',
        memoryFile,
        summary: report.summary,
      });
      memoryPayloads.push({
        symbolKey: symbol.symbolKey,
        payload: artifacts.memoryPayload,
        memoryFile,
      });

      updatedWorklist = updateWorklistEntry(updatedWorklist, symbol.symbolKey, {
        status: 'enriched',
        enrichedAt,
        memoryId: null,
      });
      await writeJsonArtifact(worklistFile, updatedWorklist);
    } catch (err) {
      errors++;
      console.error(`[error] ${symbol.name}: ${err.message}`);
      updatedWorklist = updateWorklistEntry(updatedWorklist, symbol.symbolKey, {
        status: 'error',
        error: err.message,
        failedAt: new Date().toISOString(),
      });
      await writeJsonArtifact(worklistFile, updatedWorklist);
    }
  }

  const batchStoreFile = `${dirs.enrichment}/batch-store-pending.json`;
  await writeJsonArtifact(batchStoreFile, memoryPayloads);

  console.log(JSON.stringify({
    processed: toProcess.length,
    enriched: results.length,
    errors,
    batchStoreFile,
    results,
  }, null, 2));
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
