#!/usr/bin/env node
import { resolve } from 'node:path';

import { recordEnrichmentFailure } from '../src/fail-enrichment.mjs';

const [, , symbolKey, errorMessage, failedAtArg] = process.argv;

if (!symbolKey || !errorMessage) {
  console.error('Usage: node fail-enrichment.mjs <symbol-key> <error-message> [failed-at]');
  process.exit(1);
}

const projectRoot = resolve(process.cwd());
const failedAt = failedAtArg ?? new Date().toISOString();
const failed = await recordEnrichmentFailure({
  projectRoot,
  symbolKey,
  error: errorMessage,
  failedAt,
});

console.log(JSON.stringify({
  saved: true,
  worklistFile: failed.worklistFile,
  failuresFile: failed.failuresFile,
  symbolKey,
  failedAt,
}, null, 2));
