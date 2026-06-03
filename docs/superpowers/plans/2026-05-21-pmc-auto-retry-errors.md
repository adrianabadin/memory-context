# PMC Auto Retry Errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PMC auto-launch background retry processing after `enrich-queue` finishes with errors, and make `retry-errors` retry unique symbols for up to 5 iterations with a per-symbol report.

**Architecture:** Keep `retry-errors` as its own CLI entrypoint, but move its core loop into reusable helper functions so it can aggregate historical failures per `symbolKey`, write `retry-state.json`, and stop after 5 iterations. Extend `enrich-queue` with a small background-launch helper that checks retry state before spawning a detached retry process and writing retry logs.

**Tech Stack:** Node.js ESM, `node:test`, `fs/promises`, `child_process`, PMC CLI modules under `tools/project-memory-context/`

---

## File Map

- Create: `tools/project-memory-context/src/retry-errors-runner.mjs`
  Responsibility: pure-ish retry orchestration helpers for grouping error symbols, building aggregated report rows, normalizing retry runtime state, and running a bounded retry loop.

- Create: `tools/project-memory-context/tests/retry-errors-runner.test.mjs`
  Responsibility: unit coverage for symbol dedupe, previous-error aggregation, retry-state normalization, and stop-after-5-iterations behavior.

- Modify: `tools/project-memory-context/cli/retry-errors.mjs`
  Responsibility: thin CLI wrapper that parses args, resolves config/providers, writes `retry-state.json`, delegates to the retry runner, and prints the final JSON summary.

- Modify: `tools/project-memory-context/cli/enrich-queue.mjs`
  Responsibility: after normal queue finalization, detect remaining errors, skip launch if retry is already active, otherwise spawn detached `retry-errors` with stdout/stderr redirected to retry log files.

- Modify: `tools/project-memory-context/tests/enrich-queue-driver.test.mjs`
  Responsibility: verify retry auto-launch decisions and launch argument construction without spawning real background processes.

- Modify: `tools/project-memory-context/templates/opencode/commands/retry-errors.md`
  Responsibility: update the command description so it matches the new fallback-chain behavior and background-oriented workflow.

### Task 1: Build Retry Runner Primitives

**Files:**
- Create: `tools/project-memory-context/src/retry-errors-runner.mjs`
- Test: `tools/project-memory-context/tests/retry-errors-runner.test.mjs`

- [ ] **Step 1: Write the failing tests for symbol dedupe, aggregated previous errors, and retry-state normalization**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_RETRY_ITERATIONS,
  collectRetryCandidates,
  buildRetryState,
} from '../src/retry-errors-runner.mjs';

test('collectRetryCandidates collapses duplicate error symbols into one retry unit', () => {
  const worklist = [
    {
      symbolKey: 'ts|src/a.ts|function|exported|loadA|1',
      name: 'loadA',
      filePath: 'src/a.ts',
      kind: 'function',
      language: 'ts',
      status: 'error',
      error: 'request timed out',
      attempts: [
        {
          mode: 'local-model',
          provider: 'ollama',
          status: 'failed',
          errorType: 'timeout',
          errorMessage: 'request timed out',
          endedAt: '2026-05-21T10:00:00.000Z',
        },
      ],
    },
    {
      symbolKey: 'ts|src/a.ts|function|exported|loadA|1',
      name: 'loadA',
      filePath: 'src/a.ts',
      kind: 'function',
      language: 'ts',
      status: 'error',
      error: 'missing API key',
      attempts: [
        {
          mode: 'cloud-api',
          provider: 'openai-compatible',
          status: 'failed',
          errorType: 'auth',
          errorMessage: 'missing API key',
          endedAt: '2026-05-21T10:05:00.000Z',
        },
      ],
    },
  ];

  const candidates = collectRetryCandidates(worklist);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].symbolKey, 'ts|src/a.ts|function|exported|loadA|1');
  assert.equal(candidates[0].previousErrors.length, 2);
  assert.deepEqual(candidates[0].previousErrors.map((item) => item.message), [
    'request timed out',
    'missing API key',
  ]);
});

