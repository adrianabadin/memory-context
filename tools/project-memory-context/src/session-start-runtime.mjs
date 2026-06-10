// tools/project-memory-context/src/session-start-runtime.mjs
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildStatusReport } from '../cli/status.mjs';
import { spawnBackground } from './platform.mjs';
import { readSyncManifest, getPendingEntries } from './sync-manifest.mjs';
import { isWatcherAlive, readWatchPidRecord } from './watcher-lifecycle.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = join(__dirname, '..', 'cli');
const OVERVIEW_KINDS = [
  'architecture-current',
  'module-minimap',
  'structure-summary',
  'stack-runtime',
  'dependencies-summary',
];

function noLaunchResult(attempted) {
  return {
    attempted,
    launchedEnrichment: false,
    launchedWatchdog: false,
    backend: 'detached-node',
  };
}

async function readJsonSafe(filePath, readFileImpl = readFile) {
  try {
    return JSON.parse(await readFileImpl(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function getSessionStartSnapshotPaths(projectRoot) {
  const snapshotDir = join(
    projectRoot,
    '.planning',
    'project-memory-context',
    'runs',
    'session-start',
  );

  return {
    dir: snapshotDir,
    jsonPath: join(snapshotDir, 'latest.json'),
    markdownPath: join(snapshotDir, 'latest.md'),
  };
}

export async function loadMaterializedOverview(projectRoot, deps = {}) {
  const readFileImpl = deps.readFile ?? readFile;
  const materializedDir = join(
    projectRoot,
    '.planning',
    'project-memory-context',
    'project-context',
    'materialized',
  );

  const entries = await Promise.all(
    OVERVIEW_KINDS.map(async (kind) => {
      const data = await readJsonSafe(join(materializedDir, `${kind}.json`), readFileImpl);
      if (data?.title && data?.summary) {
        return { kind, title: data.title, summary: data.summary };
      }
      return null;
    }),
  );
  return entries.filter(Boolean);
}

export async function launchEnrichmentIfNeeded(projectRoot, status, deps = {}) {
  const pending = status.worklist?.pending ?? 0;
  if (pending <= 0 || status.state === 'running') {
    return noLaunchResult(false);
  }

  const spawnBackgroundImpl = deps.spawnBackground ?? spawnBackground;
  spawnBackgroundImpl(process.execPath, [join(CLI_DIR, 'enrich-queue.mjs'), projectRoot], {
    cwd: projectRoot,
  });
  spawnBackgroundImpl(process.execPath, [join(CLI_DIR, 'enrich-watchdog.mjs'), projectRoot], {
    cwd: projectRoot,
  });

  return {
    attempted: true,
    launchedEnrichment: true,
    launchedWatchdog: true,
    backend: 'detached-node',
  };
}

// Always launch: refresh-context is hash-incremental, so a no-change run
// finishes in seconds. CLI_DIR lives inside this package — when installed
// globally, that IS the global package (requirement: run from global install).
export function launchRefreshContext(projectRoot, deps = {}) {
  const spawnBackgroundImpl = deps.spawnBackground ?? spawnBackground;
  spawnBackgroundImpl(
    process.execPath,
    [join(CLI_DIR, 'refresh-context.mjs'), projectRoot, '--enrich'],
    { cwd: projectRoot },
  );
  return { launchedRefresh: true, backend: 'detached-node' };
}

export async function launchWatcherIfNeeded(projectRoot, deps = {}) {
  const record = await readWatchPidRecord(projectRoot, deps);
  if (isWatcherAlive(record, projectRoot, deps)) {
    return { launchedWatcher: false, watcherPid: record.pid, backend: 'detached-node' };
  }
  const spawnBackgroundImpl = deps.spawnBackground ?? spawnBackground;
  const watcherPid = spawnBackgroundImpl(
    process.execPath,
    [join(CLI_DIR, 'watch.mjs'), projectRoot],
    { cwd: projectRoot },
  );
  return { launchedWatcher: true, watcherPid, backend: 'detached-node' };
}

export function formatSessionStartSnapshotMarkdown(result) {
  const lines = [];
  const worklist = result.status?.worklist;

  lines.push('# PMC session-start snapshot');
  lines.push('');

  if (worklist) {
    const details = [];
    if (worklist.pending > 0) details.push(`${worklist.pending} pending`);
    if (worklist.errors > 0) details.push(`${worklist.errors} errors`);
    const suffix = details.length ? ` (${details.join(', ')})` : '';
    lines.push(`- Queue state: ${result.status.state}`);
    lines.push(`- Enriched symbols: ${worklist.enriched}${suffix}`);
  }

  if (result.syncPending > 0) {
    lines.push(`- Sync: ${result.syncPending} pending; run \`/sync-context\` to persist to agent-memory.`);
  }

  if (result.subagentPending > 0) {
    lines.push(`- Subagent queue: ${result.subagentPending} pending`);
  }

  if (result.watcher) {
    lines.push(`- Watcher: ${result.watcher.launchedWatcher ? 'launched' : 'already running'}${result.watcher.watcherPid ? ` (pid ${result.watcher.watcherPid})` : ''}`);
  }
  if (result.refresh?.launchedRefresh) {
    lines.push('- Refresh: refresh-context --enrich launched in background');
  }

  if (result.overview.length > 0) {
    lines.push('');
    lines.push('## Project context');
    lines.push('');
    for (const entry of result.overview) {
      lines.push(`- **${entry.title}:** ${entry.summary}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export async function writeSessionStartSnapshot(projectRoot, result, deps = {}) {
  const mkdirImpl = deps.mkdir ?? mkdir;
  const writeFileImpl = deps.writeFile ?? writeFile;
  const snapshotPaths = getSessionStartSnapshotPaths(projectRoot);

  await mkdirImpl(snapshotPaths.dir, { recursive: true });
  await writeFileImpl(snapshotPaths.jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await writeFileImpl(
    snapshotPaths.markdownPath,
    formatSessionStartSnapshotMarkdown(result),
    'utf8',
  );

  return snapshotPaths;
}

export async function runSessionStartRuntime(projectRoot = process.cwd(), deps = {}) {
  const root = resolve(projectRoot);
  const existsImpl = deps.existsSync ?? existsSync;
  const buildStatus = deps.buildStatusReport ?? buildStatusReport;
  const readSync = deps.readSyncManifest ?? readSyncManifest;
  const getPending = deps.getPendingEntries ?? getPendingEntries;
  const pmcDir = join(root, '.planning', 'project-memory-context');

  if (!existsImpl(pmcDir)) {
    return {
      hasPmc: false,
      projectRoot: root,
      status: null,
      launch: noLaunchResult(false),
      refresh: { launchedRefresh: false, backend: 'detached-node' },
      watcher: { launchedWatcher: false, watcherPid: null, backend: 'detached-node' },
      syncPending: 0,
      subagentPending: 0,
      overview: [],
      // Snapshot shape includes `dir` for convenience, but downstream consumers
      // may also rely on `jsonPath` and `markdownPath` only (per spec example).
      snapshot: null,
      warnings: [],
    };
  }

  const status = await buildStatus({ projectRoot: root });
  const overview = await loadMaterializedOverview(root, deps);
  const enrichmentDir = join(pmcDir, 'enrichment');

  const warnings = [];
  let syncPending = 0;
  try {
    syncPending = getPending(await readSync(enrichmentDir)).length;
  } catch (err) {
    warnings.push(`sync-manifest read failed: ${err.message ?? err}`);
  }

  let launch;
  try {
    launch = await launchEnrichmentIfNeeded(root, status, deps);
  } catch (err) {
    launch = noLaunchResult(true);
    warnings.push(`launchEnrichmentIfNeeded failed: ${err.message ?? err}`);
  }

  let refresh;
  try {
    refresh = launchRefreshContext(root, deps);
  } catch (err) {
    refresh = { launchedRefresh: false, backend: 'detached-node' };
    warnings.push(`launchRefreshContext failed: ${err.message ?? err}`);
  }

  let watcher;
  try {
    watcher = await launchWatcherIfNeeded(root, deps);
  } catch (err) {
    watcher = { launchedWatcher: false, watcherPid: null, backend: 'detached-node' };
    warnings.push(`launchWatcherIfNeeded failed: ${err.message ?? err}`);
  }

  const result = {
    hasPmc: true,
    projectRoot: root,
    status,
    launch,
    refresh,
    watcher,
    syncPending,
    subagentPending: status.subagentQueue?.pending ?? 0,
    overview,
    snapshot: null,
    warnings,
  };

  const snapshotPaths = getSessionStartSnapshotPaths(root);
  result.snapshot = {
    dir: snapshotPaths.dir,
    jsonPath: snapshotPaths.jsonPath,
    markdownPath: snapshotPaths.markdownPath,
  };

  try {
    await writeSessionStartSnapshot(root, result, deps);
  } catch (err) {
    result.warnings.push(`session-start snapshot write failed: ${err.message ?? err}`);
  }

  return result;
}
