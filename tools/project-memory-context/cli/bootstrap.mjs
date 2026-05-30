#!/usr/bin/env node
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, constants, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { bootstrapProjectInstall } from '../src/setup-bootstrap.mjs';
import { spawnBackground } from '../src/platform.mjs';
import { runGraphifyUpdate, installGraphify } from '../src/graphify-runner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PMC_CLI_ROOT = resolve(__dirname);
const PMC_PACKAGE_ROOT = resolve(__dirname, '..');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-coder-v2:16b-ctx32k';
const PMC_CONCURRENCY = parseInt(process.env.PMC_CONCURRENCY || '8', 10);

function log(msg) { console.error(`[bootstrap] ${msg}`); }

export function buildDefaultEnrichmentConfig() {
  return {
    preferredModes: ['local-model', 'cloud-api', 'agent-subagent'],
    localModel: {
      provider: 'ollama',
      baseUrl: OLLAMA_URL,
      model: OLLAMA_MODEL,
    },
    cloudApi: {
      provider: 'openai-compatible',
      baseUrl: '',
      model: '',
      apiKeyEnv: 'PMC_CLOUD_API_KEY',
    },
    agentSubagent: {
      enabled: true,
      agentName: 'enrich',
    },
  };
}

export function mergeEnrichmentConfig(current = {}) {
  current = current ?? {};
  const source = current.enrichment ?? current;
  const defaults = buildDefaultEnrichmentConfig();
  return {
    ...defaults,
    ...source,
    preferredModes: source.preferredModes ?? defaults.preferredModes,
    localModel: {
      ...defaults.localModel,
      ...source.localModel,
    },
    cloudApi: {
      ...defaults.cloudApi,
      ...source.cloudApi,
    },
    agentSubagent: {
      ...defaults.agentSubagent,
      ...source.agentSubagent,
    },
  };
}

function getTargetDir(args) {
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') return null;
    if (!arg.startsWith('--')) return resolve(arg);
  }
  return process.cwd();
}

async function ensureDir(dir) {
  try { await access(dir, constants.F_OK); return true; }
  catch { return false; }
}

async function readJson(filePath) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); }
  catch { return null; }
}

async function runStageA(projectRoot) {
  log('Executing stage-a (graphify update)...');
  const { ran } = await runGraphifyUpdate(projectRoot, { log: (msg) => log(msg) });
  if (ran) {
    log('  Graphify update complete (AST only, no semantic LLM).');
    log('  For full semantic enrichment, set ANTHROPIC_API_KEY and run graphify extract.');
  } else {
    log('  Stage-a skipped or graphify unavailable. Stage-b and enrichment still work.');
  }
  return true;
}

function findFiles(dir, exts, ignore, projectRoot) {
  const results = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (ignore.some(i => full.includes(i))) continue;
      if (entry.isDirectory()) {
        results.push(...findFiles(full, exts, ignore, projectRoot));
      } else if (exts.some(e => entry.name.endsWith(e))) {
        results.push(full.replace(`${projectRoot}\\`, '').replace(`${projectRoot}/`, '').replace(/\\/g, '/'));
      }
    }
  } catch { /* skip inaccessible dirs */ }
  return results;
}

async function runStageB(projectRoot) {
  log('Running stage-b (build-worklist)...');

  const ignore = ['node_modules', 'dist', '.git', 'bin', 'obj', '.opencode', '.planning', '.next'];
  const files = [
    ...findFiles(projectRoot, ['.ts', '.mjs', '.js'], ignore, projectRoot),
    ...findFiles(projectRoot, ['.cs'], ignore, projectRoot),
  ];

  log(`  Found ${files.filter(f => f.endsWith('.cs')).length} CS files, ${files.filter(f => !f.endsWith('.cs')).length} TS/JS files`);

  if (files.length === 0) {
    log('No files to process. Skipping stage-b.');
    return true;
  }

  const worklistScript = resolve(PMC_CLI_ROOT, 'build-worklist.mjs');
  const r = spawnSync(process.execPath, [worklistScript, ...files], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, PMC_CONCURRENCY: String(PMC_CONCURRENCY) },
  });

  if (r.status !== 0) {
    const altWorklistScript = resolve(projectRoot, 'tools', 'project-memory-context', 'cli', 'build-worklist.mjs');
    log(`  Primary worklist failed, trying local: ${altWorklistScript}`);
    const r2 = spawnSync(process.execPath, [altWorklistScript, ...files], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env, PMC_CONCURRENCY: String(PMC_CONCURRENCY) },
    });
    if (r2.status !== 0) {
      log(`Stage-b failed with code ${r2.status}`);
      return false;
    }
  }

  log('Stage-b complete.');
  return true;
}