test('buildRetryState fills default fields for active retry runtime', () => {
  const state = buildRetryState({
    status: 'running',
    pid: 5150,
    projectRoot: '/repo',
    startedAt: '2026-05-21T12:00:00.000Z',
    heartbeatAt: '2026-05-21T12:01:00.000Z',
  });

  assert.equal(state.status, 'running');
  assert.equal(state.pid, 5150);
  assert.equal(state.projectRoot, '/repo');
  assert.equal(state.finishedAt, null);
  assert.equal(state.lastError, null);
  assert.equal(MAX_RETRY_ITERATIONS, 5);
});
```

- [ ] **Step 2: Run the new test file and verify it fails because the runner module does not exist yet**

Run: `node --test tools/project-memory-context/tests/retry-errors-runner.test.mjs`
Expected: FAIL with `Cannot find module '../src/retry-errors-runner.mjs'`

- [ ] **Step 3: Write the minimal retry runner primitives**

```js
export const MAX_RETRY_ITERATIONS = 5;

function collectPreviousErrors(entry) {
  const fromAttempts = (entry.attempts ?? [])
    .filter((attempt) => attempt.status === 'failed' && attempt.errorMessage)
    .map((attempt) => ({
      provider: attempt.provider ?? null,
      errorType: attempt.errorType ?? null,
      message: attempt.errorMessage,
      failedAt: attempt.endedAt ?? attempt.startedAt ?? null,
    }));

  if (fromAttempts.length > 0) {
    return fromAttempts;
  }

  return entry.error
    ? [{ provider: null, errorType: null, message: entry.error, failedAt: entry.failedAt ?? null }]
    : [];
}

export function collectRetryCandidates(worklist) {
  const bySymbol = new Map();

  for (const entry of worklist) {
    if (entry.status !== 'error') continue;
    const existing = bySymbol.get(entry.symbolKey);
    const previousErrors = collectPreviousErrors(entry);

    if (!existing) {
      bySymbol.set(entry.symbolKey, {
        ...entry,
        previousErrors: [...previousErrors],
      });
      continue;
    }

    existing.previousErrors.push(...previousErrors);
    if ((entry.attempts?.length ?? 0) >= (existing.attempts?.length ?? 0)) {
      Object.assign(existing, entry, { previousErrors: existing.previousErrors });
    }
  }

  return [...bySymbol.values()];
}

export function buildRetryState({ status, pid, projectRoot, startedAt, heartbeatAt, finishedAt = null, lastError = null }) {
  return {
    status,
    pid,
    projectRoot,
    startedAt,
    heartbeatAt,
    finishedAt,
    lastError,
  };
}
```

- [ ] **Step 4: Run the test again and verify the new primitives pass**

Run: `node --test tools/project-memory-context/tests/retry-errors-runner.test.mjs`
Expected: PASS with 2 passing tests

- [ ] **Step 5: Commit the primitives before moving into the iterative retry loop**

```bash
git add tools/project-memory-context/src/retry-errors-runner.mjs tools/project-memory-context/tests/retry-errors-runner.test.mjs
git commit -m "feat(pmc): add retry runner primitives"
```

### Task 2: Refactor `retry-errors` Into A 5-Iteration Per-Symbol Loop

**Files:**
- Modify: `tools/project-memory-context/src/retry-errors-runner.mjs`
- Modify: `tools/project-memory-context/cli/retry-errors.mjs`
- Test: `tools/project-memory-context/tests/retry-errors-runner.test.mjs`

- [ ] **Step 1: Add failing tests for iterative retries, early exit on success, and stop-after-5 behavior**

```js
import {
  MAX_RETRY_ITERATIONS,
  runRetryLoop,
} from '../src/retry-errors-runner.mjs';

