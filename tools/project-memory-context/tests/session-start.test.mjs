// tools/project-memory-context/tests/session-start.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  getSessionStartSnapshotPaths,
  launchEnrichmentIfNeeded,
  runSessionStartRuntime,
} from '../src/session-start-runtime.mjs';
import { runSessionStart } from '../cli/session-start.mjs';
import pluginFactory from '../plugin/index.mjs';

async function createSessionStartFixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-session-start-'));
  const planningDir = join(projectRoot, '.planning', 'project-memory-context');
  const enrichmentDir = join(planningDir, 'enrichment');
  const materializedDir = join(planningDir, 'project-context', 'materialized');

  await mkdir(enrichmentDir, { recursive: true });
  await mkdir(materializedDir, { recursive: true });

  await writeFile(
    join(materializedDir, 'architecture-current.json'),
    JSON.stringify({ title: 'Architecture', summary: 'Layered pipeline with plugin startup.' }),
  );

  return { projectRoot, enrichmentDir, materializedDir };
}

test('runSessionStartRuntime writes latest snapshot files and returns materialized overview', async () => {
  const { projectRoot, enrichmentDir } = await createSessionStartFixture();

  await writeFile(
    join(enrichmentDir, 'sync-manifest.json'),
    JSON.stringify({ entries: [{ id: '1', status: 'pending', action: 'upsert' }] }),
  );

  const result = await runSessionStartRuntime(projectRoot, {
    buildStatusReport: async () => ({
      state: 'idle',
      worklist: { pending: 0, enriched: 12, errors: 0 },
      subagentQueue: { pending: 2 },
    }),
  });

  assert.equal(result.hasPmc, true);
  assert.equal(result.syncPending, 1);
  assert.equal(result.subagentPending, 2);
  assert.deepEqual(result.overview, [
    {
      kind: 'architecture-current',
      title: 'Architecture',
      summary: 'Layered pipeline with plugin startup.',
    },
  ]);

  const snapshotPaths = getSessionStartSnapshotPaths(projectRoot);
  const jsonSnapshot = JSON.parse(await readFile(snapshotPaths.jsonPath, 'utf8'));
  const markdownSnapshot = await readFile(snapshotPaths.markdownPath, 'utf8');

  assert.equal(jsonSnapshot.status.worklist.enriched, 12);
  assert.match(markdownSnapshot, /Layered pipeline with plugin startup\./);
  assert.match(markdownSnapshot, /run `\/sync-context` to persist to agent-memory/i);
});

test('runSessionStartRuntime launches enrichment and watchdog only when pending work is not already running', async () => {
  const { projectRoot } = await createSessionStartFixture();
  const spawns = [];

  const result = await runSessionStartRuntime(projectRoot, {
    buildStatusReport: async () => ({
      state: 'idle',
      worklist: { pending: 3, enriched: 9, errors: 0 },
      subagentQueue: { pending: 0 },
    }),
    spawnBackground: (command, args, options) => {
      spawns.push({ command, args, options });
      return 42;
    },
  });

  assert.equal(result.launch.launchedEnrichment, true);
  assert.equal(result.launch.launchedWatchdog, true);
  assert.equal(result.launch.backend, 'detached-node');
  assert.equal(spawns.length, 2);
  assert.match(spawns[0].args[0].replace(/\\/g, '/'), /enrich-queue\.mjs$/);
  assert.match(spawns[1].args[0].replace(/\\/g, '/'), /enrich-watchdog\.mjs$/);
});

test('runSessionStartRuntime returns hasPmc: false and writes no snapshots when .planning/project-memory-context is missing', async () => {
  const { projectRoot } = await createSessionStartFixture();
  await rm(join(projectRoot, '.planning'), { recursive: true, force: true });

  let buildStatusCalled = false;
  const result = await runSessionStartRuntime(projectRoot, {
    buildStatusReport: async () => {
      buildStatusCalled = true;
      return { state: 'idle', worklist: { pending: 0, enriched: 0, errors: 0 } };
    },
  });

  assert.equal(result.hasPmc, false);
  assert.equal(result.status, null);
  assert.equal(result.snapshot, null);
  assert.deepEqual(result.warnings, []);
  assert.equal(buildStatusCalled, false);

  const snapshotPaths = getSessionStartSnapshotPaths(projectRoot);
  assert.equal(existsSync(snapshotPaths.jsonPath), false);
  assert.equal(existsSync(snapshotPaths.markdownPath), false);
});

test('launchEnrichmentIfNeeded returns launched*:false when status.state === "running"', async () => {
  await createSessionStartFixture();

  let spawnCalled = false;
  const launch = await launchEnrichmentIfNeeded(
    join(tmpdir(), 'pmc-launch-skip-running'),
    { state: 'running', worklist: { pending: 5, enriched: 1, errors: 0 } },
    {
      spawnBackground: () => {
        spawnCalled = true;
        return 1;
      },
    },
  );

  assert.equal(launch.attempted, false);
  assert.equal(launch.launchedEnrichment, false);
  assert.equal(launch.launchedWatchdog, false);
  assert.equal(launch.backend, 'detached-node');
  assert.equal(spawnCalled, false);
});

