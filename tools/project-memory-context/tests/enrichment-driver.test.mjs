import test from 'node:test';
import assert from 'node:assert/strict';

import { runEnrichmentWithFallback } from '../src/enrichment-driver.mjs';

test('runEnrichmentWithFallback returns the first successful configured provider', async () => {
  const localProvider = {
    kind: 'local-model',
    isConfigured() {
      return { ok: true };
    },
    async isAvailable() {
      return { ok: true };
    },
    async enrich() {
      return { content: 'local content', provider: 'ollama', model: 'deepseek' };
    },
  };

  const result = await runEnrichmentWithFallback({
    request: { prompt: 'Explain this symbol.' },
    config: { preferredModes: ['local-model', 'cloud-api'] },
    providers: [localProvider],
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.mode, 'local-model');
  assert.equal(result.provider, 'ollama');
  assert.equal(result.model, 'deepseek');
  assert.deepEqual(result.attempts.map((attempt) => attempt.status), ['succeeded']);
});

test('runEnrichmentWithFallback falls back when the first provider fails', async () => {
  const localProvider = {
    kind: 'local-model',
    isConfigured() {
      return { ok: true };
    },
    async isAvailable() {
      return { ok: true };
    },
    async enrich() {
      throw new Error('ECONNREFUSED');
    },
  };
  const cloudProvider = {
    kind: 'cloud-api',
    isConfigured() {
      return { ok: true };
    },
    async isAvailable() {
      return { ok: true };
    },
    async enrich() {
      return { content: 'cloud content', provider: 'openai-compatible', model: 'gpt-test' };
    },
  };

  const result = await runEnrichmentWithFallback({
    request: { prompt: 'Explain this symbol.' },
    config: { preferredModes: ['local-model', 'cloud-api'] },
    providers: [localProvider, cloudProvider],
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.mode, 'cloud-api');
  assert.equal(result.provider, 'openai-compatible');
  assert.deepEqual(
    result.attempts.map((attempt) => ({ mode: attempt.mode, status: attempt.status, errorType: attempt.errorType ?? null })),
    [
      { mode: 'local-model', status: 'failed', errorType: 'network' },
      { mode: 'cloud-api', status: 'succeeded', errorType: null },
    ],
  );
});

test('runEnrichmentWithFallback skips unavailable providers', async () => {
  const localProvider = {
    kind: 'local-model',
    isConfigured() {
      return { ok: true };
    },
    async isAvailable() {
      return { ok: false, reason: 'daemon offline', errorType: 'network' };
    },
    async enrich() {
      throw new Error('should not be called');
    },
  };
  const cloudProvider = {
    kind: 'cloud-api',
    isConfigured() {
      return { ok: true };
    },
    async isAvailable() {
      return { ok: true };
    },
    async enrich() {
      return { content: 'cloud content', provider: 'openai-compatible', model: 'gpt-test' };
    },
  };

  const result = await runEnrichmentWithFallback({
    request: { prompt: 'Explain this symbol.' },
    config: { preferredModes: ['local-model', 'cloud-api'] },
    providers: [localProvider, cloudProvider],
  });

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(
    result.attempts.map((attempt) => ({ mode: attempt.mode, status: attempt.status, errorType: attempt.errorType })),
    [
      { mode: 'local-model', status: 'skipped', errorType: 'network' },
      { mode: 'cloud-api', status: 'succeeded', errorType: undefined },
    ],
  );
});

test('runEnrichmentWithFallback returns an error result when all providers fail', async () => {
  const localProvider = {
    kind: 'local-model',
    isConfigured() {
      return { ok: true };
    },
    async isAvailable() {
      return { ok: true };
    },
    async enrich() {
      throw new Error('timeout exceeded');
    },
  };
  const cloudProvider = {
    kind: 'cloud-api',
    isConfigured() {
      return { ok: true };
    },
    async isAvailable() {
      return { ok: true };
    },
    async enrich() {
      throw new Error('429 rate limit');
    },
  };

  const result = await runEnrichmentWithFallback({
    request: { prompt: 'Explain this symbol.' },
    config: { preferredModes: ['local-model', 'cloud-api'] },
    providers: [localProvider, cloudProvider],
  });

  assert.equal(result.status, 'error');
  assert.equal(result.content, null);
  assert.equal(result.mode, null);
  assert.equal(result.provider, null);
  assert.equal(result.model, null);
  assert.deepEqual(
    result.attempts.map((attempt) => attempt.errorType),
    ['timeout', 'rate-limit'],
  );
});

test('runEnrichmentWithFallback stops on non-fallback runtime errors', async () => {
  let cloudCalled = false;
  const localProvider = {
    kind: 'local-model',
    isConfigured() {
      return { ok: true };
    },
    async isAvailable() {
      return { ok: true };
    },
    async enrich() {
      throw new Error('unexpected runtime crash');
    },
  };
  const cloudProvider = {
    kind: 'cloud-api',
    isConfigured() {
      return { ok: true };
    },
    async isAvailable() {
      return { ok: true };
    },
    async enrich() {
      cloudCalled = true;
      return { content: 'cloud content', provider: 'openai-compatible', model: 'gpt-test' };
    },
  };

  const result = await runEnrichmentWithFallback({
    request: { prompt: 'Explain this symbol.' },
    config: { preferredModes: ['local-model', 'cloud-api'] },
    providers: [localProvider, cloudProvider],
  });

  assert.equal(result.status, 'error');
  assert.equal(cloudCalled, false);
  assert.deepEqual(
    result.attempts.map((attempt) => ({ mode: attempt.mode, status: attempt.status, errorType: attempt.errorType })),
    [{ mode: 'local-model', status: 'failed', errorType: 'runtime' }],
  );
});

test('runEnrichmentWithFallback falls back on provider http failures', async () => {
  const localProvider = {
    kind: 'local-model',
    isConfigured() {
      return { ok: true };
    },
    async isAvailable() {
      return { ok: true };
    },
    async enrich() {
      throw new Error('Ollama 500: internal error');
    },
  };
  const cloudProvider = {
    kind: 'cloud-api',
    isConfigured() {
      return { ok: true };
    },
    async isAvailable() {
      return { ok: true };
    },
    async enrich() {
      return { content: 'cloud content', provider: 'openai-compatible', model: 'gpt-test' };
    },
  };

  const result = await runEnrichmentWithFallback({
    request: { prompt: 'Explain this symbol.' },
    config: { preferredModes: ['local-model', 'cloud-api'] },
    providers: [localProvider, cloudProvider],
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.mode, 'cloud-api');
  assert.deepEqual(result.attempts.map((attempt) => attempt.errorType), ['provider', undefined]);
});

test('runEnrichmentWithFallback records thrown availability checks and continues on network errors', async () => {
  const localProvider = {
    kind: 'local-model',
    isConfigured() {
      return { ok: true };
    },
    async isAvailable() {
      throw new Error('ECONNREFUSED');
    },
    async enrich() {
      throw new Error('should not be called');
    },
  };
  const cloudProvider = {
    kind: 'cloud-api',
    isConfigured() {
      return { ok: true };
    },
    async isAvailable() {
      return { ok: true };
    },
    async enrich() {
      return { content: 'cloud content', provider: 'openai-compatible', model: 'gpt-test' };
    },
  };

  const result = await runEnrichmentWithFallback({
    request: { prompt: 'Explain this symbol.' },
    config: { preferredModes: ['local-model', 'cloud-api'] },
    providers: [localProvider, cloudProvider],
  });

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.attempts.map((attempt) => attempt.errorType), ['network', undefined]);
});

test('runEnrichmentWithFallback stops when availability returns a fatal runtime classification', async () => {
  let cloudCalled = false;
  const localProvider = {
    kind: 'local-model',
    isConfigured() {
      return { ok: true };
    },
    async isAvailable() {
      return { ok: false, reason: 'bad runtime state', errorType: 'runtime' };
    },
    async enrich() {
      throw new Error('should not be called');
    },
  };
  const cloudProvider = {
    kind: 'cloud-api',
    isConfigured() {
      return { ok: true };
    },
    async isAvailable() {
      return { ok: true };
    },
    async enrich() {
      cloudCalled = true;
      return { content: 'cloud content', provider: 'openai-compatible', model: 'gpt-test' };
    },
  };

  const result = await runEnrichmentWithFallback({
    request: { prompt: 'Explain this symbol.' },
    config: { preferredModes: ['local-model', 'cloud-api'] },
    providers: [localProvider, cloudProvider],
  });

  assert.equal(result.status, 'error');
  assert.equal(cloudCalled, false);
  assert.deepEqual(result.attempts.map((attempt) => attempt.errorType), ['runtime']);
});
