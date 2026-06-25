#!/usr/bin/env node
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { detectAgentType, installAgentTemplates } from '../src/template-installer.mjs';
import { resolveConfigDirs } from '../src/platform.mjs';

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

  installPmcTools({ sourceRoot, targetRoot });
  log('Created .planning/project-memory-context/ directory structure');

  const agent = detectAgentType(targetRoot);
  log(`Detected agent: ${agent} — updating skills (force overwrite)…`);
  const { globalConfig } = resolveConfigDirs(targetRoot);
  await installAgentTemplates({
    projectRoot: targetRoot,
    agent,
    globalConfigDir: agent === 'opencode' ? globalConfig : undefined,
  });
  log(`Skills updated for ${agent}.`);

  // Write .mcp.json for Claude Code / Cursor (OpenCode uses .opencode/opencode.json)
  if (agent === 'claude-code' || agent === 'cursor') {
    const mcpPath = join(targetRoot, '.mcp.json');
    let existing = {};
    try {
      existing = JSON.parse(readFileSync(mcpPath, 'utf8'));
    } catch {}

    const planningBase = resolve(targetRoot, '.planning', 'project-memory-context');
    const memoryDbPath = resolve(planningBase, 'memory-db');

    const mcpConfig = {
      mcpServers: {
        ...(existing.mcpServers ?? {}),
        'agent-memory': {
          command: 'npx',
          args: ['-y', '@aabadin/agent-memory-mcp'],
          env: {
            MEMORY_DB_PATH: memoryDbPath,
          },
        },
        'pmc-query': {
          command: 'npx',
          args: ['--yes', '--package', '@aabadin/project-memory-context', 'pmc-query-server'],
          env: {
            PMC_PROJECT_ROOT: resolve(targetRoot),
          },
        },
      },
    };

    writeFileSync(mcpPath, `${JSON.stringify(mcpConfig, null, 2)}\n`, 'utf8');
    log(`Written .mcp.json with agent-memory and pmc-query MCP servers`);
  }

  log('Done.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('[install-pmc] FATAL:', err.message);
    process.exit(1);
  });
}
