#!/usr/bin/env node
import { join, resolve } from 'node:path';

import { ensureProjectMemoryContextDirs } from '../src/artifacts.mjs';
import { executeNativePipeline } from '../src/native-pipeline.mjs';

const projectRoot = resolve(process.cwd());
const dirs = await ensureProjectMemoryContextDirs(projectRoot);
const files = process.argv.slice(2);

if (files.length === 0) {
  console.error('Usage: node build-worklist.mjs <file1> [file2 ...]');
  process.exit(1);
}

const { worklist } = await executeNativePipeline({
  projectRoot,
  dirs,
  files,
  replace: true,
});

const outputFile = join(dirs.enrichment, 'worklist.json');
console.log(JSON.stringify({ saved: true, file: outputFile, count: worklist.length }, null, 2));
