#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { bootstrapProjectInstall } from '../src/setup-bootstrap.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { detectSetupAgentType, resolveConfigDirs, resolvePythonBin } from '../src/platform.mjs';
import { installAgentTemplates } from '../src/template-installer.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const AGENT_FLAGS = {
  '--antigravity': 'antigravity',
  '--opencode': 'opencode',
  '--claude': 'claude-code',
  '--cursor': 'cursor',
  '--generic': 'generic',
};

function installGraphify() {
  const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  for (const command of candidates) {
    // Temporarily installing from fork until PR #1085 is merged into safishamsi/graphify
    const forkUrl = 'git+https://github.com/adrianabadin/graphify.git@feat/cshtml-mvc-razor-extraction';
    const result = spawnSync(command, ['-m', 'pip', 'install', forkUrl], { stdio: 'inherit' });
    if (result.status === 0) return command;
  }
  console.warn(`\n⚠  Could not install graphifyy automatically.`);
  console.warn(`   Python not found? Download it from: https://www.python.org/downloads/`);
  console.warn(`   Then run manually:`);
  console.warn(`   pip install git+https://github.com/adrianabadin/graphify.git@feat/cshtml-mvc-razor-extraction\n`);
  return null;
}

function spawnCheck(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf-8', timeout: 5000 });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function parseArgs(args) {
  const agents = [];
  for (const arg of args) {
    if (AGENT_FLAGS[arg]) {
      agents.push(AGENT_FLAGS[arg]);
    }
  }
  return { agents };
}

const rl = createInterface({ input, output });
const cwd = resolve(process.cwd());

try {
  console.log('\n─── pmc setup ───────────────────────────────────────\n');
  const { agents: requestedAgents } = parseArgs(process.argv.slice(2));

  let agents;
  if (requestedAgents.length > 0) {
    agents = [...new Set(requestedAgents)];
    console.log(`  Target agents: ${agents.join(', ')}`);
  } else {
    const detected = detectSetupAgentType(cwd);
    agents = [detected];
    console.log(`  Auto-detected agent: ${detected}`);
  }

  const ollamaBaseUrl =
    (await rl.question('Ollama base URL [http://localhost:11434]: ')).trim() ||
    'http://localhost:11434';

  const ollamaModel =
    (await rl.question('Ollama model name [deepseek-coder-v2:16b-ctx16k]: ')).trim() ||
    'deepseek-coder-v2:16b-ctx16k';

  installGraphify();

  const { globalConfig } = resolveConfigDirs(cwd);

  const agentGlobalConfigDirs = {
    'opencode': globalConfig,
    'claude-code': join(homedir(), '.claude'),
    'antigravity': join(homedir(), '.gemini', 'config'),
  };

  const result = await bootstrapProjectInstall({
    projectRoot: cwd,
    packageRoot,
    ollamaBaseUrl,
    ollamaModel,
    agents,
  });

  for (const agent of agents) {
    await installAgentTemplates({
      projectRoot: cwd,
      agent,
      packageRoot,
      globalConfigDir: agentGlobalConfigDirs[agent],
    });
    console.log(`  ✓ Installed ${agent} templates.`);
  }

  console.log('\n─── Installation complete ───────────────────────────\n');
  console.log(`  Memory DB path:     ${result.installState.memoryDbPath}`);
  console.log(`  Embedding cache:    ${result.installState.embeddingCachePath}`);
  console.log(`  MCP config:         ${result.configPath}`);
  console.log(`  Command template:   ${result.commandPath}`);
  console.log(`  Agents configured:  ${agents.join(', ')}`);

  console.log('\n─── Environment check ───────────────────────────────\n');
  const env = {
    ...process.env,
    MEMORY_DB_PATH: result.installState.memoryDbPath,
    EMBEDDING_CACHE_PATH: result.installState.embeddingCachePath,
  };
  const { checks } = await runDoctor({ env, resolvePythonBin, spawnCheck });

  const icon = { ok: '✓', warn: '⚠', fail: '✗' };
  for (const c of checks) {
    console.log(`  ${icon[c.status]}  ${c.name.padEnd(22)} ${c.message}`);
  }

  const hasFail = checks.some(c => c.status === 'fail');
  if (hasFail) {
    console.log('\nFix the issues above and re-run `pmc setup` if needed.\n');
  } else {
    console.log('\nAll checks passed. Run `pmc enrich` to start enriching the project.\n');
  }
} finally {
  rl.close();
}
