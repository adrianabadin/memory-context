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