function printUsage() {
  console.log(`
map-project - Portable PMC bootstrap for any repo

Usage:
  pmc map-project [target-repo] [--stage-a] [--stage-b] [--all] [--enrich]

Arguments:
  target-repo          Path to the target repository (default: current dir)

Options:
  --stage-a            Run intake + graphify after setup
  --stage-b            Run symbol extraction + worklist after setup
  --all                Run both stages after setup (default: setup only)
  --enrich             Also start the enrichment queue in background after setup
  --help, -h           Show this help

Environment variables:
  OLLAMA_URL           Ollama URL (default: http://localhost:11434)
  OLLAMA_MODEL         Ollama model (default: deepseek-coder-v2:16b-ctx32k)
  PMC_CONCURRENCY      Parallel slots (default: 8)
  PMC_GRAPHIFY_PATH    Custom path to graphify executable

Example:
  pmc map-project /path/to/my-repo --all
  pmc map-project /path/to/my-repo --all --enrich
  OLLAMA_MODEL=qwen3-coder:30b pmc map-project . --stage-b --enrich
`);
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return 0;
  }

  const targetDir = getTargetDir(args);
  if (!targetDir) { printUsage(); return 0; }

  const runStageAFlag = args.includes('--stage-a') || args.includes('--all');
  const runStageBFlag = args.includes('--stage-b') || args.includes('--all');
  const runEnrichFlag = args.includes('--enrich');

  log(`Target repo: ${targetDir}`);
  log(`PMC package root: ${PMC_PACKAGE_ROOT}`);
  log(`Ollama: ${OLLAMA_URL} | Model: ${OLLAMA_MODEL}`);

  if (!await ensureDir(targetDir)) {
    console.error(`[bootstrap] ERROR: Directory not found: ${targetDir}`);
    return 1;
  }

  log('Installing graphify...');
  installGraphify({ log: (msg) => log(msg) });

  log('Running portable project install...');
  const { configPath } = await bootstrapProjectInstall({
    projectRoot: targetDir,
    packageRoot: PMC_PACKAGE_ROOT,
    ollamaBaseUrl: OLLAMA_URL,
    ollamaModel: OLLAMA_MODEL,
  });

  log('Generating project context artifacts...');
  const projectContextScript = resolve(PMC_CLI_ROOT, 'project-context.mjs');
  const contextResult = spawnSync(process.execPath, [projectContextScript, targetDir], {
    cwd: targetDir,
    stdio: 'inherit',
    env: { ...process.env },
  });
  if (contextResult.status !== 0) {
    log(`WARNING: project-context generation failed with code ${contextResult.status}`);
  }

  log('');
  log('========================================');
  log('PMC installed successfully!');
  log(`  Target: ${targetDir}`);
  log(`  Config: ${configPath}`);
  log('========================================');
  log('');

  if (runStageAFlag) {
    log('Executing stage-a...');
    await runStageA(targetDir);
  }

  if (runStageBFlag) {
    log('Executing stage-b...');
    const ok = await runStageB(targetDir);
    if (!ok) log('WARNING: stage-b had issues. Check output above.');
  }

  if (runEnrichFlag && (runStageAFlag || runStageBFlag)) {
    log('Starting background enrichment queue...');
    const enrichScript = resolve(PMC_CLI_ROOT, 'enrich-queue.mjs');
    spawnBackground(process.execPath, [enrichScript], { cwd: targetDir });
    log('  Enrichment running in background.');
  } else if (!runStageAFlag && !runStageBFlag) {
    log('Run enrichment with:');
    log(`  cd ${targetDir}`);
    log('  pmc enrich .');
  }

  log('Done.');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main().catch((err) => {
    console.error('[bootstrap] FATAL:', err.message);
    return 1;
  });
  if (exitCode !== 0) process.exit(exitCode);
}
