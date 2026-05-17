import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  ensureProjectMemoryContextDirs,
  readJsonArtifact,
  writeJsonArtifact,
} from './artifacts.mjs';
import { buildSemanticUnit } from './semantic-unit.mjs';

export async function prepareSemanticJobs({ projectRoot }) {
  const resolvedRoot = resolve(projectRoot);
  const dirs = await ensureProjectMemoryContextDirs(resolvedRoot);
  const worklistFile = join(dirs.enrichment, 'worklist.json');
  const outputFile = join(dirs.enrichment, 'semantic-jobs.json');
  const worklist = await readJsonArtifact(worklistFile, []);

  const pendingSymbols = worklist.filter((symbol) => symbol.status === 'pending');
  const jobs = [];

  for (const symbol of pendingSymbols) {
    const absoluteFile = resolve(resolvedRoot, symbol.filePath);
    const content = await readFile(absoluteFile, 'utf8');
    jobs.push(buildSemanticUnit({ symbol, content }));
  }

  await writeJsonArtifact(outputFile, jobs);
  return {
    file: outputFile,
    count: jobs.length,
    jobs,
  };
}