test('launchEnrichmentIfNeeded returns launched*:false when worklist.pending === 0', async () => {
  await createSessionStartFixture();

  let spawnCalled = false;
  const launch = await launchEnrichmentIfNeeded(
    join(tmpdir(), 'pmc-launch-skip-empty'),
    { state: 'idle', worklist: { pending: 0, enriched: 12, errors: 0 } },
    {
      spawnBackground: () => {
        spawnCalled = true;
        return 1;
      },
    },
  );

  assert.equal(launch.attempted, false);
  assert.equal(launch.launchedEnrichment, false);
  assert.equal(launch.launchedWatchdog, false);
  assert.equal(launch.backend, 'detached-node');
  assert.equal(spawnCalled, false);
});

test('runSessionStart prints text output using the shared runtime result', async () => {
  const writes = [];

  await runSessionStart(['C:/repo'], {
    stdout: { write: (chunk) => writes.push(chunk) },
    runSessionStartRuntime: async () => ({
      hasPmc: true,
      status: {
        state: 'idle',
        worklist: { pending: 2, enriched: 7, errors: 1 },
      },
      launch: {
        attempted: true,
        launchedEnrichment: true,
        launchedWatchdog: true,
        backend: 'detached-node',
      },
      syncPending: 3,
      subagentPending: 1,
      overview: [{ kind: 'architecture-current', title: 'Architecture', summary: 'Plugin startup runtime.' }],
      snapshot: null,
      warnings: [],
    }),
  });

  const output = writes.join('');
  assert.match(output, /\*\*PMC enrichment:\*\* 7 symbols enriched · 2 pending, 1 errors · queue: idle/);
  assert.match(output, /\*\*Launch:\*\* background enrich\/watchdog started via detached-node\./);
  assert.match(output, /\*\*Sync:\*\* 3 pending/);
  assert.match(output, /\*\*Architecture:\*\* Plugin startup runtime\./);
});

test('runSessionStart emits Claude Code hook payload when requested', async () => {
  const writes = [];

  await runSessionStart(['C:/repo', '--format=claude-code'], {
    stdout: { write: (chunk) => writes.push(chunk) },
    runSessionStartRuntime: async () => ({
      hasPmc: true,
      status: { state: 'idle', worklist: { pending: 0, enriched: 4, errors: 0 } },
      launch: { attempted: false, launchedEnrichment: false, launchedWatchdog: false, backend: 'detached-node' },
      syncPending: 0,
      subagentPending: 0,
      overview: [],
      snapshot: null,
      warnings: [],
    }),
  });

  const payload = JSON.parse(writes.join('').trim());
  assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(payload.hookSpecificOutput.additionalContext, /\*\*PMC enrichment:\*\* 4 symbols enriched/);
});

test('runSessionStart writes nothing and returns 0 when runtime reports hasPmc: false', async () => {
  const writes = [];

  const code = await runSessionStart(['C:/repo'], {
    stdout: { write: (chunk) => writes.push(chunk) },
    runSessionStartRuntime: async () => ({
      hasPmc: false,
      status: null,
      launch: {
        attempted: false,
        launchedEnrichment: false,
        launchedWatchdog: false,
        backend: 'detached-node',
      },
      syncPending: 0,
      subagentPending: 0,
      overview: [],
      snapshot: null,
      warnings: [],
    }),
  });

  assert.equal(code, 0);
  assert.equal(writes.length, 0);
});

test('OpenCode plugin runs the shared session-start runtime during config()', async () => {
  const events = [];

  const plugin = await pluginFactory({
    directory: 'C:/repo',
    __testOverrides: {
      readInstallState: async () => ({ projectRoot: 'C:/repo', memoryDbPath: 'C:/repo/.planning/project-memory-context/memory.db' }),
      createController: () => ({
        rehydrate: async () => { events.push('rehydrate'); },
        onToolExecuteAfter: async () => {},
      }),
      runSessionStartRuntime: async (projectRoot, options) => {
        events.push(`runtime:${projectRoot}:${options.mode}`);
        return { hasPmc: true };
      },
    },
  });

  const cfg = {};
  await plugin.config(cfg);

  assert.equal(cfg.mcp['pmc-agent-memory'].enabled, true);
  assert.deepEqual(events, ['rehydrate', 'runtime:C:/repo:opencode-plugin']);
});

test('OpenCode plugin config() swallows runtime errors so startup never fails', async () => {
  const plugin = await pluginFactory({
    directory: 'C:/repo',
    __testOverrides: {
      readInstallState: async () => ({
        projectRoot: 'C:/repo',
        memoryDbPath: 'C:/repo/.planning/project-memory-context/memory.db',
      }),
      createController: () => ({
        rehydrate: async () => {},
        onToolExecuteAfter: async () => {},
      }),
      runSessionStartRuntime: async () => {
        throw new Error('boom');
      },
    },
  });

  const cfg = {};
  await assert.doesNotReject(() => plugin.config(cfg));
  assert.equal(cfg.mcp['pmc-agent-memory'].enabled, true);
});
