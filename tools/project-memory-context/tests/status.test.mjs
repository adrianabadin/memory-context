import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { summarizeWorklist, buildStatusReport } from '../cli/status.mjs';

async function createStatusFixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-status-'));
  const enrichmentDir = join(projectRoot, '.planning', 'project-memory-context', 'enrichment');
  await mkdir(enrichmentDir, { recursive: true });
  return { projectRoot, enrichmentDir };
}

test('summarizeWorklist counts pending, stale, and enriched entries', () => {
  const summary = summarizeWorklist([
    { status: 'pending' },
    { status: 'stale' },
    { status: 'enriched' },
  ]);
  assert.deepEqual(summary, { pending: 2, enriched: 1, errors: 0 });
});

test('summarizeWorklist handles empty worklist', () => {
  assert.deepEqual(summarizeWorklist([]), { pending: 0, enriched: 0, errors: 0 });
});

test('summarizeWorklist counts already_enriched as enriched', () => {
  const summary = summarizeWorklist([
    { status: 'already_enriched' },
    { status: 'error' },
  ]);
  assert.deepEqual(summary, { pending: 0, enriched: 1, errors: 1 });
});

test('buildStatusReport returns structured status with config and worklist', async () => {
  const { projectRoot, enrichmentDir } = await createStatusFixture();
  await writeFile(
    join(enrichmentDir, 'worklist.json'),
    JSON.stringify([{ status: 'pending' }, { status: 'enriched' }]),
  );
  await writeFile(
    join(projectRoot, '.planning', 'project-memory-context', 'install.json'),
    JSON.stringify({ installedAt: '2026-05-19T00:00:00.000Z', version: '0.1.0' }),
  );

  const report = await buildStatusReport({ projectRoot });
  assert.equal(report.ok, true);
  assert.equal(report.state, 'idle');
  assert.equal(report.runtime, null);
  assert.equal(report.installState.installedAt, '2026-05-19T00:00:00.000Z');
  assert.equal(report.installState.version, '0.1.0');
  assert.equal(report.worklist.pending, 1);
  assert.equal(report.worklist.enriched, 1);
  assert.ok(report.configLocation);
});

test('buildStatusReport returns null worklist for valid but wrong-shaped worklist.json', async () => {
  const { projectRoot, enrichmentDir } = await createStatusFixture();
  await writeFile(join(enrichmentDir, 'worklist.json'), JSON.stringify({ status: 'pending' }));

  const report = await buildStatusReport({ projectRoot, now: '2026-05-20T21:00:00.000Z' });
  assert.equal(report.state, 'idle');
  assert.equal(report.runtime, null);
  assert.equal(report.worklist, null);
});

test('buildStatusReport returns idle when queue-state.json is missing', async () => {
  const { projectRoot, enrichmentDir } = await createStatusFixture();
  await writeFile(join(enrichmentDir, 'worklist.json'), JSON.stringify([{ status: 'pending' }]));

  const report = await buildStatusReport({ projectRoot, now: '2026-05-20T21:00:00.000Z' });
  assert.equal(report.state, 'idle');
  assert.equal(report.runtime, null);
});

test('buildStatusReport returns idle when queue-state.json is malformed', async () => {
  const { projectRoot, enrichmentDir } = await createStatusFixture();
  await writeFile(join(enrichmentDir, 'worklist.json'), JSON.stringify([{ status: 'pending' }]));
  await writeFile(join(enrichmentDir, 'queue-state.json'), '{not valid json');

  const report = await buildStatusReport({ projectRoot, now: '2026-05-20T21:00:00.000Z' });
  assert.equal(report.state, 'idle');
  assert.equal(report.runtime, null);
});

test('buildStatusReport returns running for fresh heartbeat', async () => {
  const { projectRoot, enrichmentDir } = await createStatusFixture();
  await writeFile(join(enrichmentDir, 'worklist.json'), JSON.stringify([{ status: 'pending' }]));
  await writeFile(
    join(enrichmentDir, 'queue-state.json'),
    JSON.stringify({
      status: 'running',
      pid: 4242,
      startedAt: '2026-05-20T20:58:00.000Z',
      heartbeatAt: '2026-05-20T20:59:30.000Z',
      finishedAt: null,
      lastError: null,
      summary: { pending: 1, enriched: 0, errors: 0 },
    }),
  );

  const report = await buildStatusReport({ projectRoot, now: '2026-05-20T21:00:00.000Z' });
  assert.equal(report.state, 'running');
  assert.equal(report.runtime.pid, 4242);
  assert.equal(report.runtime.staleAfterSeconds, 90);
});

test('buildStatusReport returns stalled for expired heartbeat', async () => {
  const { projectRoot, enrichmentDir } = await createStatusFixture();
  await writeFile(join(enrichmentDir, 'worklist.json'), JSON.stringify([{ status: 'pending' }]));
  await writeFile(
    join(enrichmentDir, 'queue-state.json'),
    JSON.stringify({
      status: 'running',
      pid: 4242,
      startedAt: '2026-05-20T20:50:00.000Z',
      heartbeatAt: '2026-05-20T20:55:00.000Z',
      finishedAt: null,
      lastError: null,
      summary: { pending: 1, enriched: 0, errors: 0 },
    }),
  );

  const report = await buildStatusReport({ projectRoot, now: '2026-05-20T21:00:00.000Z' });
  assert.equal(report.state, 'stalled');
});

test('buildStatusReport preserves finished and failed terminal states', async () => {
  const { projectRoot, enrichmentDir } = await createStatusFixture();
  await writeFile(join(enrichmentDir, 'worklist.json'), JSON.stringify([{ status: 'error' }]));
  await writeFile(
    join(enrichmentDir, 'queue-state.json'),
    JSON.stringify({
      status: 'failed',
      pid: 4242,
      startedAt: '2026-05-20T20:50:00.000Z',
      heartbeatAt: '2026-05-20T20:55:00.000Z',
      finishedAt: '2026-05-20T20:55:01.000Z',
      lastError: 'fatal queue error',
      summary: { pending: 1, enriched: 0, errors: 1 },
    }),
  );

  const report = await buildStatusReport({ projectRoot, now: '2026-05-20T21:00:00.000Z' });
  assert.equal(report.state, 'failed');
  assert.equal(report.runtime.lastError, 'fatal queue error');
});

test('buildStatusReport preserves finished terminal state', async () => {
  const { projectRoot, enrichmentDir } = await createStatusFixture();
  await writeFile(join(enrichmentDir, 'worklist.json'), JSON.stringify([{ status: 'enriched' }]));
  await writeFile(
    join(enrichmentDir, 'queue-state.json'),
    JSON.stringify({
      status: 'finished',
      pid: 4242,
      startedAt: '2026-05-20T20:50:00.000Z',
      heartbeatAt: '2026-05-20T20:55:00.000Z',
      finishedAt: '2026-05-20T20:55:01.000Z',
      lastError: null,
      summary: { pending: 0, enriched: 1, errors: 0 },
    }),
  );

  const report = await buildStatusReport({ projectRoot, now: '2026-05-20T21:00:00.000Z' });
  assert.equal(report.state, 'finished');
  assert.equal(report.runtime.finishedAt, '2026-05-20T20:55:01.000Z');
});
