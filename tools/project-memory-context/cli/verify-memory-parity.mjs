#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectMemoryProtocol } from '../src/memory-protocol.mjs';

const DEFAULT_WINDOW_MINUTES = 60;
const ENGRAM_VERSION_TIMEOUT_MS = 3000;
const ENGRAM_LIST_TIMEOUT_MS = 5000;

function log(message) {
  console.error(`[verify-memory-parity] ${message}`);
}

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolvePmcDbPath(installState) {
  const base = installState?.memoryDbPath;
  if (!base || typeof base !== 'string') return null;
  return base.endsWith('.db') ? base : `${base}.db`;
}

/**
 * Inspect the PMC SQLite DB: existence, mtime, size, and an approximate count
 * of memories written within the window. Uses node:sqlite for an exact count
 * when the schema is readable; falls back to file-mtime presence otherwise.
 *
 * @param {string|null} dbPath
 * @param {number} windowMs
 * @returns {Promise<{ reachable: boolean, mtime: string|null, sizeBytes: number|null, recentCount: number|null, note: string|null }>}
 */
async function inspectPmc(dbPath, windowMs) {
  if (!dbPath) {
    return { reachable: false, mtime: null, sizeBytes: null, recentCount: null, note: 'no memoryDbPath in install.json' };
  }

  let st;
  try {
    st = await stat(dbPath);
  } catch {
    return { reachable: false, mtime: null, sizeBytes: null, recentCount: null, note: 'PMC DB file not found' };
  }

  const result = {
    reachable: true,
    mtime: st.mtime.toISOString(),
    sizeBytes: st.size,
    recentCount: null,
    note: null,
  };

  // Exact recent count via node:sqlite (best-effort; never fatal).
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const cutoff = new Date(Date.now() - windowMs).toISOString();
      const row = db
        .prepare('SELECT COUNT(*) AS n FROM memories WHERE created_at >= ?')
        .get(cutoff);
      result.recentCount = Number.isFinite(row?.n) ? row.n : 0;
    } finally {
      try { db.close(); } catch { /* idempotent */ }
    }
  } catch (err) {
    result.note = `recent count unavailable (${err.message ?? err})`;
  }

  return result;
}

function spawnCapture(command, args, timeoutMs, deps = {}) {
  const spawnImpl = deps.spawn ?? spawn;
  return new Promise((resolvePromise) => {
    let settled = false;
    let stdout = '';
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };

    let child;
    try {
      child = spawnImpl(command, args, { shell: false });
    } catch {
      finish({ ok: false, stdout: '' });
      return;
    }

    const timer = setTimeout(() => {
      try { child?.kill?.(); } catch { /* best-effort */ }
      finish({ ok: false, stdout });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout?.on?.('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.once?.('error', () => {
      clearTimeout(timer);
      finish({ ok: false, stdout: '' });
    });
    child.once?.('exit', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, stdout });
    });
  });
}

/**
 * Probe Engram availability and (best-effort) count recent saves.
 *
 * @param {boolean} engramAvailable - from detectMemoryProtocol
 * @param {number} windowMinutes
 * @param {{ spawn?: Function }} [deps]
 * @returns {Promise<{ reachable: boolean, recentCount: number|null, note: string|null }>}
 */
async function inspectEngram(engramAvailable, windowMinutes, deps = {}) {
  if (!engramAvailable) {
    return { reachable: false, recentCount: null, note: 'engram CLI not on PATH' };
  }

  const version = await spawnCapture('engram', ['--version'], ENGRAM_VERSION_TIMEOUT_MS, deps);
  if (!version.ok) {
    return { reachable: false, recentCount: null, note: 'engram --version failed' };
  }

  // Attempt a recent-entries listing. Engram CLI surface varies; we treat any
  // non-zero exit or parse failure as "reachable but count unknown".
  const list = await spawnCapture(
    'engram',
    ['list-recent', '--since', `${windowMinutes}m`],
    ENGRAM_LIST_TIMEOUT_MS,
    deps,
  );
  if (!list.ok) {
    return { reachable: true, recentCount: null, note: 'engram list-recent unavailable; count unknown' };
  }

  const lines = list.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return { reachable: true, recentCount: lines.length, note: null };
}

