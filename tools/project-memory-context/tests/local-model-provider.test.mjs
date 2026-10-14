import test from 'node:test';
import assert from 'node:assert/strict';

import { createLocalModelProvider } from '../src/providers/local-model-provider.mjs';

test('local provider reports not configured when baseUrl or model is missing', () => {
  const provider = createLocalModelProvider();

  assert.deepEqual(provider.isConfigured({ config: { localModel: { baseUrl: '', model: '' } } }), {
    ok: false,
    reason: 'local-model requires baseUrl and model',
  });
});

test('local provider calls injected fetch and returns content', async () => {
  let request;
  const provider = createLocalModelProvider({
    fetchImpl: async (url, init) => {
      request = { url, init };
      return {
        ok: true,
        async json() {
          return { response: 'structured explanation' };
        },
      };
    },
  });

  const result = await provider.enrich(
    { prompt: 'Explain this symbol.', timeoutMs: 5000 },
    { config: { localModel: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'deepseek' } } },
  );

  assert.equal(request.url, 'http://localhost:11434/api/generate');
  assert.deepEqual(JSON.parse(request.init.body), {
    model: 'deepseek',
    prompt: 'Explain this symbol.',
    stream: false,
    options: { temperature: 0.1, num_predict: 512 },
  });
  assert.deepEqual(result, {
    content: 'structured explanation',
    provider: 'ollama',
    model: 'deepseek',
  });
  assert.ok(request.init.signal);
});

test('local provider checks daemon availability separately', async () => {
  let requestUrl = null;
  const provider = createLocalModelProvider({
    fetchImpl: async (url) => {
      requestUrl = url;
      return { ok: true };
    },
  });

  const result = await provider.isAvailable({
    config: { localModel: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'deepseek' } },
  });

  assert.equal(requestUrl, 'http://localhost:11434/api/tags');
  assert.deepEqual(result, { ok: true });
});

test('local provider availability classifies timeout failures', async () => {
  const provider = createLocalModelProvider({
    fetchImpl: async () => {
      throw new Error('timeout exceeded');
    },
  });

  const result = await provider.isAvailable({
    config: { localModel: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'deepseek' } },
    request: { timeoutMs: 5000 },
  });

  assert.deepEqual(result, { ok: false, reason: 'timeout exceeded', errorType: 'timeout' });
});

test('local provider availability classifies non-ok probe responses', async () => {
  const provider = createLocalModelProvider({
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      async text() {
        return 'unauthorized';
      },
    }),
  });

  const result = await provider.isAvailable({
    config: { localModel: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'deepseek' } },
  });

  assert.deepEqual(result, { ok: false, reason: 'ollama 401: unauthorized', errorType: 'auth' });
});

// ── Structured-output format forwarding (F3 N3, plan 3.3) ────────────────────

const NARRATIVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: { summary: { type: 'string' } },
};

test('local provider forwards an explicit JSON schema format for structured-output requests', async () => {
  let request;
  const provider = createLocalModelProvider({
    fetchImpl: async (url, init) => {
      request = { url, init };
      return {
        ok: true,
        async json() {
          return { response: '{"summary":"ok"}' };
        },
      };
    },
  });

  const result = await provider.enrich(
    { prompt: 'Explain this symbol.', timeoutMs: 5000, format: NARRATIVE_SCHEMA },
    { config: { localModel: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'deepseek' } } },
  );

  const body = JSON.parse(request.init.body);
  assert.deepEqual(body.format, NARRATIVE_SCHEMA, 'the schema must be forwarded as Ollama format');
  assert.equal(body.prompt, 'Explain this symbol.');
  assert.equal(body.stream, false);
  assert.deepEqual(body.options, { temperature: 0.1, num_predict: 512 });
  assert.deepEqual(result, { content: '{"summary":"ok"}', provider: 'ollama', model: 'deepseek' });
});

test('local provider omits the format key entirely for legacy text requests', async () => {
  let body;
  const provider = createLocalModelProvider({
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        async json() {
          return { response: 'legacy text' };
        },
      };
    },
  });

  await provider.enrich(
    { prompt: 'Explain this symbol.', timeoutMs: 5000 },
    { config: { localModel: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'deepseek' } } },
  );

  assert.ok(!('format' in body), 'legacy requests must not carry a format key');
});

test('local provider rejects unsupported explicit format values instead of silently succeeding', async () => {
  for (const format of ['yaml', 42, ['json'], null]) {
    let fetchCalled = false;
    const provider = createLocalModelProvider({
      fetchImpl: async () => {
        fetchCalled = true;
        return { ok: true, async json() { return { response: 'should not happen' }; } };
      },
    });

    await assert.rejects(
      provider.enrich(
        { prompt: 'Explain this symbol.', format },
        { config: { localModel: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'deepseek' } } },
      ),
      /unsupported format/,
      `format ${JSON.stringify(format)} must be rejected`,
    );
    assert.equal(fetchCalled, false, 'rejection must happen before any request is sent');
  }
});

test('local provider rejects an invalid context instead of returning success', async () => {
  let fetchCalled = false;
  const provider = createLocalModelProvider({
    fetchImpl: async () => {
      fetchCalled = true;
      return { ok: true, async json() { return { response: 'should not happen' }; } };
    },
  });

  await assert.rejects(
    provider.enrich({ prompt: 'Explain this symbol.' }, { config: { localModel: {} } }),
    /baseUrl and model/,
  );
  assert.equal(fetchCalled, false, 'invalid context must fail before any request is sent');
});
