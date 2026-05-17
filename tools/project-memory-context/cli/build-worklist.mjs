#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import {
  ensureProjectMemoryContextDirs,
  readJsonArtifact,
  writeJsonArtifact,
} from '../src/artifacts.mjs';
import { attachGraphNodeIds } from '../src/graph-node-resolver.mjs';
import { buildEnrichmentWorklist, extractTopLevelSymbols } from '../src/symbol-extractor.mjs';

const projectRoot = resolve(process.cwd());
const dirs = await ensureProjectMemoryContextDirs(projectRoot);
const symbolIndex = await readJsonArtifact(join(dirs.enrichment, 'symbol-index.json'), {});
const graph = await readJsonArtifact(join(dirs.graph, 'graph.json'), { nodes: [], edges: [] });
const files = process.argv.slice(2);

if (files.length === 0) {
  console.error('Usage: node build-worklist.mjs <file1> [file2 ...]');
  process.exit(1);
}

const symbols = [];
for (const file of files) {
  const absolute = resolve(projectRoot, file);
  const content = await readFile(absolute, 'utf8');
  symbols.push(...extractTopLevelSymbols({ filePath: relative(projectRoot, absolute), content }));
}

const resolvedSymbols = attachGraphNodeIds({ symbols, graph });
const worklist = buildEnrichmentWorklist({ symbols: resolvedSymbols, symbolIndex });
const outputFile = join(dirs.enrichment, 'worklist.json');
await writeJsonArtifact(outputFile, worklist);
console.log(JSON.stringify({ saved: true, file: outputFile, count: worklist.length }, null, 2));
