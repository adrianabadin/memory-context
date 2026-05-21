#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectAgentType, resolveConfigDirs } from '../src/platform.mjs';

const DEFAULT_STALE_AFTER_SECONDS = 90;

export function summarizeWorklist(worklist) {
  return {
    pending: worklist.filter((e) => e.status === 'pending' || e.status === 'stale').length,
    enriched: worklist.filter((e) => e.status === 'enriched' || e.status === 'already_enriched').length,
    errors: worklist.filter((e) => e.status === 'error').length,
  };
}

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function toIsoString(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function heartbeatIsFresh(heartbeatAt, now, staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS) {
  if (!heartbeatAt) return false;
  const heartbeat = new Date(heartbeatAt).getTime();
  const current = new Date(now).getTime();
  if (!Number.isFinite(heartbeat) || !Number.isFinite(current)) return false;
  return current - heartbeat <= staleAfterSeconds * 1000;
}

function deriveRuntimeState(queueState, now, staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS) {
  if (!queueState || typeof queueState !== 'object') {
    return { state: 'idle', runtime: null };
  }

  const runtime = {
    pid: Number.isInteger(queueState.pid) ? queueState.pid : null,
    startedAt: toIsoString(queueState.startedAt),
    heartbeatAt: toIsoString(queueState.heartbeatAt),
    finishedAt: toIsoString(queueState.finishedAt),
    staleAfterSeconds,
    lastError: queueState.lastError ?? null,
  };

  if (queueState.status === 'finished') {
    return { state: 'finished', runtime };
  }

  if (queueState.status === 'failed') {
    return { state: 'failed', runtime };
  }

  if (queueState.status === 'running') {
    return {
      state: heartbeatIsFresh(runtime.heartbeatAt, now, staleAfterSeconds) ? 'running' : 'stalled',
      runtime,
    };
  }

  return { state: 'idle', runtime: null };
}

async function getLastSyncTimestamp(enrichmentDir) {
  const syncManifest = join(enrichmentDir, 'sync-manifest.json');
  try {
    const st = await stat(syncManifest);
    return st.mtime.toISOString();
  } catch {
    return null;
  }
}

export async function buildStatusReport({ projectRoot = process.cwd(), now = new Date().toISOString() } = {}) {
  const dirs = resolveConfigDirs(projectRoot);
  const planningDir = join(projectRoot, '.planning', 'project-memory-context');
  const enrichmentDir = join(planningDir, 'enrichment');
  const worklistPath = join(enrichmentDir, 'worklist.json');
  const installStatePath = join(planningDir, 'install.json');
  const queueStatePath = join(enrichmentDir, 'queue-state.json');

  const worklist = await readJsonSafe(worklistPath);
  const installState = await readJsonSafe(installStatePath);
  const queueState = await readJsonSafe(queueStatePath);
  const lastSync = await getLastSyncTimestamp(enrichmentDir);
  const { state, runtime } = deriveRuntimeState(queueState, now);
  const worklistSummary = Array.isArray(worklist) ? summarizeWorklist(worklist) : null;

  return {
    ok: true,
    command: 'status',
    projectRoot: resolve(projectRoot),
    configLocation: dirs.projectConfig,
    agentType: detectAgentType(projectRoot),
    installState: installState ? { installedAt: installState.installedAt, version: installState.version } : null,
    state,
    runtime,
    worklist: worklistSummary,
    lastSync,
  };
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: pmc status [project-dir]');
    console.log('');
    console.log('Shows enrichment queue state, worklist counts, config location,');
    console.log('agent type, and last sync timestamp.');
    return 0;
  }

  const projectRoot = args.find((a) => !a.startsWith('-')) || process.cwd();
  const report = await buildStatusReport({ projectRoot });
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main().catch((error) => {
    console.error('[status] FATAL:', error.message);
    return 1;
  });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
