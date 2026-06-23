#!/usr/bin/env node
// tools/project-memory-context/cli/sleep-watch.mjs
//
// CLI wrapper for sleep-watch. Starts the idle daemon that monitors CPU/idle
// state and spawns sleep-run when conditions are met.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKDIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TS_SOURCE = resolve(WORKDIR, 'agent-memory-mcp', 'src', 'cli', 'sleep-watch-cli.ts');
const TSX_BIN = resolve(WORKDIR, 'agent-memory-mcp', 'node_modules', 'tsx', 'dist', 'cli.mjs');

function printHelp() {
  console.log('Usage: pmc sleep-watch [options]');
  console.log('');
  console.log('Options:');
  console.log('  --config <path>      Path to global config file');
  console.log('  --checkpoint <path>  Path to daemon checkpoint');
  console.log('  --status             Show daemon status from checkpoint');
  console.log('  --stop               Stop the running daemon');
  console.log('  --poll-ms <ms>       Polling interval in ms (default: 30000)');
  console.log('  --background         Run as detached background process');
  console.log('  -h, --help           Show this help message');
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const background = args.includes('--background');
  const childArgs = args.filter(a => a !== '--background');

  if (background) {
    const child = spawn(process.execPath, [TSX_BIN, TS_SOURCE, ...childArgs], {
      detached: true,
      stdio: 'ignore',
      cwd: WORKDIR,
    });
    child.unref();
    console.log(`[sleep-watch] Started in background (pid ${child.pid})`);
    return 0;
  }

  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [TSX_BIN, TS_SOURCE, ...childArgs], {
      stdio: 'inherit',
      cwd: WORKDIR,
    });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`sleep-watch exited from signal ${signal}`));
        return;
      }
      resolvePromise(code ?? 0);
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main().catch((error) => {
    console.error('[sleep-watch] FATAL:', error.message);
    return 1;
  });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
