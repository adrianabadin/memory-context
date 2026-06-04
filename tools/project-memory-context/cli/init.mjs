#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { resolveConfigDirs } from '../src/platform.mjs';
import { detectAgentType, installAgentTemplates } from '../src/template-installer.mjs';

function parseArgs(args) {
  const result = { agent: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent' && args[i + 1]) {
      result.agent = args[++i];
    }
  }
  return result;
}

function printHelp() {
  console.log(`Usage: pmc init-project [--agent opencode|claude-code|cursor|generic]

Options:
  --agent <type>   Agent type to initialize. Auto-detected if omitted.

Supported agents:
  opencode         OpenCode (commands + agents + AGENTS.md autostart)
  claude-code      Claude Code (CLAUDE.md instructions)
  cursor           Cursor (.cursorrules instructions)
  generic          Generic CLI-only (README-SETUP.md)`);
}

async function tryRegisterProject(projectRoot) {
  const mcpPath = resolve(projectRoot, '.mcp.json');
  let serverConfig;
  try {
    const raw = JSON.parse(await readFile(mcpPath, 'utf8'));
    serverConfig = raw?.mcpServers?.['agent-memory'];
  } catch {
    return; // No .mcp.json — skip global registration silently
  }
  if (!serverConfig) return;

  const client = new Client({ name: 'pmc-init', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: serverConfig.command,
    args: serverConfig.args ?? [],
    env: { ...process.env, ...serverConfig.env },
  });

  try {
    await client.connect(transport);
    await client.callTool({
      name: 'register_project',
      arguments: {
        name: basename(projectRoot),
        rootPath: projectRoot,
      },
    });
    console.error(`[pmc:init] Registered project in global context store`);
  } catch (err) {
    console.error(`[pmc:init] Global context registration skipped: ${err.message}`);
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const projectRoot = resolve(process.cwd());
  const { agent: requestedAgent } = parseArgs(args);
  const agent = requestedAgent || detectAgentType(projectRoot);

  if (requestedAgent === null) {
    console.error(`[pmc:init] Auto-detected agent: ${agent}`);
  }

  const { globalConfig } = resolveConfigDirs(projectRoot);

  await installAgentTemplates({
    projectRoot,
    agent,
    globalConfigDir: agent === 'opencode' ? globalConfig : undefined,
  });

  console.error(`[pmc:init] Installed PMC templates for ${agent}`);
  await tryRegisterProject(projectRoot);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main().catch((error) => {
    console.error('[pmc:init] FATAL:', error.message);
    return 1;
  });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
