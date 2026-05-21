# PMC Status Runtime State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pmc status` report whether the enrichment queue is running right now by adding a queue heartbeat file and a top-level `state` field.

**Architecture:** `enrich-queue.mjs` will write `.planning/project-memory-context/enrichment/queue-state.json` at startup, on progress heartbeats, and on terminal exit. `status.mjs` will read that file, infer `idle`/`running`/`stalled`/`finished`/`failed`, and return both the existing worklist summary and a new `runtime` block.

**Tech Stack:** Node.js ESM, `node:fs/promises`, `node:test`, JSON file artifacts, existing PMC CLI scripts.

**Design spec:** `docs/superpowers/specs/2026-05-20-pmc-status-runtime-state-design.md`

---

## Task 1: Add Runtime State Reading to `pmc status`

**Files:**
- Modify: `tools/project-memory-context/cli/status.mjs`
- Modify: `tools/project-memory-context/tests/status.test.mjs`

- [ ] **Step 1: Write the failing status tests**

  Extend `tools/project-memory-context/tests/status.test.mjs` with explicit runtime-state cases:

  ```javascript
  test('buildStatusReport returns idle when queue-state.json is missing', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-status-'));
    const enrichmentDir = join(projectRoot, '.planning', 'project-memory-context', 'enrichment');
    await mkdir(enrichmentDir, { recursive: true });
    await writeFile(join(enrichmentDir, 'worklist.json'), JSON.stringify([{ status: 'pending' }]));

    const report = await buildStatusReport({ projectRoot, now: '2026-05-20T21:00:00.000Z' });
    assert.equal(report.state, 'idle');
    assert.equal(report.runtime, null);
  });

  test('buildStatusReport returns running for fresh heartbeat', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-status-'));
    const enrichmentDir = join(projectRoot, '.planning', 'project-memory-context', 'enrichment');
    await mkdir(enrichmentDir, { recursive: true });
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
    const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-status-'));
    const enrichmentDir = join(projectRoot, '.planning', 'project-memory-context', 'enrichment');
    await mkdir(enrichmentDir, { recursive: true });
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
    const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-status-'));
    const enrichmentDir = join(projectRoot, '.planning', 'project-memory-context', 'enrichment');
    await mkdir(enrichmentDir, { recursive: true });
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
  ```

  Run:

  ```bash
  node --test tools/project-memory-context/tests/status.test.mjs
  ```

  Expected: FAIL because `buildStatusReport()` does not yet return `state`, `runtime`, or accept `now`.

- [ ] **Step 2: Implement queue-state reading and state inference**

  In `tools/project-memory-context/cli/status.mjs`, add a queue-state reader and explicit state resolver. Keep the current `worklist` summary intact.

  Add near the top of the file:

  ```javascript
  const DEFAULT_STALE_AFTER_SECONDS = 90;

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

    if (queueState.status === 'finished') return { state: 'finished', runtime };
    if (queueState.status === 'failed') return { state: 'failed', runtime };
    if (queueState.status === 'running') {
      return {
        state: heartbeatIsFresh(runtime.heartbeatAt, now, staleAfterSeconds) ? 'running' : 'stalled',
        runtime,
      };
    }

    return { state: 'idle', runtime: null };
  }
  ```

  Then update `buildStatusReport()` to:

  ```javascript
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

    return {
      ok: true,
      command: 'status',
      projectRoot: resolve(projectRoot),
      configLocation: dirs.projectConfig,
      agentType: detectAgentType(projectRoot),
      installState: installState ? { installedAt: installState.installedAt, version: installState.version } : null,
      state,
      runtime,
      worklist: worklist ? summarizeWorklist(worklist) : null,
      lastSync,
    };
  }
  ```

  Keep `readJsonSafe()` tolerant of corrupt files so `pmc status` never crashes on malformed `queue-state.json`.

- [ ] **Step 3: Run the focused test suite**

  Run:

  ```bash
  node --test tools/project-memory-context/tests/status.test.mjs
  ```

  Expected: PASS. Existing worklist tests still pass, and the four new runtime-state tests pass.

---

## Task 2: Make `enrich-queue` Write Heartbeats and Terminal State

