import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

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
