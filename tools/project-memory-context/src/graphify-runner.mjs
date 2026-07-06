import { existsSync, readdirSync, copyFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { resolveGraphify, resolvePythonBin } from './platform.mjs';

const COPY_FILES = new Set(['graph.json', 'graph.metadata.json', 'graph.html', 'GRAPH_REPORT.md']);

/**
 * Default timeout (ms) for a single graphify update run.
 * Chosen generously so a healthy run on a large repo can complete,
 * but small enough that a stuck graphify does not block the agent.
 */
export const DEFAULT_GRAPHIFY_TIMEOUT_MS = 60_000;

/**
 * Terminate the child process and (on Windows) its descendants.
 * Best-effort — never throws.
 *
 * @param {import('node:child_process').ChildProcess | undefined} child
 * @returns {Promise<void>}
 */
export async function killProcessTree(child) {
  const pid = child?.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    // Best-effort: signal the immediate child first (fast path that the
    // test can observe), then escalate to taskkill to terminate the
    // full process tree (children, console host, etc.).
    try { child.kill(); } catch { /* ignore */ }
    await new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve());
    });
    return;
  }
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }, 500).unref?.();
}

/**
 * Run `graphify update <projectRoot>` incrementally (AST only, no LLM).
 * Copies relevant output files from `graphify-out/` to `.planning/project-memory-context/graph/`.
 *
 * Always returns a Promise. On hang it returns within `timeoutMs` and the
 * child process tree is terminated; the caller is never blocked indefinitely.
 *
 * @param {string} projectRoot - Absolute path to the project root.
 * @param {{
 *   log?: (msg: string) => void,
 *   graphOutDir?: string,
 *   spawnImpl?: typeof import('node:child_process').spawn,
 *   resolveGraphifyFn?: () => string,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<{ ran: boolean, copied: string[], timedOut?: boolean }>}
 *   `ran: false` when graphify is not installed, exits non-zero, or times out.
 */
export async function runGraphifyUpdate(projectRoot, options = {}) {
  const log = options.log ?? ((msg) => console.error(`[graphify-runner] ${msg}`));
  const spawnImpl = options.spawnImpl ?? spawn;
  const resolveGraphifyFn = options.resolveGraphifyFn ?? resolveGraphify;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GRAPHIFY_TIMEOUT_MS;

  let graphifyExe;
  try {
    graphifyExe = resolveGraphifyFn();
  } catch {
    log('graphify not found — skipping incremental graph update. Install with `pip install graphifyy` or set PMC_GRAPHIFY_PATH.');
    return { ran: false, copied: [] };
  }

  const graphifyOutDir = resolve(projectRoot, 'graphify-out');
  const graphDestDir = options.graphOutDir
    ?? resolve(projectRoot, '.planning', 'project-memory-context', 'graph');

  log(`Running graphify update (incremental AST)...`);
  log(`  Executable: ${graphifyExe}`);

  const child = spawnImpl(graphifyExe, ['update', projectRoot], {
    cwd: projectRoot,
    stdio: 'inherit',
  });

  const exit = await waitForChild(child, { timeoutMs, log });

  if (exit.timedOut) {
    log(`  graphify update timed out after ${timeoutMs}ms — continuing without graph refresh.`);
    return { ran: false, copied: [], timedOut: true };
  }

  if (exit.code !== 0) {
    log(`  graphify update exited with code ${exit.code} — continuing without graph refresh.`);
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
 * Resolve the child process to a final outcome.
 * - On 'close' or 'error' returns { code } (1 for spawn-time errors).
 * - On timeout, kills the process tree and returns { timedOut: true }.
 * Always settles; never hangs.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {{ timeoutMs: number, log: (msg: string) => void }} cfg
 * @returns {Promise<{ code: number | null, timedOut?: boolean }>}
 */
function waitForChild(child, { timeoutMs, log }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve(value);
    };

    child.once('error', (err) => {
      log(`  graphify spawn error: ${err.message}`);
      finish({ code: 1 });
    });
    child.once('close', (code) => finish({ code: code ?? 0 }));

    let timeoutHandle = null;
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        log(`  graphify update exceeded ${timeoutMs}ms — killing process tree.`);
        killProcessTree(child)
          .catch(() => { /* best-effort */ })
          .finally(() => finish({ code: null, timedOut: true }));
      }, timeoutMs);
      if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
    }
  });
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
