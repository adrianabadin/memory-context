#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
