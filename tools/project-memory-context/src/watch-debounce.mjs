// tools/project-memory-context/src/watch-debounce.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const WATCH_QUIET_MS = 5 * 60 * 1000;

export function getWatchPendingPath(projectRoot) {
  return join(projectRoot, '.planning', 'project-memory-context', 'state', 'watch-pending.json');
}

export function recordChange(pending, filePath, nowMs) {
  return { ...pending, [filePath]: nowMs };
}

// Splits pending into files quiet for >= quietMs (ready to refresh) and files
// still hot (recently touched — kept for the next tick). `quiet` keeps the
// timestamps so the caller can detect re-modification during a refresh run.
export function partitionQuiet(pending, nowMs, quietMs = WATCH_QUIET_MS) {
  const quiet = [];
  const hot = {};
  for (const [filePath, changedAt] of Object.entries(pending)) {
    if (nowMs - changedAt >= quietMs) {
      quiet.push([filePath, changedAt]);
    } else {
      hot[filePath] = changedAt;
    }
  }
  return { quiet, hot };
}

export async function readWatchPending(projectRoot, deps = {}) {
  const readFileImpl = deps.readFile ?? readFile;
  try {
    const parsed = JSON.parse(await readFileImpl(getWatchPendingPath(projectRoot), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    return {};
  }
}

export async function writeWatchPending(projectRoot, pending, deps = {}) {
  const mkdirImpl = deps.mkdir ?? mkdir;
  const writeFileImpl = deps.writeFile ?? writeFile;
  const pendingPath = getWatchPendingPath(projectRoot);
  await mkdirImpl(dirname(pendingPath), { recursive: true });
  await writeFileImpl(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, 'utf8');
}
