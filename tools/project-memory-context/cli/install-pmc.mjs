#!/usr/bin/env node
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE_ROOT = resolve(__dirname, '..');

function log(msg) {
  console.error(`[install-pmc] ${msg}`);
}

export function installPmcTools({ sourceRoot, targetRoot }) {
  const planningBase = resolve(targetRoot, '.planning', 'project-memory-context');
  const memoryDbPath = resolve(planningBase, 'memory-db');
  for (const sub of ['intake', 'graph', 'enrichment', 'memory-db', 'db']) {
    mkdirSync(resolve(planningBase, sub), { recursive: true });
  }

  const installState = {
    installedAt: new Date().toISOString(),
    memoryDbPath,
    projectRoot: resolve(targetRoot),
    sourceRoot: resolve(sourceRoot),
    version: '0.1.0',
  };

  writeFileSync(
    resolve(planningBase, 'install.json'),
    `${JSON.stringify(installState, null, 2)}\n`,
    'utf8'
  );

  return { cliFiles: 0, srcFiles: 0, templateFiles: 0 };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
install-pmc - Initialize PMC project state in a target project

Usage:
  node install-pmc.mjs [target-project-dir]

Arguments:
  target-project-dir   Path to target project (default: current directory)

Options:
  --help, -h           Show this help
`);
    process.exit(0);
  }

  const targetArg = args.find(a => !a.startsWith('-'));
  const targetRoot = targetArg ? resolve(targetArg) : process.cwd();
  const sourceRoot = DEFAULT_SOURCE_ROOT;

  if (!existsSync(targetRoot)) {
    console.error(`[install-pmc] ERROR: Target directory not found: ${targetRoot}`);
    process.exit(1);
  }

  log(`Source: ${sourceRoot}`);
  log(`Target: ${targetRoot}`);

  const result = installPmcTools({ sourceRoot, targetRoot });

  log(`Created install state: ${result.cliFiles} CLI files, ${result.srcFiles} src files, ${result.templateFiles} templates`);
  log('Created .planning/project-memory-context/ directory structure');
  log('Done.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('[install-pmc] FATAL:', err.message);
    process.exit(1);
  });
}
