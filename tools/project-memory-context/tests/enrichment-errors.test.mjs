import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyEnrichmentError } from '../src/enrichment-errors.mjs';

test('classifyEnrichmentError recognizes known failure types', () => {
  assert.equal(classifyEnrichmentError(new Error('401 unauthorized')).type, 'auth');
  assert.equal(classifyEnrichmentError(new Error('429 rate limit')).type, 'rate-limit');
  assert.equal(classifyEnrichmentError(new Error('Ollama 500: internal error')).type, 'provider');
  assert.equal(classifyEnrichmentError(new Error('openai-compatible 404: model missing')).type, 'provider');
  assert.equal(classifyEnrichmentError(new Error('ECONNREFUSED')).type, 'network');
  assert.equal(classifyEnrichmentError(new Error('ENOTFOUND api.example.test')).type, 'network');
  assert.equal(classifyEnrichmentError(new Error('socket hang up')).type, 'network');
  assert.equal(classifyEnrichmentError(new Error('timeout exceeded')).type, 'timeout');
  assert.equal(classifyEnrichmentError(new Error('provider unavailable')).type, 'provider');
  assert.equal(classifyEnrichmentError(new Error('bad config')).type, 'config');
});
