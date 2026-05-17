#!/usr/bin/env node
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readFile, access, constants } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PMC_CLI_ROOT = resolve(__dirname);
const PMC_ROOT = resolve(__dirname, '..', '..', '..');
const PMC_TEMPLATES = resolve(PMC_ROOT, 'tools', 'project-memory-context', 'templates');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-coder-v2:16b-ctx32k';
const PMC_CONCURRENCY = parseInt(process.env.PMC_CONCURRENCY || '8', 10);

function log(msg) { console.error(`[new-project] ${msg}`); }

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

async function copyTemplate(src, dst, packageRoot) {
  const content = await readFile(src, 'utf8');
  const rendered = content.replaceAll('__PMC_PACKAGE_ROOT__', packageRoot.replace(/\\/g, '\\\\'));
  await mkdir(dirname(dst), { recursive: true });
  await writeFile(dst, rendered, 'utf8');
}

async function readJson(filePath) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); }
  catch { return null; }
}

async function registerPlugin(projectRoot) {
  const configPath = resolve(projectRoot, '.opencode', 'opencode.json');
  const config = await readJson(configPath) ?? { $schema: 'https://opencode.ai/config.json' };
  const existing = Array.isArray(config.plugin) ? config.plugin : [];
  if (!existing.includes('opencode-project-memory-context')) {
    config.plugin = [...existing, 'opencode-project-memory-context'];
  }

  config.mcp = config.mcp ?? {};
  config.mcp['agent-memory'] = {
    type: 'local',
    command: ['agent-memory-mcp'],
    environment: {
      MEMORY_DB_PATH: './.planning/db'
    }
  };

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return configPath;
}

async function installGraphify() {
  log('Installing graphify (Python)...');
  const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ['-m', 'pip', 'install', 'graphifyy'], { stdio: 'inherit' });
    if (r.status === 0) { log(`graphifyy installed via ${cmd}`); return true; }
  }
  log('WARNING: graphifyy install failed. Graphify step may not work.');
  return false;
}

async function syncToolsToTarget(projectRoot) {
  log('Copying PMC tools to target repo...');
  const { readdirSync, mkdirSync, copyFileSync, existsSync } = await import('node:fs');
  const srcCli = resolve(PMC_ROOT, 'tools', 'project-memory-context', 'cli');
  const dstCli = resolve(projectRoot, 'tools', 'project-memory-context', 'cli');

  mkdirSync(resolve(projectRoot, 'tools', 'project-memory-context'), { recursive: true });
  mkdirSync(dstCli, { recursive: true });

  const files = ['new-project.mjs', 'enrich-queue.mjs', 'build-worklist.mjs'];
  for (const f of files) {
    copyFileSync(resolve(srcCli, f), resolve(dstCli, f));
    log(`  copied ${f}`);
  }

  const srcSrc = resolve(PMC_ROOT, 'tools', 'project-memory-context', 'src');
  const dstSrc = resolve(projectRoot, 'tools', 'project-memory-context', 'src');
  mkdirSync(dstSrc, { recursive: true });

  try {
    const srcFiles = readdirSync(srcSrc);
    for (const f of srcFiles) {
      if (f.endsWith('.mjs')) {
        copyFileSync(resolve(srcSrc, f), resolve(dstSrc, f));
        log(`  copied src/${f}`);
      }
    }
  } catch { log('  src/ copy skipped (may not exist)'); }

  log('  PMC tools synced to target repo.');
}

async function ensureDirs(base) {
  for (const sub of ['intake', 'graph', 'enrichment', 'memory-db', 'db']) {
    await mkdir(resolve(base, sub), { recursive: true });
  }
}

async function writeInstallState(base) {
  const installState = {
    packageRoot: PMC_ROOT,
    ollamaUrl: OLLAMA_URL,
    ollamaModel: OLLAMA_MODEL,
    concurrency: PMC_CONCURRENCY,
    installedAt: new Date().toISOString(),
  };
  await writeFile(
    resolve(base, 'install.json'),
    `${JSON.stringify(installState, null, 2)}\n`,
    'utf8'
  );
}

function getGraphifyExe() {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || resolve(process.env.APPDATA || '', '..', 'Local');
    return resolve(localAppData, 'Programs', 'Python', 'Python313', 'Scripts', 'graphify.exe');
  }
  return 'graphify';
}

async function runStageA(projectRoot) {
  log('Running graphify update (structural AST analysis, no LLM)...');
  const graphifyExe = getGraphifyExe();
  const graphOutDir = resolve(projectRoot, '.planning', 'project-memory-context', 'graph');
  const graphifyOutDir = resolve(projectRoot, 'graphify-out');

  const cmdStr = `"${graphifyExe}" update "${projectRoot}"`;
  const r = spawnSync(cmdStr, [], {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: true
  });

  if (r.status === 0) {
    log('  Graph extraction complete. Copying to .planning...');
    try {
      const { readdirSync, copyFileSync, existsSync } = await import('node:fs');
      if (!existsSync(graphifyOutDir)) { log('  graphify-out not found'); return false; }
      const files = readdirSync(graphifyOutDir);
      for (const f of files) {
        if (f === 'graph.json' || f === 'graph.metadata.json' || f === 'graph.html' || f === 'GRAPH_REPORT.md') {
          copyFileSync(resolve(graphifyOutDir, f), resolve(graphOutDir, f));
          log(`    copied ${f}`);
        }
      }
    } catch (e) { log(`  Copy error: ${e.message}`); }
    log('  Graphify update complete (AST only, no semantic LLM).');
    log('  For full semantic enrichment, set ANTHROPIC_API_KEY and run graphify extract.');
  } else {
    log(`  Graphify update failed with code ${r.status}. Stage-b and enrichment still work.`);
  }

  return true;
}

