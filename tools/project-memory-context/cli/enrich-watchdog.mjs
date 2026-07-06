#!/usr/bin/env node
/**
 * enrich-watchdog — detached background process.
 *
 * Spawned by `pmc session-start` when enrichment is needed.
 * Polls enrichment state and relaunches enrich-queue if it stalls or crashes.
 * Logs to `.planning/project-memory-context/enrichment/watchdog.log`.
 * Exits when enrichment completes or max relaunches are reached.
 *
 * Usage: node enrich-watchdog.mjs [project-root]
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildStatusReport } from './status.mjs';
import { spawnBackground } from '../src/platform.mjs';
import { isPidAlive } from '../src/watcher-lifecycle.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENRICH_SCRIPT = join(__dirname, 'enrich-queue.mjs');

const POLL_INTERVAL_MS = 30_000;   // 30 s — fast enough to catch crashes
const MAX_RELAUNCHES = 3;

// Conservative staleness window: a watchdog heartbeat older than this means
// the previous watchdog is presumed dead and a new one may start.
export const WATCHDOG_GUARD_STALE_MS = 5 * 60 * 1000;

/**
 * Returns true if this process should skip starting because another live
 * watchdog instance is already running for the same project.
 *
 * Pure and testable — all side-effecting inputs are injected.
 *
 * @param {object|null} watchdogState  Parsed watchdog-state.json, or null.
 * @param {{ now?: number, selfPid?: number, isPidAlive?: (pid: number) => boolean }} opts
 */
export function shouldSkipWatchdogStart(watchdogState, { now = Date.now(), selfPid = process.pid, isPidAlive: pidAlive = isPidAlive } = {}) {
  if (!watchdogState || watchdogState.status !== 'running') return false;
  if (watchdogState.pid === selfPid) return false;
  if (!pidAlive(watchdogState.pid)) return false;
  const heartbeatMs = Date.parse(watchdogState.heartbeatAt ?? '');
  if (!Number.isFinite(heartbeatMs)) return false;
  return now - heartbeatMs <= WATCHDOG_GUARD_STALE_MS;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function appendLog(logPath, message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    await appendFile(logPath, line, 'utf8');
  } catch {
    // If we can't log, don't crash the watchdog
  }
}

async function writeWatchdogState(stateFile, data) {
  try {
    await writeFile(stateFile, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`[watchdog] Failed to write state file: ${err.message}`);
  }
}

async function main() {
  const projectRoot = resolve(process.argv[2] ?? process.cwd());
  const logDir = join(projectRoot, '.planning', 'project-memory-context', 'enrichment');
  const logPath = join(logDir, 'watchdog.log');
  const stateFile = join(logDir, 'watchdog-state.json');

  // Ensure log directory exists (don't use ensureProjectMemoryContextDirs to avoid heavy imports)
  try {
    await mkdir(logDir, { recursive: true });
  } catch {}

  // Single-instance guard: check if another watchdog is already running
  let existingState = null;
  try {
    existingState = JSON.parse(await readFile(stateFile, 'utf8'));
  } catch {}

  if (shouldSkipWatchdogStart(existingState)) {
    console.error(`[watchdog] Another watchdog is already running (pid ${existingState.pid}); exiting.`);
    return;
  }

  // Write initial running state
  const startedAt = new Date().toISOString();
  await writeWatchdogState(stateFile, {
    status: 'running',
    pid: process.pid,
    startedAt,
    heartbeatAt: startedAt,
  });

  await appendLog(logPath, `watchdog started pid=${process.pid}`);

  let relaunches = 0;

  while (true) {
    await sleep(POLL_INTERVAL_MS);

    // Refresh heartbeat on each poll iteration
    await writeWatchdogState(stateFile, {
      status: 'running',
      pid: process.pid,
      startedAt,
      heartbeatAt: new Date().toISOString(),
    });

    let status;
    try {
      status = await buildStatusReport({ projectRoot });
    } catch (err) {
      await appendLog(logPath, `status check error: ${err.message}`);
      continue;
    }

    const pending = status.worklist?.pending ?? 0;
    const state = status.state;

    await appendLog(logPath, `state=${state} pending=${pending} relaunches=${relaunches}`);

    // Clean exit: enrichment finished and nothing left to do
    if ((state === 'finished' || state === 'idle') && pending === 0) {
      await appendLog(logPath, 'enrichment complete — watchdog exiting');
      break;
    }

    // Crashed / stalled / finished but still has pending work → relaunch
    if ((state === 'stalled' || state === 'failed' || state === 'finished') && pending > 0) {
      if (relaunches >= MAX_RELAUNCHES) {
        await appendLog(logPath, `max relaunches (${MAX_RELAUNCHES}) reached — giving up`);
        break;
      }
      relaunches++;
      await appendLog(logPath, `relaunching enrich (attempt ${relaunches}/${MAX_RELAUNCHES})`);
      spawnBackground(process.execPath, [ENRICH_SCRIPT, projectRoot], { cwd: projectRoot });
    }
    // state === 'running' → alive, keep polling
  }

  // Write finished state on clean exit
  await writeWatchdogState(stateFile, {
    status: 'finished',
    pid: process.pid,
    startedAt,
    heartbeatAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
}

// Entrypoint guard: importing this module (tests) must NOT start the watchdog.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (err) => {
    const projectRoot = resolve(process.argv[2] ?? process.cwd());
    const logDir = join(projectRoot, '.planning', 'project-memory-context', 'enrichment');
    const logPath = join(logDir, 'watchdog.log');
    const stateFile = join(logDir, 'watchdog-state.json');
    try {
      await appendFile(logPath, `[${new Date().toISOString()}] FATAL: ${err.message}\n`, 'utf8');
    } catch {}
    try {
      await writeFile(stateFile, JSON.stringify({
        status: 'failed',
        pid: process.pid,
        finishedAt: new Date().toISOString(),
        lastError: err.message,
      }, null, 2), 'utf8');
    } catch {}
  });
}
