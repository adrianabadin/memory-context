#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main as enrichMain } from './enrich.mjs';

export async function main(args = process.argv.slice(2)) {
  console.error('[enrich-sync] DEPRECATED: This script hardcodes Ollama. Use `pmc enrich .` instead.');
  console.error('[enrich-sync] The enrich queue supports the shared fallback driver (local-model -> cloud-api -> agent-subagent).');
  console.error('[enrich-sync] Run: pmc enrich .');
  return enrichMain(args);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main().catch((error) => {
    console.error('[enrich-sync] FATAL:', error.message);
    return 1;
  });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
