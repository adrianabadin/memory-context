#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export { runQueueSymbolEnrichment, buildQueueSummary, parseQueueConcurrency } from './enrich-queue.mjs';

const SCRIPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'enrich-queue.mjs');

function printHelp() {
  console.log('Usage: pmc enrich [options]');
  console.log('');
  console.log('Options:');
  console.log('  --stale-only   Only re-enrich symbols marked stale (code changed since last enrichment).');
  console.log('                 Skips symbols with status "pending" (never enriched).');
  console.log('  --background   Detach the enrichment process and return immediately (non-blocking).');
  console.log('                 Works cross-platform without shell & or agent run_in_background flags.');
  console.log('  -h, --help     Show this help message.');
}

export async function runEnrichQueue(projectRoot = process.cwd()) {
  const mod = await import('./enrich-queue.mjs');
  if (typeof mod.default === 'function') {
    return mod.default(projectRoot);
  }
  return null;
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const background = args.includes('--background');
  const childArgs = args.filter(a => a !== '--background');

  if (background) {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...childArgs], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    console.log(`[enrich] Started in background (pid ${child.pid})`);
    return 0;
  }

  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...childArgs], { stdio: 'inherit' });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`enrich exited from signal ${signal}`));
        return;
      }
      resolvePromise(code ?? 0);
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main().catch((error) => {
    console.error('[enrich] FATAL:', error.message);
    return 1;
  });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
