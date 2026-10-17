#!/usr/bin/env node
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

import { runPipeline } from '../src/clients/pipeline.mjs';
import { formatInstallReport } from '../src/clients/report.mjs';
import { selectClients, parseClientCsv } from '../src/clients/detect.mjs';
import { CLIENT_REGISTRY } from '../src/clients/registry.mjs';
import { PROBE_TABLE } from '../src/clients/probes.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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

async function readTemplate(pkgRoot, tplPath) {
  return readFile(join(pkgRoot, 'templates', tplPath), 'utf8');
}

export async function runInstallPmcPipeline({
  targetRoot,
  sourceRoot = DEFAULT_SOURCE_ROOT,
  csvClients,
  flags = [],
  consent = { dependencies: false },
  homeDir,
} = {}) {
  installPmcTools({ sourceRoot, targetRoot });
  const detection = selectClients({
    projectRoot: targetRoot,
    registry: CLIENT_REGISTRY,
    exists: existsSync,
    flags,
    csvClients,
    homeDir,
  });
  const pkgJson = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  const placeholders = {
    PMC_BIN: Object.keys(pkgJson.bin ?? {})[0] ?? 'pmc',
    AGENT_MEMORY_CMD: 'npx -y @aabadin/agent-memory-mcp',
    PROJECT_ROOT: targetRoot,
    CONFIG_DIR: '.pmc',
  };

  const { report } = await runPipeline({
    projectRoot: targetRoot,
    homeDir: homeDir ?? targetRoot,
    packageRoot: sourceRoot,
    registry: CLIENT_REGISTRY,
    probeTable: PROBE_TABLE,
    placeholders,
    readTemplate,
    selectedIds: detection.clientIds,
    consent,
  });
  return { report, detection };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
install-pmc - Initialize PMC project state in a target project

Usage:
  node install-pmc.mjs [target-project-dir] [--client=<id>,<id>] [--yes-install-deps] [--json]

Options:
  --client=<ids>          Override detection with explicit comma-separated client IDs
  --yes-install-deps      Consent to installing declared dependencies
  --json                  Emit InstallReport as JSON
  --help, -h              Show this help
`);
    process.exit(0);
  }

  const jsonMode = args.includes('--json');
  const consent = { dependencies: args.includes('--yes-install-deps') };

  const csvArg = args.find((a) => a.startsWith('--client='));
  const csvClients = csvArg ? parseClientCsv(csvArg.slice('--client='.length)) : undefined;
  const flagArgs = args.filter((a) => a.startsWith('--') && a !== '--json' && !a.startsWith('--client=') && a !== '--yes-install-deps');

  const targetArg = args.find((a) => !a.startsWith('-'));
  const targetRoot = targetArg ? resolve(targetArg) : process.cwd();
  const sourceRoot = DEFAULT_SOURCE_ROOT;

  if (!existsSync(targetRoot)) {
    console.error(`[install-pmc] ERROR: Target directory not found: ${targetRoot}`);
    process.exit(1);
  }

  log(`Source: ${sourceRoot}`);
  log(`Target: ${targetRoot}`);
  log('Created .planning/project-memory-context/ directory structure');

  const { report, detection } = await runInstallPmcPipeline({
    targetRoot,
    sourceRoot,
    csvClients,
    flags: flagArgs,
    consent,
  });

  log(`Detected clients (${detection.source}): ${detection.clientIds.join(', ')}`);
  for (const client of report.clients) {
    for (const cap of client.capabilities) {
      log(`  ${client.clientId}/${cap.capability}: ${cap.status}`);
    }
    if (client.error) log(`  ${client.clientId} ERROR: ${client.error}`);
  }
  console.log(formatInstallReport(report, { jsonMode }));
  process.exit(report.exitCode);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[install-pmc] FATAL:', err.message);
    process.exit(1);
  });
}