test('runRetryLoop retries each symbol once per iteration and stops after recovery', async () => {
  const attemptCounts = new Map();
  const worklist = [
    {
      symbolKey: 'ts|src/a.ts|function|exported|loadA|1',
      name: 'loadA',
      filePath: 'src/a.ts',
      kind: 'function',
      language: 'ts',
      status: 'error',
      attempts: [],
      range: { startLine: 1, endLine: 2 },
    },
  ];

  const result = await runRetryLoop({
    worklist,
    maxIterations: MAX_RETRY_ITERATIONS,
    retrySymbol: async (symbol, iteration) => {
      attemptCounts.set(symbol.symbolKey, (attemptCounts.get(symbol.symbolKey) ?? 0) + 1);
      if (iteration === 1) {
        return { status: 'failed', elapsedMs: 10, attempts: [], failureReason: 'still failing' };
      }
      symbol.status = 'enriched';
      symbol.memoryId = 'queue-loadA';
      return { status: 'succeeded', elapsedMs: 10, attempts: [], contentPreview: 'Recovered' };
    },
  });

  assert.equal(attemptCounts.get('ts|src/a.ts|function|exported|loadA|1'), 2);
  assert.equal(result.summary.symbolsRecovered, 1);
  assert.equal(result.summary.symbolsStillFailing, 0);
  assert.equal(result.iterations, 2);
});

test('runRetryLoop stops at the max iteration cap and leaves remaining symbols failing', async () => {
  const worklist = [
    {
      symbolKey: 'ts|src/b.ts|function|exported|loadB|1',
      name: 'loadB',
      filePath: 'src/b.ts',
      kind: 'function',
      language: 'ts',
      status: 'error',
      attempts: [],
      range: { startLine: 1, endLine: 2 },
    },
  ];

  const result = await runRetryLoop({
    worklist,
    maxIterations: MAX_RETRY_ITERATIONS,
    retrySymbol: async () => ({ status: 'failed', elapsedMs: 10, attempts: [], failureReason: 'permanent failure' }),
  });

  assert.equal(result.iterations, MAX_RETRY_ITERATIONS);
  assert.equal(result.summary.maxIterationsReached, true);
  assert.equal(result.summary.symbolsStillFailing, 1);
});
```

- [ ] **Step 2: Run the retry runner tests and verify they fail because `runRetryLoop` is missing**

Run: `node --test tools/project-memory-context/tests/retry-errors-runner.test.mjs`
Expected: FAIL with `runRetryLoop is not a function`

- [ ] **Step 3: Implement the iterative loop in the runner and wire the CLI to use it with normal fallback config**

```js
export async function runRetryLoop({
  worklist,
  maxIterations = MAX_RETRY_ITERATIONS,
  retrySymbol,
}) {
  const reportBySymbol = new Map(
    collectRetryCandidates(worklist).map((candidate) => [
      candidate.symbolKey,
      {
        symbolKey: candidate.symbolKey,
        name: candidate.name,
        filePath: candidate.filePath,
        kind: candidate.kind,
        language: candidate.language,
        previousErrors: candidate.previousErrors,
        iterationResults: [],
        finalStatus: 'error',
        memoryId: null,
        contentPreview: null,
      },
    ]),
  );

  let iterations = 0;

  while (iterations < maxIterations) {
    const currentCandidates = collectRetryCandidates(worklist);
    if (currentCandidates.length === 0) break;

    iterations += 1;
    for (const symbol of currentCandidates) {
      const outcome = await retrySymbol(symbol, iterations);
      const reportEntry = reportBySymbol.get(symbol.symbolKey);
      reportEntry.iterationResults.push({ iteration: iterations, ...outcome });
      reportEntry.finalStatus = outcome.status === 'succeeded' ? 'enriched' : 'error';
      reportEntry.memoryId = outcome.memoryId ?? reportEntry.memoryId;
      reportEntry.contentPreview = outcome.contentPreview ?? reportEntry.contentPreview;
    }
  }

  const symbols = [...reportBySymbol.values()];
  const symbolsRecovered = symbols.filter((item) => item.finalStatus === 'enriched').length;
  const symbolsStillFailing = symbols.length - symbolsRecovered;

  return {
    iterations,
    symbols,
    summary: {
      symbolsRetried: symbols.length,
      symbolsRecovered,
      symbolsStillFailing,
      maxIterationsReached: symbolsStillFailing > 0 && iterations === maxIterations,
    },
  };
}
```

```js
// retry-errors.mjs
const report = await runRetryLoop({
  worklist,
  maxIterations: MAX_RETRY_ITERATIONS,
  retrySymbol: async (entry, iteration) => {
    const prompt = await buildSymbolPrompt(entry, projectRoot);
    const result = await runEnrichmentWithFallback({
      request: { prompt, timeoutMs: args.timeoutMs },
      config,
      providers,
      env: process.env,
    });

    // keep the existing persistence behavior here:
    // update worklist/symbol-index, append sync entry on success,
    // preserve attempts on failure, and return one iteration outcome
    return persistRetryOutcome({ entry, result, iteration, worklist, symbolIndex });
  },
});
```

Remove the line that forces Ollama-only mode:

```js
// delete this old behavior
config.preferredModes = ['local-model'];
```

Keep provider creation aligned with the normal queue fallback chain.

- [ ] **Step 4: Run the retry runner tests and verify iterative behavior now passes**

Run: `node --test tools/project-memory-context/tests/retry-errors-runner.test.mjs`
Expected: PASS with the new loop tests and the original primitive tests all green

- [ ] **Step 5: Commit the retry loop refactor**

```bash
git add tools/project-memory-context/src/retry-errors-runner.mjs tools/project-memory-context/cli/retry-errors.mjs tools/project-memory-context/tests/retry-errors-runner.test.mjs
git commit -m "feat(pmc): add iterative retry loop"
```

### Task 3: Auto-Launch Retry In Background From `enrich-queue`

**Files:**
- Modify: `tools/project-memory-context/cli/enrich-queue.mjs`
- Modify: `tools/project-memory-context/tests/enrich-queue-driver.test.mjs`

- [ ] **Step 1: Add failing tests for launch gating and detached retry spawn arguments**

```js
import {
  maybeLaunchRetryErrors,
} from '../cli/enrich-queue.mjs';

