#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createQueryOrchestrator } from '../src/query/orchestrator.mjs';

function printHelp() {
  console.log('Usage: pmc query <question> [--format text|json]');
  console.log('');
  console.log('Queries PMC project-context and symbol artifacts from the current project.');
  console.log('Use --format json for machine-readable output.');
}

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
    const installPath = join(currentDir, '.planning', 'project-memory-context', 'install.json');
    if (await fileExists(installPath)) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

function parseArgs(args) {
  let format = 'text';
  const questionParts = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--format') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        throw new Error('Missing value for --format. Expected text or json.');
      }

      format = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    }

    questionParts.push(arg);
  }

  return {
    format,
    question: questionParts.join(' ').trim(),
  };
}

function formatSource(source) {
  if (source.type === 'project-context') {
    return `- [project-context] ${source.title} (${source.path})`;
  }

  return `- [symbol] ${source.symbolKey} (${source.filePath})`;
}

function printTextResult(result) {
  console.log(result.answer);
  console.log('');
  console.log('Sources:');
  if (result.sources.length === 0) {
    console.log('- none');
  } else {
    for (const source of result.sources) {
      console.log(formatSource(source));
    }
  }
  console.log(`tokens_saved: ${result.tokens_saved}`);
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const { format, question } = parseArgs(args);
  if (format !== 'text' && format !== 'json') {
    throw new Error(`Unsupported format: ${format}`);
  }

  if (!question) {
    printHelp();
    return 1;
  }

  const projectRoot = await findProjectRoot(process.cwd());
  if (!projectRoot) {
    throw new Error('pmc query must be run inside a PMC-enabled project (missing .planning/project-memory-context/install.json).');
  }

  const orchestrator = createQueryOrchestrator({ projectRoot });
  const result = await orchestrator.query(question);

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  printTextResult(result);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main().catch((error) => {
    console.error('[query] FATAL:', error.message);
    return 1;
  });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