async function runStageB(projectRoot) {
  log('Running stage-b (build-worklist)...');

  const { readdirSync } = await import('node:fs');
  const { join, relative } = await import('node:path');

  function findFiles(dir, exts, ignore) {
    const results = [];
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (ignore.some(i => full.includes(i))) continue;
        if (entry.isDirectory()) {
          results.push(...findFiles(full, exts, ignore));
        } else if (exts.some(e => entry.name.endsWith(e))) {
          results.push(relative(projectRoot, full).replace(/\\/g, '/'));
        }
      }
    } catch { /* skip inaccessible dirs */ }
    return results;
  }

  const files = [...findFiles(projectRoot, ['.ts', '.mjs', '.js'], ['node_modules', 'dist', '.git', 'bin', 'obj', '.opencode', '.planning']),
                 ...findFiles(projectRoot, ['.cs'], ['node_modules', 'dist', '.git', 'bin', 'obj', '.opencode', '.planning'])];

  log(`  Found ${files.filter(f => f.endsWith('.cs')).length} CS files, ${files.filter(f => !f.endsWith('.cs')).length} TS/JS files`);

  if (files.length === 0) {
    log('No files to process. Skipping stage-b.');
    return true;
  }

  const worklistScript = resolve(PMC_CLI_ROOT, 'build-worklist.mjs');
  const r = spawnSync('node', [worklistScript, ...files], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, PMC_CONCURRENCY: String(PMC_CONCURRENCY) }
  });

  if (r.status !== 0) {
    const altWorklistScript = resolve(targetDir, 'tools', 'project-memory-context', 'cli', 'build-worklist.mjs');
    log(`  Primary worklist failed, trying local: ${altWorklistScript}`);
    const r2 = spawnSync('node', [altWorklistScript, ...files], {
      cwd: projectRoot,
      stdio: 'inherit',
      env: { ...process.env, PMC_CONCURRENCY: String(PMC_CONCURRENCY) }
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
new-project - Bootstrap project-memory-context in any repo

Usage:
  node new-project.mjs <target-repo> [--stage-a] [--stage-b] [--all] [--enrich]

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

Example:
  node new-project.mjs /path/to/my-repo --all
  node new-project.mjs /path/to/my-repo --all --enrich
  OLLAMA_MODEL=qwen3-coder:30b node new-project.mjs . --stage-b --enrich
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const targetDir = getTargetDir(args);
  if (!targetDir) { printUsage(); process.exit(0); }

  const runStageAFlag = args.includes('--stage-a') || args.includes('--all');
  const runStageBFlag = args.includes('--stage-b') || args.includes('--all');
  const runEnrichFlag = args.includes('--enrich');

  log(`Target repo: ${targetDir}`);
  log(`PMC package root: ${PMC_ROOT}`);
  log(`Ollama: ${OLLAMA_URL} | Model: ${OLLAMA_MODEL}`);

  if (!await ensureDir(targetDir)) {
    console.error(`[new-project] ERROR: Directory not found: ${targetDir}`);
    process.exit(1);
  }

  log('Installing graphify...');
  await installGraphify();

  log('Creating PMC directory structure...');
  const base = resolve(targetDir, '.planning', 'project-memory-context');
  await ensureDirs(base);

  log('Copying command templates...');
  await copyTemplate(
    resolve(PMC_TEMPLATES, 'project-memory-context.md'),
    resolve(targetDir, 'project-memory-context.md'),
    PMC_ROOT
  );
  await copyTemplate(
    resolve(PMC_TEMPLATES, 'project-memory-context workflow.md'),
    resolve(targetDir, 'project-memory-context workflow.md'),
    PMC_ROOT
  );

  log('Registering opencode plugin...');
  const configPath = await registerPlugin(targetDir);
  log(`  Plugin registered in: ${configPath}`);

  log('Writing install state...');
  await writeInstallState(base);

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
    log('Syncing PMC tools to target repo...');
    await syncToolsToTarget(targetDir);
    log('Starting background enrichment queue...');
    spawnSync(
      'start',
      ['/B', 'cmd', '/c', `cd /d "${targetDir}" && node tools/project-memory-context/cli/enrich-queue.mjs`],
      { cwd: targetDir, stdio: 'ignore', shell: true }
    );
    log('  Enrichment running in background. Check progress with:');
    log(`  node -e "const w=JSON.parse(require('fs').readFileSync('.planning/project-memory-context/enrichment/worklist.json','utf8')); const p=w.filter(s=>s.status==='pending').length; const e=w.filter(s=>s.status==='enriched').length; console.log('enriched='+e+' pending='+p)"`);
  } else if (!runStageAFlag && !runStageBFlag) {
    log('Run enrichment with:');
    log(`  cd ${targetDir}`);
    log(`  node tools/project-memory-context/cli/enrich-queue.mjs`);
  }

  log('Done.');
}

main().catch(err => {
  console.error('[new-project] FATAL:', err.message);
  process.exit(1);
});