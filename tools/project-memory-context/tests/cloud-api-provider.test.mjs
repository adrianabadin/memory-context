import test from 'node:test';
import assert from 'node:assert/strict';

import { createCloudApiProvider } from '../src/providers/cloud-api-provider.mjs';

test('cloud provider reports not configured when api key env is unset', () => {
  const provider = createCloudApiProvider();

  assert.deepEqual(
    provider.isConfigured({
      config: {
        cloudApi: {
          provider: 'openai-compatible',
          baseUrl: 'https://api.example.test/v1',
          model: 'gpt-test',
          apiKeyEnv: 'PMC_CLOUD_API_KEY',
        },
      },
      env: {},
    }),
    {
      ok: false,
      reason: 'cloud-api requires api key in PMC_CLOUD_API_KEY',
    },
  );
});

test('cloud provider calls chat completions endpoint and extracts content', async () => {
  let request;
  const provider = createCloudApiProvider({
    fetchImpl: async (url, init) => {
      request = { url, init };
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: 'cloud explanation',
                },
              },
            ],
          };
        },
      };
    },
  });

  const result = await provider.enrich(
    { prompt: 'Explain this symbol.', timeoutMs: 5000 },
    {
      config: {
        cloudApi: {
          provider: 'openai-compatible',
          baseUrl: 'https://api.example.test/v1',
          model: 'gpt-test',
          apiKeyEnv: 'PMC_CLOUD_API_KEY',
        },
      },
      env: {
        PMC_CLOUD_API_KEY: 'secret-key',
      },
    },
  );

  assert.equal(request.url, 'https://api.example.test/v1/chat/completions');
  assert.equal(request.init.headers.Authorization, 'Bearer secret-key');
  assert.deepEqual(JSON.parse(request.init.body), {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'Explain this symbol.' }],
  });
  assert.deepEqual(result, {
    content: 'cloud explanation',
    provider: 'openai-compatible',
    model: 'gpt-test',
  });
  assert.ok(request.init.signal);
});

test('cloud provider checks endpoint availability separately', async () => {
  let request;
  const provider = createCloudApiProvider({
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { ok: true };
    },
  });

  const result = await provider.isAvailable({
    config: {
      cloudApi: {
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.test/v1',
        model: 'gpt-test',
        apiKeyEnv: 'PMC_CLOUD_API_KEY',
      },
    },
    env: { PMC_CLOUD_API_KEY: 'secret-key' },
  });

  assert.equal(request.url, 'https://api.example.test/v1/models');
  assert.equal(request.init.headers.Authorization, 'Bearer secret-key');
  assert.deepEqual(result, { ok: true });
});

test('cloud provider availability classifies auth failures', async () => {
  const provider = createCloudApiProvider({
    fetchImpl: async () => {
      throw new Error('401 unauthorized');
    },
  });

  const result = await provider.isAvailable({
    config: {
      cloudApi: {
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.test/v1',
        model: 'gpt-test',
        apiKeyEnv: 'PMC_CLOUD_API_KEY',
      },
    },
    env: { PMC_CLOUD_API_KEY: 'secret-key' },
    request: { timeoutMs: 5000 },
  });

  assert.deepEqual(result, { ok: false, reason: '401 unauthorized', errorType: 'auth' });
});

test('cloud provider availability classifies non-ok probe responses', async () => {
  const provider = createCloudApiProvider({
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      async text() {
        return 'rate limit';
      },
    }),
  });

  const result = await provider.isAvailable({
    config: {
      cloudApi: {
        provider: 'openai-compatible',
        baseUrl: 'https://api.example.test/v1',
        model: 'gpt-test',
        apiKeyEnv: 'PMC_CLOUD_API_KEY',
      },
    },
    env: { PMC_CLOUD_API_KEY: 'secret-key' },
  });

  assert.deepEqual(result, { ok: false, reason: 'openai-compatible 429: rate limit', errorType: 'rate-limit' });
});
