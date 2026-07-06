#!/usr/bin/env node
// tools/project-memory-context/cli/sleep-run.mjs
//
// CLI wrapper for sleep-run. Runs the one-shot maintenance pipeline:
// decay evaluation, promotion passes, and symbol enrichment with
// checkpoint/restore capability.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKDIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TS_SOURCE = resolve(WORKDIR, 'agent-memory-mcp', 'src', 'cli', 'sleep-run-cli.ts');
const TSX_BIN = resolve(WORKDIR, 'agent-memory-mcp', 'node_modules', 'tsx', 'dist', 'cli.mjs');

function printHelp() {
  console.log('Usage: pmc sleep-run [options]');
  console.log('');
  console.log('Options:');
  console.log('  --db <path>          Path to memory database (required unless --resume)');
  console.log('  --checkpoint <path>  Path to checkpoint report');
  console.log('                       (default: ~/.config/opencode/pmc/sleep/run-checkpoint.json)');
  console.log('  --config <path>      Path to global config file');
  console.log('  --projects <ids>     Comma-separated project IDs for multi-project mode');
  console.log('  --resume             Load and display last checkpoint');
  console.log('  -h, --help           Show this help message');
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [TSX_BIN, TS_SOURCE, ...args], {
      stdio: 'inherit',
      cwd: WORKDIR,
    });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`sleep-run exited from signal ${signal}`));
        return;
      }
      resolvePromise(code ?? 0);
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main().catch((error) => {
    console.error('[sleep-run] FATAL:', error.message);
    return 1;
  });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
