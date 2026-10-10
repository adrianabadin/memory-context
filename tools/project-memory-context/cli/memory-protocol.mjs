#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  detectMemoryProtocol,
  formatProtocolReport,
  isValidProtocolVersion,
} from '../src/memory-protocol.mjs';

function log(message) {
  console.error(`[memory-protocol] ${message}`);
}

function parseArgs(args) {
  const json = args.includes('--json');
  let set = null;
  const setIndex = args.indexOf('--set');
  if (setIndex !== -1) {
    set = args[setIndex + 1] ?? null;
  }
  const projectArg = args.find(
    (a, i) => !a.startsWith('-') && args[i - 1] !== '--set',
  );
  return { json, set, projectArg };
}

/**
 * Write the runtime flag to memory-protocol.json.
 *
 * @param {string} projectRoot
 * @param {string} version
 * @returns {Promise<string>} absolute path to the flag file
 */
export async function writeProtocolFlag(projectRoot, version) {
  const planningDir = join(projectRoot, '.planning', 'project-memory-context');
  await mkdir(planningDir, { recursive: true });
  const flagPath = join(planningDir, 'memory-protocol.json');
  const payload = {
    memory_protocol_version: version,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(flagPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return flagPath;
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: pmc memory-protocol [project-dir] [--json] [--set <version>]');
    console.log('');
    console.log('Reads or writes the dual memory-save protocol flag.');
    console.log('Versions: "dual" (fire PMC + Engram) or "pmc-only" (fire PMC only).');
    console.log('');
    console.log('Options:');
    console.log('  --json            Print detection result as JSON');
    console.log('  --set <version>   Persist the flag (dual | pmc-only)');
    return 0;
  }

  const { json, set, projectArg } = parseArgs(args);
  const projectRoot = resolve(projectArg || process.cwd());

  if (set !== null) {
    if (!isValidProtocolVersion(set)) {
      log(`Invalid version: "${set}". Use "dual" or "pmc-only".`);
      return 1;
    }
    const flagPath = await writeProtocolFlag(projectRoot, set);
    log(`Flag set to "${set}" at ${flagPath}`);
  }

  const detection = await detectMemoryProtocol({ projectRoot });

  if (json) {
    console.log(JSON.stringify(detection, null, 2));
  } else {
    console.log(formatProtocolReport(detection));
  }

  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main().catch((error) => {
    console.error('[memory-protocol] FATAL:', error.message);
    return 1;
  });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
