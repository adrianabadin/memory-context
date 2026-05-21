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