**Files:**
- Modify: `tools/project-memory-context/cli/enrich-queue.mjs`
- Modify: `tools/project-memory-context/tests/enrich-queue-driver.test.mjs`

- [ ] **Step 1: Write the failing queue-state tests**

  Extend `tools/project-memory-context/tests/enrich-queue-driver.test.mjs` with writer-level tests that do not require running the full queue loop.

  Add imports first:

  ```javascript
  import {
    buildQueueSummary,
    parseQueueConcurrency,
    runQueueSymbolEnrichment,
    writeQueueState,
    finalizeQueueState,
  } from '../cli/enrich-queue.mjs';
  ```

  Then add tests:

  ```javascript
  test('writeQueueState persists running heartbeat with pid and summary', async () => {
    const { dirs } = await createQueueFixture();
    const queueStateFile = join(dirs.enrichment, 'queue-state.json');

    await writeQueueState({
      queueStateFile,
      status: 'running',
      pid: 4242,
      startedAt: '2026-05-20T21:00:00.000Z',
      heartbeatAt: '2026-05-20T21:00:30.000Z',
      summary: { pending: 3, enriched: 2, errors: 1 },
    });

    const payload = await readJsonArtifact(queueStateFile);
    assert.equal(payload.status, 'running');
    assert.equal(payload.pid, 4242);
    assert.equal(payload.summary.pending, 3);
  });

  test('finalizeQueueState persists failed terminal state with lastError', async () => {
    const { dirs } = await createQueueFixture();
    const queueStateFile = join(dirs.enrichment, 'queue-state.json');

    await finalizeQueueState({
      queueStateFile,
      status: 'failed',
      pid: 4242,
      startedAt: '2026-05-20T21:00:00.000Z',
      heartbeatAt: '2026-05-20T21:00:30.000Z',
      finishedAt: '2026-05-20T21:02:00.000Z',
      lastError: 'fatal queue error',
      summary: { pending: 3, enriched: 2, errors: 1 },
    });

    const payload = await readJsonArtifact(queueStateFile);
    assert.equal(payload.status, 'failed');
    assert.equal(payload.finishedAt, '2026-05-20T21:02:00.000Z');
    assert.equal(payload.lastError, 'fatal queue error');
  });
  ```

  Run:

  ```bash
  node --test tools/project-memory-context/tests/enrich-queue-driver.test.mjs
  ```

  Expected: FAIL because `writeQueueState` and `finalizeQueueState` are not exported yet.

- [ ] **Step 2: Add queue-state helpers to `enrich-queue.mjs`**

  Near the existing JSON helpers, add a dedicated writer that reuses `saveJson()`:

  ```javascript
  function normalizeQueueState({
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
        pending: summary?.pending ?? 0,
        enriched: summary?.enriched ?? 0,
        errors: summary?.errors ?? 0,
      },
    };
  }

  export async function writeQueueState(input) {
    await saveJson(input.queueStateFile, normalizeQueueState(input));
  }

  export async function finalizeQueueState(input) {
    await writeQueueState(input);
  }
  ```

  Then in `main()` wire the lifecycle:

  ```javascript
  const queueStateFile = resolve(enrichmentDir, 'queue-state.json');
  const startedAt = new Date().toISOString();

  await writeQueueState({
    queueStateFile,
    status: 'running',
    pid: process.pid,
    startedAt,
    heartbeatAt: startedAt,
    summary: buildQueueSummary(worklist),
  });
  ```

  In the `setInterval()` progress block, after computing `done`, `active`, and `remaining`, update the heartbeat:

  ```javascript
  await writeQueueState({
    queueStateFile,
    status: 'running',
    pid: process.pid,
    startedAt,
    heartbeatAt: new Date().toISOString(),
    summary: buildQueueSummary(worklist),
  });
  ```

  At the normal return path, replace the bare JSON summary tail with:

  ```javascript
  const finishedAt = new Date().toISOString();
  await finalizeQueueState({
    queueStateFile,
    status: 'finished',
    pid: process.pid,
    startedAt,
    heartbeatAt: finishedAt,
    finishedAt,
    summary,
  });
  ```

  In the top-level fatal handler, write failed terminal state before exit:

  ```javascript
  main().catch(async (err) => {
    try {
      const summary = Array.isArray(_worklist) ? buildQueueSummary(_worklist) : { pending: 0, enriched: 0, errors: 0 };
      const enrichmentDir = _enrichmentDir || resolve(PROJECT_ROOT, '.planning/project-memory-context/enrichment');
      await finalizeQueueState({
        queueStateFile: resolve(enrichmentDir, 'queue-state.json'),
        status: 'failed',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        lastError: err.message,
        summary,
      });
    } catch {}

    console.error('[fatal]', err.message);
    process.exit(1);
  });
  ```

  Keep the implementation minimal: no lockfiles, no OS process inspection, no retry-policy changes.

