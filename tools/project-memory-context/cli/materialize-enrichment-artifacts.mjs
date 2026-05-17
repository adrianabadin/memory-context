#!/usr/bin/env node
import { join, resolve } from 'node:path';

import { readJsonArtifact } from '../src/artifacts.mjs';
import { persistEnrichmentArtifacts } from '../src/enrichment-artifacts.mjs';
import { loadResultInput } from '../src/result-input.mjs';

const [, , rawJobInput, rawReportInput, memoryIdArg, enrichedAtArg] = process.argv;

if (!rawJobInput || !rawReportInput) {
  console.error('Usage: node materialize-enrichment-artifacts.mjs <job-json|@job-file> <report-json|@report-file> [memory-id] [enriched-at]');
  process.exit(1);
}

const projectRoot = resolve(process.cwd());
const projectSlug = projectRoot.split(/[\\/]/).filter(Boolean).pop() ?? 'project';
const enrichedAt = enrichedAtArg ?? new Date().toISOString();
const memoryId = memoryIdArg && memoryIdArg !== '-' ? memoryIdArg : null;

const job = await loadResultInput(rawJobInput);
const report = await loadResultInput(rawReportInput);

const persisted = await persistEnrichmentArtifacts({
  projectRoot,
  projectSlug,
  job,
  report,
  memoryId,
  enrichedAt,
});

console.log(JSON.stringify({
  saved: true,
  memoryPayloadFile: persisted.memoryPayloadFile,
  enrichmentResultFile: persisted.enrichmentResultFile,
  memoryId,
  summary: persisted.semantic.summary,
}, null, 2));
