import { join } from 'node:path';

import {
  ensureProjectMemoryContextDirs,
  readJsonArtifact,
  writeJsonArtifact,
} from './artifacts.mjs';
import { updateWorklistEntry } from './worklist-state.mjs';

export async function recordEnrichmentFailure({ projectRoot, symbolKey, error, failedAt }) {
  const dirs = await ensureProjectMemoryContextDirs(projectRoot);
  const worklistFile = join(dirs.enrichment, 'worklist.json');
  const failuresFile = join(dirs.enrichment, 'failures.json');
  const worklist = await readJsonArtifact(worklistFile, []);
  const failures = await readJsonArtifact(failuresFile, []);

  const updatedWorklist = updateWorklistEntry(worklist, symbolKey, {
    status: 'error',
    error,
    failedAt,
  });
  const updatedFailures = [...failures, { symbolKey, error, failedAt }];

  await writeJsonArtifact(worklistFile, updatedWorklist);
  await writeJsonArtifact(failuresFile, updatedFailures);

  return {
    worklistFile,
    failuresFile,
    worklist: updatedWorklist,
    failures: updatedFailures,
  };
}