- [ ] **Step 3: Run the focused queue test suite**

  Run:

  ```bash
  node --test tools/project-memory-context/tests/enrich-queue-driver.test.mjs
  ```

  Expected: PASS. Existing queue-driver tests still pass and the new queue-state writer tests pass.

---

## Task 3: Integrate, Verify, and Smoke-Test the CLI Contract

**Files:**
- Modify: `tools/project-memory-context/tests/status.test.mjs`
- Modify: `tools/project-memory-context/cli/status.mjs`
- Modify: `tools/project-memory-context/cli/enrich-queue.mjs`

- [ ] **Step 1: Add one integration-level status assertion covering `worklist` + `runtime` together**

  In `tools/project-memory-context/tests/status.test.mjs`, extend the existing structured report test to assert the new fields without breaking the old ones:

  ```javascript
  test('buildStatusReport returns structured status with config, runtime, and worklist', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-status-'));
    const enrichmentDir = join(projectRoot, '.planning', 'project-memory-context', 'enrichment');
    await mkdir(enrichmentDir, { recursive: true });
    await writeFile(join(enrichmentDir, 'worklist.json'), JSON.stringify([{ status: 'pending' }, { status: 'enriched' }]));
    await writeFile(
      join(enrichmentDir, 'queue-state.json'),
      JSON.stringify({
        status: 'running',
        pid: 4242,
        startedAt: '2026-05-20T20:58:00.000Z',
        heartbeatAt: '2026-05-20T20:59:30.000Z',
        finishedAt: null,
        lastError: null,
        summary: { pending: 1, enriched: 1, errors: 0 },
      }),
    );

    const report = await buildStatusReport({ projectRoot, now: '2026-05-20T21:00:00.000Z' });
    assert.equal(report.state, 'running');
    assert.equal(report.worklist.pending, 1);
    assert.equal(report.worklist.enriched, 1);
    assert.equal(report.runtime.pid, 4242);
  });
  ```

  Run:

  ```bash
  node --test tools/project-memory-context/tests/status.test.mjs
  ```

  Expected: PASS.

- [ ] **Step 2: Verify both focused suites together**

  Run:

  ```bash
  node --test tools/project-memory-context/tests/status.test.mjs tools/project-memory-context/tests/enrich-queue-driver.test.mjs
  ```

  Expected: PASS for both files with no regressions.

- [ ] **Step 3: Manual CLI smoke test in the real repo**

  From repo root, run:

  ```bash
  node tools/project-memory-context/cli/status.mjs .
  ```

  Expected JSON now includes:

  ```json
  {
    "state": "running",
    "runtime": {
      "pid": 12345,
      "heartbeatAt": "2026-05-20T21:30:00.000Z",
      "staleAfterSeconds": 90
    }
  }
  ```

  If the queue is not alive, acceptable results are `state: "idle"`, `"finished"`, `"failed"`, or `"stalled"`, but `runtime` must match the queue-state file semantics.

- [ ] **Step 4: Final repo-local verification**

  Run from `tools/project-memory-context`:

  ```bash
  node --test tests/status.test.mjs tests/enrich-queue-driver.test.mjs
  ```

  Expected: PASS. No additional files beyond `status.mjs`, `enrich-queue.mjs`, and their tests are required for this iteration.

## Self-Review Checklist

- Spec coverage: queue heartbeat file, runtime state inference, top-level `state`, `runtime` block, and tests are all covered by Tasks 1-3.
- Placeholder scan: no `TODO`, `TBD`, or implicit “add tests later” steps remain.
- Type consistency: `state` values are consistently `idle`, `running`, `stalled`, `finished`, `failed`; runtime fields use the same names in tests and implementation.
