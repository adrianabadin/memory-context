import { join } from 'node:path';

import {
  ensureProjectMemoryContextDirs,
  readJsonArtifact,
  writeJsonArtifact,
} from './artifacts.mjs';
import { persistEnrichmentResult } from './persist-enrichment-result.mjs';
import { updateWorklistEntry } from './worklist-state.mjs';

export async function finalizeEnrichment({ projectRoot, result }) {
  const persisted = await persistEnrichmentResult({ projectRoot, result });
  const dirs = await ensureProjectMemoryContextDirs(projectRoot);
  const worklistFile = join(dirs.enrichment, 'worklist.json');
  const worklist = await readJsonArtifact(worklistFile, []);
  const updatedWorklist = updateWorklistEntry(worklist, result.symbolKey, {
    status: result.status,
    memoryId: result.memoryId,
    graphNodeId: result.graphNodeId ?? null,
    enrichedAt: result.enrichedAt,
    error: undefined,
  });
  await writeJsonArtifact(worklistFile, updatedWorklist);

  return {
    ...persisted,
    worklistFile,
    worklist: updatedWorklist,
  };
}
