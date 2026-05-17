#!/usr/bin/env node
import { join, resolve } from 'node:path';

import { ensureProjectMemoryContextDirs, writeJsonArtifact } from '../src/artifacts.mjs';
import { buildIntakeContext } from '../src/intake-context.mjs';

const [, , projectDescription = '', ...goalArgs] = process.argv;

if (!projectDescription.trim()) {
  console.error('Usage: node save-intake-context.mjs "project description" goal-one goal-two');
  process.exit(1);
}

const projectRoot = resolve(process.cwd());
const dirs = await ensureProjectMemoryContextDirs(projectRoot);
const intake = buildIntakeContext({
  projectDescription,
  mappingGoals: goalArgs,
});

await writeJsonArtifact(join(dirs.intake, 'latest-context.json'), intake);
console.log(JSON.stringify({ saved: true, file: join(dirs.intake, 'latest-context.json'), intake }, null, 2));
