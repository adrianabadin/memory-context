#!/usr/bin/env node
import { resolve } from 'node:path';

import { finalizeEnrichment } from '../src/finalize-enrichment.mjs';
import { loadResultInput } from '../src/result-input.mjs';

const [, , rawResultInput] = process.argv;

if (!rawResultInput) {
  console.error('Usage: node finalize-enrichment.mjs <result-json|@result-file>');
  process.exit(1);
}

const projectRoot = resolve(process.cwd());
const result = await loadResultInput(rawResultInput);
const finalized = await finalizeEnrichment({ projectRoot, result });

console.log(JSON.stringify({
  saved: true,
  graphFile: finalized.graphFile,
  indexFile: finalized.indexFile,
  worklistFile: finalized.worklistFile,
  symbolKey: result.symbolKey,
  status: result.status,
}, null, 2));
