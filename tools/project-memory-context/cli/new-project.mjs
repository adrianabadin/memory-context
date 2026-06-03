#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'bootstrap.mjs');

export { buildDefaultEnrichmentConfig, mergeEnrichmentConfig } from './bootstrap.mjs';

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
This legacy wrapper is no longer dispatched by \`pmc\`; use \`pmc map-project\`.

Usage:
  pmc map-project [target-repo] [--stage-a] [--stage-b] [--all] [--enrich]
`);
    return 0;
  }

  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], { stdio: 'inherit' });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`new-project exited from signal ${signal}`));
        return;
      }
      resolvePromise(code ?? 0);
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main().catch((err) => {
    console.error('[new-project] FATAL:', err.message);
    return 1;
  });
  if (exitCode !== 0) process.exit(exitCode);
}
