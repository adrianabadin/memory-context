#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { bootstrapProjectInstall } from '../src/setup-bootstrap.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { detectSetupAgentType, resolveConfigDirs, resolvePythonBin } from '../src/platform.mjs';
import { runPipeline } from '../src/clients/pipeline.mjs';
import { formatInstallReport } from '../src/clients/report.mjs';
import { selectClients } from '../src/clients/detect.mjs';
import { CLIENT_REGISTRY } from '../src/clients/registry.mjs';
import { PROBE_TABLE } from '../src/clients/probes.mjs';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

export const AGENT_FLAGS = {
  '--antigravity': 'antigravity',
  '--opencode': 'opencode',
  '--claude': 'claude-code',
  '--cursor': 'cursor',
  '--generic': 'generic',
};

export const CLIENT_FLAG_TO_ID = {
  '--codex': 'codex',
  '--kimi': 'kimi',
  '--qwen': 'qwen',
  ...AGENT_FLAGS,
};

export function parseArgs(args) {
  const flagIds = [];
  for (const arg of args) {
    if (CLIENT_FLAG_TO_ID[arg]) flagIds.push(CLIENT_FLAG_TO_ID[arg]);
  }
  return { agents: [...new Set(flagIds)] };
}

export function installGraphify() {
  const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  for (const command of candidates) {
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

async function readTemplate(pkgRoot, tplPath) {
  return readFile(join(pkgRoot, 'templates', tplPath), 'utf8');
}

export async function runSetupPipeline({
  cwd,
  packageRoot,
  requestedAgents = [],
  homeDir,
  consent = { dependencies: false },
} = {}) {
  const detection = selectClients({
    projectRoot: cwd,
    registry: CLIENT_REGISTRY,
    exists: existsSync,
    flags: requestedAgents.map((a) => {
      for (const [flag, id] of Object.entries(CLIENT_FLAG_TO_ID)) {
        if (id === a) return flag;
      }
      return null;
    }).filter(Boolean),
    csvClients: requestedAgents,
    homeDir,
  });

  const placeholders = {
    PMC_BIN: 'pmc',
    AGENT_MEMORY_CMD: 'npx -y @aabadin/agent-memory-mcp',
    PROJECT_ROOT: cwd,
    CONFIG_DIR: '.pmc',
  };

  const { report } = await runPipeline({
    projectRoot: cwd,
    homeDir: homeDir ?? cwd,
    packageRoot,
    registry: CLIENT_REGISTRY,
    probeTable: PROBE_TABLE,
    placeholders,
    readTemplate,
    selectedIds: detection.clientIds,
    consent,
  });
  return { report, detection };
}

export const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// Wrap in a guard so importing this module from tests does NOT execute prompts.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

export async function runSetupInteractive({ packageRoot: pkg = packageRoot } = {}) {
  const rl = createInterface({ input, output });
  const cwd = resolve(process.cwd());

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

  const result = await bootstrapProjectInstall({
    projectRoot: cwd,
    packageRoot: pkg,
    ollamaBaseUrl,
    ollamaModel,
    agents,
  });

  const { report } = await runSetupPipeline({
    cwd,
    packageRoot: pkg,
    requestedAgents: agents,
  });

  console.log(`\n${formatInstallReport(report)}\n`);
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

  const hasFail = checks.some((c) => c.status === 'fail');
  if (hasFail) {
    console.log('\nFix the issues above and re-run `pmc setup` if needed.\n');
  } else {
    console.log('\nAll checks passed. Run `pmc enrich` to start enriching the project.\n');
  }
  rl.close();
  return { result, report };
}

if (isMain) {
  runSetupInteractive().catch((err) => {
    console.error('[setup] FATAL:', err.message);
    process.exit(1);
  });
}
