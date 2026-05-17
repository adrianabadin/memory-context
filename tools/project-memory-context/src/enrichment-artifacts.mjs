import { join, resolve } from 'node:path';

import {
  ensureProjectMemoryContextDirs,
  writeJsonArtifact,
} from './artifacts.mjs';
import { buildEnrichmentResult, buildMemoryPayload } from './memory-payload.mjs';
import { normalizeSemanticReport } from './semantic-report.mjs';

function safeSymbolKey(symbolKey) {
  return symbolKey.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

export function buildEnrichmentArtifacts({ projectSlug, job, report, memoryId, enrichedAt }) {
  const semantic = normalizeSemanticReport(report);
  const memoryPayload = buildMemoryPayload({ projectSlug, job, semantic });
  const enrichmentResult = memoryId
    ? buildEnrichmentResult({
        job,
        memoryId,
        semanticSummary: semantic.summary || semantic.responsibility,
        status: 'enriched',
        enrichedAt,
      })
    : null;

  return {
    semantic,
    memoryPayload,
    enrichmentResult,
  };
}

export async function persistEnrichmentArtifacts({
  projectRoot,
  projectSlug,
  job,
  report,
  memoryId,
  enrichedAt,
}) {
  const resolvedRoot = resolve(projectRoot);
  const dirs = await ensureProjectMemoryContextDirs(resolvedRoot);
  const artifacts = buildEnrichmentArtifacts({
    projectSlug,
    job,
    report,
    memoryId,
    enrichedAt,
  });
  const fileStem = safeSymbolKey(job.symbolKey);
  const memoryPayloadFile = join(dirs.enrichment, `${fileStem}.memory.json`);
  const enrichmentResultFile = memoryId
    ? join(dirs.enrichment, `${fileStem}.result.json`)
    : null;

  await writeJsonArtifact(memoryPayloadFile, artifacts.memoryPayload);
  if (artifacts.enrichmentResult && enrichmentResultFile) {
    await writeJsonArtifact(enrichmentResultFile, artifacts.enrichmentResult);
  }

  return {
    ...artifacts,
    memoryPayloadFile,
    enrichmentResultFile,
  };
}
