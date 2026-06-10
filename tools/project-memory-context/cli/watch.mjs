// tools/project-memory-context/cli/watch.mjs
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watch } from 'node:fs';

import { shouldWatch } from '../src/file-watcher.mjs';
import { refreshContext } from './refresh-context.mjs';
import { spawnBackground } from '../src/platform.mjs';
import {
  WATCH_HEARTBEAT_INTERVAL_MS,
  isPidAlive,
  isWatcherAlive,
  readWatchPidRecord,
  removeWatchPidFile,
  writeWatchPidRecord,
} from '../src/watcher-lifecycle.mjs';
import {
  WATCH_QUIET_MS,
  partitionQuiet,
  readWatchPending,
  recordChange,
  writeWatchPending,
} from '../src/watch-debounce.mjs';

function log(msg) { console.error(`[watch] ${msg}`); }

export function createWatchRuntime({ projectRoot, startedAt, quietMs = WATCH_QUIET_MS, deps = {} }) {
  const runRefresh = deps.refreshContext ?? refreshContext;
  const now = deps.now ?? Date.now;
  const pid = deps.pid ?? process.pid;

  let pending = {};
  let refreshRunning = false;

  async function persistPending() {
    try {
      await writeWatchPending(projectRoot, pending, deps);
    } catch (err) {
      log(`pending persist failed: ${err.message}`);
    }
  }

  return {
    getPending: () => ({ ...pending }),
    setPending: (value) => { pending = { ...value }; },

    async onFsEvent(filename) {
      if (!filename || !shouldWatch(String(filename))) return;
      pending = recordChange(pending, String(filename).replace(/\\/g, '/'), now());
      await persistPending();
    },

    async tick() {
      // Heartbeat first: proves liveness even when there is nothing to do.
      try {
        await writeWatchPidRecord(projectRoot, {
          pid,
          projectRoot: resolve(projectRoot),
          startedAt,
          lastHeartbeat: new Date(now()).toISOString(),
        }, deps);
      } catch (err) {
        log(`heartbeat write failed: ${err.message}`);
      }

      if (refreshRunning) return { refreshed: false, reason: 'refresh-in-progress' };

      const { quiet } = partitionQuiet(pending, now(), quietMs);
      if (quiet.length === 0) return { refreshed: false, reason: 'no-quiet-files' };

      refreshRunning = true;
      try {
        log(`${quiet.length} quiet file(s) — running refresh-context --enrich...`);
        await runRefresh(projectRoot, { enrich: true });
        // Consume only files NOT re-modified while the refresh was running.
        for (const [filePath, changedAt] of quiet) {
          if (pending[filePath] === changedAt) {
            const { [filePath]: _removed, ...rest } = pending;
            pending = rest;
          }
        }
        await persistPending();
        return { refreshed: true, quietCount: quiet.length };
      } catch (err) {
        log(`refresh-context error: ${err.message}`);
        return { refreshed: false, reason: 'refresh-error' };
      } finally {
        refreshRunning = false;
      }
    },
  };
}

async function statusCommand(projectRoot) {
  const record = await readWatchPidRecord(projectRoot);
  const alive = isWatcherAlive(record, projectRoot);
  const pendingFiles = Object.keys(await readWatchPending(projectRoot)).length;
  console.log(JSON.stringify({
    alive,
    pid: record?.pid ?? null,
    startedAt: record?.startedAt ?? null,
    lastHeartbeat: record?.lastHeartbeat ?? null,
    pendingFiles,
  }, null, 2));
}

async function stopCommand(projectRoot) {
  const record = await readWatchPidRecord(projectRoot);
  if (!record || !isPidAlive(record.pid)) {
    log('No running watcher found.');
    await removeWatchPidFile(projectRoot);
    return;
  }
  try {
    process.kill(record.pid);
    log(`Stopped watcher (pid ${record.pid}).`);
  } catch (err) {
    log(`Failed to stop watcher (pid ${record.pid}): ${err.message}`);
    process.exitCode = 1;
    return;
  }
  await removeWatchPidFile(projectRoot);
}

async function detachCommand(projectRoot) {
  const existing = await readWatchPidRecord(projectRoot);
  if (isWatcherAlive(existing, projectRoot)) {
    log(`Watcher already running (pid ${existing.pid}).`);
    return;
  }
  await removeWatchPidFile(projectRoot);
  spawnBackground(process.execPath, [fileURLToPath(import.meta.url), projectRoot], { cwd: projectRoot });

  // Confirm startup: poll the pid file for up to 5s.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 200));
    const record = await readWatchPidRecord(projectRoot);
    if (record && isPidAlive(record.pid)) {
      log(`Watcher started in background (pid ${record.pid}).`);
      return;
    }
  }
  log('Watcher failed to start within 5s.');
  process.exitCode = 1;
}

async function runForeground(projectRoot) {
  const existing = await readWatchPidRecord(projectRoot);
  if (isWatcherAlive(existing, projectRoot)) {
    log(`Watcher already running (pid ${existing.pid}). Exiting.`);
    return;
  }
  await removeWatchPidFile(projectRoot);

  const startedAt = new Date().toISOString();
  const runtime = createWatchRuntime({ projectRoot, startedAt });
  runtime.setPending(await readWatchPending(projectRoot));

  // First tick writes the pid file immediately and evaluates inherited pending.
  await runtime.tick();

  const watcher = watch(projectRoot, { recursive: true }, (eventType, filename) => {
    runtime.onFsEvent(filename).catch(() => {});
  });
  watcher.on('error', (err) => log(`Watcher error: ${err.message}`));

  const interval = setInterval(() => {
    runtime.tick().catch((err) => log(`tick error: ${err.message}`));
  }, WATCH_HEARTBEAT_INTERVAL_MS);

  const shutdown = () => {
    clearInterval(interval);
    watcher.close();
    removeWatchPidFile(projectRoot).finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log(`Watching ${projectRoot} (quiet period: ${WATCH_QUIET_MS / 60000}min, tick: ${WATCH_HEARTBEAT_INTERVAL_MS / 1000}s).`);
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const projectRoot = resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd());

  if (flags.has('--status')) return statusCommand(projectRoot);
  if (flags.has('--stop')) return stopCommand(projectRoot);
  if (flags.has('--detach')) return detachCommand(projectRoot);
  return runForeground(projectRoot);
}

// Entrypoint guard: importing this module (tests, session-start) must NOT start a watcher.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[watch] FATAL:', err.message);
    process.exit(1);
  });
}
