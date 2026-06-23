#!/usr/bin/env node
// tools/project-memory-context/cli/sleep-config.mjs
//
// CLI wrapper for sleep-config. Reads, validates, and edits the global
// sleep-mode configuration at ~/.config/opencode/project-memory-context.json.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKDIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TS_SOURCE = resolve(WORKDIR, 'agent-memory-mcp', 'src', 'cli', 'sleep-config-cli.ts');
const TSX_BIN = resolve(WORKDIR, 'agent-memory-mcp', 'node_modules', 'tsx', 'dist', 'cli.mjs');

function printHelp() {
  console.log('Usage: pmc sleep-config [action] [options]');
  console.log('');
  console.log('Actions:');
  console.log('  show                Print the current sleep config (default)');
  console.log('  validate            Validate the current config file');
  console.log('  set <key> <value>   Set a config key and save');
  console.log('');
  console.log('Options:');
  console.log('  --config <path>   Path to config file (default: ~/.config/opencode/project-memory-context.json)');
  console.log('  -h, --help        Show this help message');
  console.log('');
  console.log('Config keys:');
  console.log('  idleMinMinutes, cpuHighPercent, cpuResumeBelowPercent,');
  console.log('  maxRunHours, keepAwakeLeaseMinutes, onlyWhenPluggedIn,');
  console.log('  pauseAfterCurrentSymbol');
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
        rejectPromise(new Error(`sleep-config exited from signal ${signal}`));
        return;
      }
      resolvePromise(code ?? 0);
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main().catch((error) => {
    console.error('[sleep-config] FATAL:', error.message);
    return 1;
  });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