test('maybeLaunchRetryErrors skips spawn when retry state is already running', async () => {
  const launches = [];

  const result = await maybeLaunchRetryErrors({
    projectRoot: '/repo',
    enrichmentDir: '/repo/.planning/project-memory-context/enrichment',
    summary: { errors: 3 },
    loadRetryState: async () => ({ status: 'running', pid: 4242, heartbeatAt: '2026-05-21T12:00:00.000Z' }),
    spawnRetryProcess: async (spec) => { launches.push(spec); },
  });

  assert.equal(result.launched, false);
  assert.equal(result.reason, 'already-running');
  assert.equal(launches.length, 0);
});

test('maybeLaunchRetryErrors spawns detached retry when errors remain and no retry is active', async () => {
  const launches = [];

  const result = await maybeLaunchRetryErrors({
    projectRoot: '/repo',
    enrichmentDir: '/repo/.planning/project-memory-context/enrichment',
    summary: { errors: 2 },
    loadRetryState: async () => null,
    spawnRetryProcess: async (spec) => { launches.push(spec); },
  });

  assert.equal(result.launched, true);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].scriptPath.endsWith('retry-errors.mjs'), true);
  assert.equal(launches[0].stdoutPath.endsWith('retry-stdout.log'), true);
  assert.equal(launches[0].stderrPath.endsWith('retry-stderr.log'), true);
});
```

- [ ] **Step 2: Run the enrich queue driver tests and verify they fail because the helper is missing**

Run: `node --test tools/project-memory-context/tests/enrich-queue-driver.test.mjs`
Expected: FAIL with `maybeLaunchRetryErrors is not a function`

- [ ] **Step 3: Implement background launch helpers and call them after queue finalization**

```js
import { open } from 'node:fs/promises';
import { spawn } from 'node:child_process';

export async function maybeLaunchRetryErrors({
  projectRoot,
  enrichmentDir,
  summary,
  loadRetryState = async () => null,
  spawnRetryProcess = launchRetryProcess,
}) {
  if ((summary?.errors ?? 0) === 0) {
    return { launched: false, reason: 'no-errors' };
  }

  const retryState = await loadRetryState();
  if (retryState?.status === 'running') {
    return { launched: false, reason: 'already-running', retryState };
  }

  const scriptPath = resolve(PROJECT_ROOT, 'tools/project-memory-context/cli/retry-errors.mjs');
  const stdoutPath = resolve(enrichmentDir, 'retry-stdout.log');
  const stderrPath = resolve(enrichmentDir, 'retry-stderr.log');

  await spawnRetryProcess({ projectRoot, scriptPath, stdoutPath, stderrPath });
  return { launched: true, reason: 'spawned', stdoutPath, stderrPath };
}

