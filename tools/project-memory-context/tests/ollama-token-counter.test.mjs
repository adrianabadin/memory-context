import test from 'node:test';
import assert from 'node:assert/strict';

import { countPromptTokens, estimateTokens } from '../src/providers/ollama-token-counter.mjs';

test('countPromptTokens returns prompt_eval_count from Ollama response', async () => {
  let capturedRequest;
  const mockFetch = async (url, init) => {
    capturedRequest = { url, body: JSON.parse(init.body) };
    return {
      ok: true,
      async json() {
        return { prompt_eval_count: 42, eval_count: 1 };
      },
    };
  };

  const count = await countPromptTokens({
    baseUrl: 'http://localhost:11434',
    model: 'deepseek-coder:test',
    prompt: 'function foo() {}',
    timeoutMs: 5000,
    fetchImpl: mockFetch,
  });

  assert.equal(count, 42);
  assert.equal(capturedRequest.url, 'http://localhost:11434/api/generate');
  assert.equal(capturedRequest.body.model, 'deepseek-coder:test');
  assert.equal(capturedRequest.body.stream, false);
  assert.equal(capturedRequest.body.options.num_predict, 1);
  assert.equal(capturedRequest.body.prompt, 'function foo() {}');
});

test('countPromptTokens returns null when prompt_eval_count is missing', async () => {
  const mockFetch = async () => ({
    ok: true,
    async json() {
      return { eval_count: 1 }; // no prompt_eval_count
    },
  });

  const count = await countPromptTokens({
    baseUrl: 'http://localhost:11434',
    model: 'deepseek-coder:test',
    prompt: 'hello world',
    timeoutMs: 5000,
    fetchImpl: mockFetch,
  });

  assert.equal(count, null);
});

test('countPromptTokens throws on non-ok HTTP response', async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 500,
    text: async () => 'internal server error',
  });

  await assert.rejects(
    () => countPromptTokens({
      baseUrl: 'http://localhost:11434',
      model: 'deepseek-coder:test',
      prompt: 'hello',
      timeoutMs: 5000,
      fetchImpl: mockFetch,
    }),
    /Ollama token count 500/,
  );
});

test('countPromptTokens throws on network error', async () => {
  const mockFetch = async () => {
    throw new Error('ECONNREFUSED');
  };

  await assert.rejects(
    () => countPromptTokens({
      baseUrl: 'http://localhost:11434',
      model: 'deepseek-coder:test',
      prompt: 'hello',
      timeoutMs: 5000,
      fetchImpl: mockFetch,
    }),
    /ECONNREFUSED/,
  );
});

test('estimateTokens uses chars/4 heuristic', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);       // 4 chars → 1 token
  assert.equal(estimateTokens('abcde'), 2);      // 5 chars → ceil(5/4) = 2
  assert.equal(estimateTokens('a'.repeat(40000)), 10000); // 40000 chars → 10000 tokens
});