function buildTable(rows) {
  const headers = ['Backend', 'Reachable', 'Recent saves', 'Detail'];
  const allRows = [headers, ...rows];
  const widths = headers.map((_, i) =>
    Math.max(...allRows.map((r) => String(r[i] ?? '').length)),
  );
  const renderRow = (r) =>
    r.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [renderRow(headers), sep, ...rows.map(renderRow)].join('\n');
}

export async function buildParityReport({ projectRoot, windowMinutes }, deps = {}) {
  const root = resolve(projectRoot);
  const windowMs = windowMinutes * 60 * 1000;

  const installState = await readJsonSafe(join(root, '.planning', 'project-memory-context', 'install.json'));
  const pmcDbPath = resolvePmcDbPath(installState);

  const detection = await detectMemoryProtocol({ projectRoot: root }, deps);

  const pmc = await inspectPmc(pmcDbPath, windowMs);
  const engram = await inspectEngram(detection.engramAvailable, windowMinutes, deps);

  // Parity logic:
  //   - engram unreachable -> expected pmc-only; parity OK (exit 0).
  //   - both reachable with known counts that diverge -> mismatch (exit 1).
  let parity = 'ok';
  let message = '';
  if (!engram.reachable) {
    parity = 'pmc-only';
    message = 'Engram unavailable — operating in pmc-only mode (expected).';
  } else if (
    typeof pmc.recentCount === 'number' &&
    typeof engram.recentCount === 'number' &&
    pmc.recentCount !== engram.recentCount
  ) {
    parity = 'mismatch';
    message = `Parity mismatch in last ${windowMinutes}m: PMC=${pmc.recentCount}, Engram=${engram.recentCount}.`;
  } else {
    parity = 'ok';
    message = `Parity OK in last ${windowMinutes}m.`;
  }

  return {
    ok: true,
    command: 'verify-memory-parity',
    projectRoot: root,
    windowMinutes,
    version: detection.version,
    parity,
    message,
    pmc: { dbPath: pmcDbPath, ...pmc },
    engram,
  };
}

function renderReport(report) {
  const rows = [
    [
      'PMC',
      report.pmc.reachable ? 'yes' : 'no',
      report.pmc.recentCount ?? '?',
      report.pmc.note ?? report.pmc.dbPath ?? '',
    ],
    [
      'Engram',
      report.engram.reachable ? 'yes' : 'no',
      report.engram.recentCount ?? '?',
      report.engram.note ?? '',
    ],
  ];

  const lines = [];
  lines.push('Memory Parity Report');
  lines.push('====================');
  lines.push(`  Project: ${report.projectRoot}`);
  lines.push(`  Window:  last ${report.windowMinutes} minutes`);
  lines.push(`  Version: ${report.version}`);
  lines.push('');
  lines.push(buildTable(rows));
  lines.push('');
  lines.push(`  ${report.message}`);
  return lines.join('\n');
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: pmc verify-memory-parity [project-dir] [--window-minutes N] [--json]');
    console.log('');
    console.log('Audits recent saves on both memory backends and reports parity.');
    console.log('');
    console.log('Options:');
    console.log(`  --window-minutes N   Lookback window in minutes (default ${DEFAULT_WINDOW_MINUTES})`);
    console.log('  --json               Print the report as JSON');
    console.log('');
    console.log('Exit codes: 0 = parity OK or Engram unavailable; 1 = parity mismatch.');
    return 0;
  }

  const json = args.includes('--json');
  let windowMinutes = DEFAULT_WINDOW_MINUTES;
  const winIndex = args.indexOf('--window-minutes');
  if (winIndex !== -1) {
    const parsed = Number.parseInt(args[winIndex + 1], 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      windowMinutes = parsed;
    } else {
      log(`Invalid --window-minutes value: "${args[winIndex + 1]}". Using default ${DEFAULT_WINDOW_MINUTES}.`);
    }
  }

  const projectArg = args.find(
    (a, i) => !a.startsWith('-') && args[i - 1] !== '--window-minutes',
  );
  const projectRoot = resolve(projectArg || process.cwd());

  const report = await buildParityReport({ projectRoot, windowMinutes });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderReport(report));
  }

  return report.parity === 'mismatch' ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main().catch((error) => {
    console.error('[verify-memory-parity] FATAL:', error.message);
    return 1;
  });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
