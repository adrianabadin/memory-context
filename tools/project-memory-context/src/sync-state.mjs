import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

function heartbeatIsFresh(heartbeatAt, now, staleAfterSeconds = 300) {
  if (!heartbeatAt) return false;
  const heartbeat = new Date(heartbeatAt).getTime();
  const current = new Date(now).getTime();
  if (!Number.isFinite(heartbeat) || !Number.isFinite(current)) return false;
  return current - heartbeat <= staleAfterSeconds * 1000;
}

function toIsoString(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function deriveSyncState(syncState, now, staleAfterSeconds = 300) {
  if (!syncState || typeof syncState !== 'object') {
    return { state: 'idle', runtime: null };
  }

  const runtime = {
    pid: Number.isInteger(syncState.pid) ? syncState.pid : null,
    startedAt: toIsoString(syncState.startedAt),
    heartbeatAt: toIsoString(syncState.heartbeatAt),
    finishedAt: toIsoString(syncState.finishedAt),
    staleAfterSeconds,
    lastError: syncState.lastError ?? null,
    summary: syncState.summary ? {
      synced: Number.isInteger(syncState.summary.synced) ? syncState.summary.synced : 0,
      errors: Number.isInteger(syncState.summary.errors) ? syncState.summary.errors : 0,
      pending: Number.isInteger(syncState.summary.pending) ? syncState.summary.pending : 0,
    } : null,
  };

  if (syncState.status === 'finished') {
    return { state: 'finished', runtime };
  }

  if (syncState.status === 'failed') {
    return { state: 'failed', runtime };
  }

  if (syncState.status === 'running') {
    return {
      state: heartbeatIsFresh(runtime.heartbeatAt, now, staleAfterSeconds) ? 'running' : 'stalled',
      runtime,
    };
  }

  return { state: 'idle', runtime: null };
}

export function buildSyncState({
  status,
  pid,
  startedAt,
  heartbeatAt,
  finishedAt = null,
  lastError = null,
  summary,
}) {
  return {
    status,
    pid,
    startedAt,
    heartbeatAt,
    finishedAt,
    lastError,
    summary: {
      synced: summary?.synced ?? 0,
      errors: summary?.errors ?? 0,
      pending: summary?.pending ?? 0,
    },
  };
}

export async function writeSyncState(filePath, state, deps = {}) {
  const mkdirImpl = deps.mkdir ?? mkdir;
  const writeFileImpl = deps.writeFile ?? writeFile;
  const renameImpl = deps.rename ?? rename;

  const tempPath = `${filePath}.tmp`;
  const dir = dirname(filePath);

  await mkdirImpl(dir, { recursive: true });
  await writeFileImpl(tempPath, `${JSON.stringify(buildSyncState(state), null, 2)}\n`, 'utf8');

  const maxRetries = 5;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await renameImpl(tempPath, filePath);
      return;
    } catch (err) {
      if (err.code === 'ENOENT') {
        await mkdirImpl(dir, { recursive: true });
        if (attempt === maxRetries) throw err;
      } else if (err.code === 'EPERM' || err.code === 'EEXIST') {
        if (attempt === maxRetries) throw err;
        await new Promise((r) => setTimeout(r, 25 * attempt));
      } else {
        throw err;
      }
    }
  }
}

export async function readSyncState(filePath, deps = {}) {
  const readFileImpl = deps.readFile ?? readFile;
  try {
    const raw = await readFileImpl(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    return null;
  }
}
