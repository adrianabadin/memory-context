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

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildStatusReport } from './status.mjs';
import { spawnBackground } from '../src/platform.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENRICH_SCRIPT = join(__dirname, 'enrich-queue.mjs');

const POLL_INTERVAL_MS = 30_000;   // 30 s — fast enough to catch crashes
const MAX_RELAUNCHES = 3;

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

async function main() {
  const projectRoot = resolve(process.argv[2] ?? process.cwd());
  const logDir = join(projectRoot, '.planning', 'project-memory-context', 'enrichment');
  const logPath = join(logDir, 'watchdog.log');

  // Ensure log directory exists (don't use ensureProjectMemoryContextDirs to avoid heavy imports)
  try {
    await mkdir(logDir, { recursive: true });
  } catch {}

  await appendLog(logPath, `watchdog started pid=${process.pid}`);

  let relaunches = 0;

  while (true) {
    await sleep(POLL_INTERVAL_MS);

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
}

main().catch(async (err) => {
  const projectRoot = resolve(process.argv[2] ?? process.cwd());
  const logPath = join(projectRoot, '.planning', 'project-memory-context', 'enrichment', 'watchdog.log');
  try {
    await appendFile(logPath, `[${new Date().toISOString()}] FATAL: ${err.message}\n`, 'utf8');
  } catch {}
});
