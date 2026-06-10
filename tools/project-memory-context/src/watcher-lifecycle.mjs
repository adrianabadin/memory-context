import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const WATCH_HEARTBEAT_INTERVAL_MS = 30_000;
export const WATCH_HEARTBEAT_STALE_MS = WATCH_HEARTBEAT_INTERVAL_MS * 3;

export function getWatchStateDir(projectRoot) {
  return join(projectRoot, '.planning', 'project-memory-context', 'state');
}

export function getWatchPidPath(projectRoot) {
  return join(getWatchStateDir(projectRoot), 'watch.pid');
}

// PID-alive check. EPERM means the process exists but is owned by someone else
// — that still counts as alive.
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export async function readWatchPidRecord(projectRoot, deps = {}) {
  const readFileImpl = deps.readFile ?? readFile;
  try {
    const parsed = JSON.parse(await readFileImpl(getWatchPidPath(projectRoot), 'utf8'));
    if (!Number.isInteger(parsed?.pid)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeWatchPidRecord(projectRoot, record, deps = {}) {
  const mkdirImpl = deps.mkdir ?? mkdir;
  const writeFileImpl = deps.writeFile ?? writeFile;
  const pidPath = getWatchPidPath(projectRoot);
  await mkdirImpl(dirname(pidPath), { recursive: true });
  await writeFileImpl(pidPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export async function removeWatchPidFile(projectRoot, deps = {}) {
  const rmImpl = deps.rm ?? rm;
  await rmImpl(getWatchPidPath(projectRoot), { force: true });
}

// "Alive" requires all three: live PID, matching projectRoot, fresh heartbeat.
// Anything else is stale — covers PID reuse by the OS and hung watchers.
export function isWatcherAlive(record, projectRoot, deps = {}) {
  const nowMs = deps.now ?? Date.now();
  const pidAlive = deps.isPidAlive ?? isPidAlive;

  if (!record) return false;
  if (resolve(String(record.projectRoot ?? '')) !== resolve(projectRoot)) return false;
  if (!pidAlive(record.pid)) return false;

  const heartbeatMs = Date.parse(record.lastHeartbeat ?? '');
  if (!Number.isFinite(heartbeatMs)) return false;
  return nowMs - heartbeatMs <= WATCH_HEARTBEAT_STALE_MS;
}
