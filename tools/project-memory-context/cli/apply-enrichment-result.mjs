#!/usr/bin/env node
import { resolve } from 'node:path';

import { persistEnrichmentResult } from '../src/persist-enrichment-result.mjs';
import { loadResultInput } from '../src/result-input.mjs';

const [, , rawJson] = process.argv;

if (!rawJson) {
  console.error('Usage: node apply-enrichment-result.mjs "{...json result...}"');
  process.exit(1);
}

let result;
try {
  result = await loadResultInput(rawJson);
} catch (error) {
  console.error(`Invalid JSON payload: ${error.message}`);
  process.exit(1);
}

const projectRoot = resolve(process.cwd());
const persisted = await persistEnrichmentResult({ projectRoot, result });
console.log(JSON.stringify({
  saved: true,
  graphFile: persisted.graphFile,
  indexFile: persisted.indexFile,
  symbolKey: result.symbolKey,
  memoryId: result.memoryId ?? null,
  graphNodeId: result.graphNodeId ?? null,
}, null, 2));
