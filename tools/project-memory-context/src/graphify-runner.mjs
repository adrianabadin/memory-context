import { existsSync, readdirSync, copyFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { resolveGraphify, resolvePythonBin } from './platform.mjs';

const COPY_FILES = new Set(['graph.json', 'graph.metadata.json', 'graph.html', 'GRAPH_REPORT.md']);

/**
 * Run `graphify update <projectRoot>` incrementally (AST only, no LLM).
 * Copies relevant output files from `graphify-out/` to `.planning/project-memory-context/graph/`.
 *
 * @param {string} projectRoot - Absolute path to the project root.
 * @param {{ log?: (msg: string) => void, graphOutDir?: string }} options
 * @returns {Promise<{ ran: boolean, copied: string[] }>}
 *   `ran: false` when graphify is not installed (graceful degradation, no throw).
 */
export async function runGraphifyUpdate(projectRoot, options = {}) {
  const log = options.log ?? ((msg) => console.error(`[graphify-runner] ${msg}`));

  let graphifyExe;
  try {
    graphifyExe = resolveGraphify();
  } catch {
    log('graphify not found — skipping incremental graph update. Install with `pip install graphifyy` or set PMC_GRAPHIFY_PATH.');
    return { ran: false, copied: [] };
  }

  const graphifyOutDir = resolve(projectRoot, 'graphify-out');
  const graphDestDir = options.graphOutDir
    ?? resolve(projectRoot, '.planning', 'project-memory-context', 'graph');

  log(`Running graphify update (incremental AST)...`);
  log(`  Executable: ${graphifyExe}`);

  const result = spawnSync(graphifyExe, ['update', projectRoot], {
    cwd: projectRoot,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    log(`  graphify update exited with code ${result.status} — continuing without graph refresh.`);
    return { ran: false, copied: [] };
  }

  if (!existsSync(graphifyOutDir)) {
    log('  graphify-out directory not found after update — nothing to copy.');
    return { ran: true, copied: [] };
  }

  await mkdir(graphDestDir, { recursive: true });

  const copied = [];
  try {
    const files = readdirSync(graphifyOutDir);
    for (const f of files) {
      if (COPY_FILES.has(f)) {
        copyFileSync(resolve(graphifyOutDir, f), resolve(graphDestDir, f));
        copied.push(f);
      }
    }
  } catch (e) {
    log(`  Copy error: ${e.message}`);
  }

  if (copied.length > 0) {
    log(`  Copied to .planning: ${copied.join(', ')}`);
  }

  return { ran: true, copied };
}

/**
 * Install graphify Python package from the fork with Razor/CSHTML support.
 * Returns true on success, false on failure (non-throwing).
 *
 * @param {{ log?: (msg: string) => void }} options
 * @returns {boolean}
 */
export function installGraphify(options = {}) {
  const log = options.log ?? ((msg) => console.error(`[graphify-runner] ${msg}`));
  log('Installing graphify (Python)...');
  const pythonBin = resolvePythonBin();
  // Temporarily installing from fork until PR #1085 is merged into safishamsi/graphify
  const forkUrl = 'git+https://github.com/adrianabadin/graphify.git@feat/cshtml-mvc-razor-extraction';
  const r = spawnSync(pythonBin, ['-m', 'pip', 'install', forkUrl], { stdio: 'inherit' });
  if (r.status === 0) {
    log(`graphifyy (fork with Razor/CSHTML support) installed via ${pythonBin}`);
    return true;
  }
  log('WARNING: graphifyy install failed. Graphify step may not work.');
  return false;
}