async function launchRetryProcess({ projectRoot, scriptPath, stdoutPath, stderrPath }) {
  const stdout = await open(stdoutPath, 'a');
  const stderr = await open(stderrPath, 'a');
  const child = spawn(process.execPath, [scriptPath, projectRoot, '--concurrency', '1', '--timeout', String(TIMEOUT_MS)], {
    detached: true,
    stdio: ['ignore', stdout.fd, stderr.fd],
  });
  child.unref();
}
```

Call it after queue state is finalized:

```js
const retryLaunch = await maybeLaunchRetryErrors({
  projectRoot: PROJECT_ROOT,
  enrichmentDir,
  summary,
  loadRetryState: async () => loadOptionalJson(resolve(enrichmentDir, 'retry-state.json')),
});

if (retryLaunch.launched) {
  console.error(`[queue] Auto-launched retry-errors in background -> ${retryLaunch.stdoutPath}`);
} else if (retryLaunch.reason === 'already-running') {
  console.error('[queue] Retry-errors already running; skipping second launch');
}
```

- [ ] **Step 4: Run the queue driver tests and verify the new launch decisions pass together with the existing queue tests**

Run: `node --test tools/project-memory-context/tests/enrich-queue-driver.test.mjs`
Expected: PASS with both the original queue tests and the new retry launch tests green

- [ ] **Step 5: Commit the background auto-launch work**

```bash
git add tools/project-memory-context/cli/enrich-queue.mjs tools/project-memory-context/tests/enrich-queue-driver.test.mjs
git commit -m "feat(pmc): auto-launch retry errors"
```

### Task 4: Align The Slash Command Template With The New Behavior

**Files:**
- Modify: `tools/project-memory-context/templates/opencode/commands/retry-errors.md`

- [ ] **Step 1: Update the command description and execution text so it no longer claims Ollama-only behavior**

````md
---
name: retry-errors
description: Re-enrich symbols still in error status through PMC's fallback chain, with a per-symbol report.
argument-hint: "[--limit N] [--model MODEL] [--concurrency N] [--timeout MS]"
allowed-tools:
  - Bash
---

<objective>
Retry enrichment for symbols currently in error status, deduped by symbol, while preserving a per-symbol report of previous failures and retry outcomes.
</objective>

<execution>
Run:

```bash
{{PMC_BIN}} retry-errors . --concurrency 1 --timeout 300000
```

The command reads the worklist, retries each unique `symbolKey` through the configured fallback chain (`local-model -> cloud-api -> agent-subagent`), and stops when all symbols recover or 5 iterations complete.
</execution>
````

- [ ] **Step 2: Run the package test suite as a regression check for the CLI and template changes**

Run: `npm test`
Workdir: `tools/project-memory-context`
Expected: PASS with all `tests/*.test.mjs` green

- [ ] **Step 3: Inspect the generated diff to verify the command copy matches the implementation**

Run: `git diff -- tools/project-memory-context/templates/opencode/commands/retry-errors.md tools/project-memory-context/cli/retry-errors.mjs tools/project-memory-context/cli/enrich-queue.mjs`
Expected: the template mentions fallback-chain retries and the code shows background auto-launch plus 5-iteration behavior

- [ ] **Step 4: Commit the docs/template alignment**

```bash
git add tools/project-memory-context/templates/opencode/commands/retry-errors.md
git commit -m "docs(pmc): update retry errors command"
```

## Self-Review Checklist

- Spec coverage: this plan covers background launch, process dedupe, symbol dedupe, per-symbol report aggregation, 5-iteration cap, and explicit reporting of unresolved errors.
- Placeholder scan: no `TODO`, `TBD`, or vague "handle edge cases" steps remain.
- Type consistency: the plan consistently uses `symbolKey`, `retry-state.json`, `MAX_RETRY_ITERATIONS`, `collectRetryCandidates()`, `runRetryLoop()`, and `maybeLaunchRetryErrors()`.
