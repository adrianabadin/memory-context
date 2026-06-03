#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main as enrichMain } from './enrich.mjs';

export async function main(args = process.argv.slice(2)) {
  console.error('[enrich-orchestrator] DEPRECATED: This script hardcodes Ollama and generates subagent manifests.');
  console.error('[enrich-orchestrator] Use `pmc enrich .` for the shared fallback driver.');
  console.error('[enrich-orchestrator] Run: pmc enrich .');
  return enrichMain(args);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main().catch((error) => {
    console.error('[enrich-orchestrator] FATAL:', error.message);
    return 1;
  });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
