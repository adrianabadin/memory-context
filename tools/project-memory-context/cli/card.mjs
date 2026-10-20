#!/usr/bin/env node
// S23 — public aggregate-card CLI: `pmc card file|community|feature`.
//
// Follows the existing dispatcher pattern (registered in
// src/command-dispatch.mjs; the top-level usage line is auto-generated from
// that table). The three subcommands use the SAME new reader methods as the
// MCP tools, so both surfaces share one contract:
//   - JSON on stdout only (pretty-printed, deterministic),
//   - diagnostics on stderr only,
//   - invalid input exits nonzero with empty stdout,
//   - `--help` exits 0 with the exact options and examples.
// The command is read-only: per-request read-only graph.db opens plus
// accepted-artifact reads, never production refresh/enrich commands.

import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRelationsReader } from '../src/query/relations.mjs';

const HELP = [
  'Usage: pmc card file <path>',
  '       pmc card community <community-id>',
  '       pmc card feature <name> --member <canonical-key> [--member <canonical-key>]',
  '',
  'Aggregate card commands: deterministic read-only cards over the existing graph and accepted narrative artifacts. JSON on stdout; diagnostics on stderr.',
  '',
  'Options:',
  '  --member <canonical-key>   Explicit canonical symbol or file key (repeatable; feature cards)',
  '  --help, -h                 Show this help',
  '',
  'Examples:',
  '  pmc card file src/services/user.service.ts',
  '  pmc card community 1',
  '  pmc card feature auth --member "ts|src/auth.ts|function|exported|login|2" --member file|src/auth.ts',
  '',
].join('\n');

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findProjectRoot(startDir = process.cwd()) {
  let currentDir = resolve(startDir);
  while (true) {
    if (await fileExists(join(currentDir, '.planning', 'project-memory-context', 'install.json'))) {
      return currentDir;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function parseRequest(sub, rest) {
  const positionals = [];
  const members = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--member') {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error('missing value for --member');
      }
      members.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`unknown flag: ${arg}`);
    }
    positionals.push(arg);
  }

  if (sub === 'file') {
    if (positionals.length === 0) throw new Error('pmc card file requires <path>');
    if (positionals.length > 1) throw new Error(`unexpected argument: ${positionals[1]}`);
    if (members.length > 0) throw new Error(`unknown flag: --member`);
    return { kind: 'file', target: positionals[0] };
  }
  if (sub === 'community') {
    if (positionals.length === 0) throw new Error('pmc card community requires <community-id>');
    if (positionals.length > 1) throw new Error(`unexpected argument: ${positionals[1]}`);
    if (members.length > 0) throw new Error(`unknown flag: --member`);
    return { kind: 'community', communityId: positionals[0] };
  }
  if (sub === 'feature') {
    if (positionals.length === 0) throw new Error('pmc card feature requires <name>');
    if (positionals.length > 1) throw new Error(`unexpected argument: ${positionals[1]}`);
    if (members.length === 0) {
      throw new Error('pmc card feature requires at least one --member <canonical-key>');
    }
    return { kind: 'feature', name: positionals[0], members };
  }
  throw new Error(`unknown card command: ${sub}`);
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  const [sub, ...rest] = args;
  if (!sub) {
    process.stderr.write(HELP);
    return 1;
  }

  let request;
  try {
    request = parseRequest(sub, rest);
  } catch (error) {
    process.stderr.write(`card: ${error.message}\n`);
    return 1;
  }

  const projectRoot = await findProjectRoot(process.cwd());
  if (!projectRoot) {
    process.stderr.write('card: pmc card must be run inside a PMC-enabled project (missing .planning/project-memory-context/install.json).\n');
    return 1;
  }

  const reader = createRelationsReader({ projectRoot });
  let result;
  try {
    if (request.kind === 'file') {
      result = await reader.fileRollup({ target: request.target });
    } else if (request.kind === 'community') {
      result = await reader.communityCard({ communityId: request.communityId });
    } else {
      result = await reader.featureCard({ name: request.name, members: request.members });
    }
  } catch (error) {
    process.stderr.write(`card: ${error.message}\n`);
    return 1;
  }

  if (request.kind === 'file') {
    if (result.status === 'missing') {
      process.stderr.write(`card: target not found in graph: ${request.target}\n`);
      return 1;
    }
    if (result.status === 'ambiguous') {
      const candidates = (result.candidates ?? []).map(candidate => candidate.symbolKey ?? candidate.id).join(', ');
      process.stderr.write(`card: ambiguous target: ${candidates}\n`);
      return 1;
    }
    if (result.status === 'not-a-file') {
      process.stderr.write(`card: target is not a file: ${result.target}\n`);
      return 1;
    }
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main().catch((error) => {
    process.stderr.write(`card: ${error.message}\n`);
    return 1;
  });
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
