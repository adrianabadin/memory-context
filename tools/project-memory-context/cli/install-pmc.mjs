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

/**
 * Write .mcp.json for Claude Code / Cursor with agent-memory and pmc-query servers.
 * Merges with existing config to preserve any user-added servers.
 */
function writeMcpJson(targetRoot) {
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

/**
 * Write .opencode/opencode.json with MCP servers for OpenCode.
 * Merges with existing config to preserve plugins, skills, etc.
 */
function writeOpencodeMcpJson(targetRoot) {
  const configPath = join(targetRoot, '.opencode', 'opencode.json');
  let existing = {};
  try {
    existing = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {}

  const planningBase = resolve(targetRoot, '.planning', 'project-memory-context');
  const memoryDbPath = resolve(planningBase, 'memory-db');

  const mcpConfig = {
    ...existing,
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      ...(existing.mcp ?? {}),
      'pmc-query': {
        type: 'local',
        command: ['npx', '--yes', '--package', '@aabadin/project-memory-context', 'pmc-query-server'],
        enabled: true,
        environment: {
          PMC_PROJECT_ROOT: resolve(targetRoot),
        },
      },
      'pmc-agent-memory': {
        type: 'local',
        command: ['npx', '-y', '@aabadin/agent-memory-mcp'],
        enabled: true,
        environment: {
          MEMORY_DB_PATH: memoryDbPath,
          EMBEDDING_MODEL: 'Xenova/bge-m3',
          EMBEDDING_DIMENSIONS: '1024',
          EMBEDDING_POOLING: 'cls',
        },
      },
    },
  };

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(mcpConfig, null, 2)}\n`, 'utf8');
  log(`Written .opencode/opencode.json with pmc-query and pmc-agent-memory MCP servers`);
}

/**
 * Detect ALL agent markers present in the project (not just the primary one).
 * This ensures MCP configs are written for every agent the user might use.
 */
function detectAllAgents(targetRoot) {
  const agents = [];
  if (existsSync(join(targetRoot, '.opencode'))) agents.push('opencode');
  if (existsSync(join(targetRoot, '.claude')) || existsSync(join(targetRoot, 'CLAUDE.md'))) agents.push('claude-code');
  if (existsSync(join(targetRoot, '.cursor')) || existsSync(join(targetRoot, '.cursorrules'))) agents.push('cursor');
  if (existsSync(join(targetRoot, '.agents'))) agents.push('antigravity');
  return agents.length > 0 ? agents : ['generic'];
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

  // Detect ALL agents present, not just the primary one
  const agents = detectAllAgents(targetRoot);
  const primaryAgent = detectAgentType(targetRoot);
  log(`Detected agents: ${agents.join(', ')} (primary: ${primaryAgent})`);

  // Install templates for the primary agent
  const { globalConfig } = resolveConfigDirs(targetRoot);
  await installAgentTemplates({
    projectRoot: targetRoot,
    agent: primaryAgent,
    globalConfigDir: primaryAgent === 'opencode' ? globalConfig : undefined,
  });
  log(`Skills updated for ${primaryAgent}.`);

  // Write MCP configs for ALL detected agents
  if (agents.includes('claude-code') || agents.includes('cursor')) {
    writeMcpJson(targetRoot);
  }
  if (agents.includes('opencode')) {
    writeOpencodeMcpJson(targetRoot);
  }

  log('Done.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('[install-pmc] FATAL:', err.message);
    process.exit(1);
  });
}
