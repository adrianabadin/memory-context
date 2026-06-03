import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDefaultEnrichmentConfig, mergeEnrichmentConfig } from '../cli/new-project.mjs';

test('buildDefaultEnrichmentConfig includes the 3 fallback modes and provider defaults', () => {
  const result = buildDefaultEnrichmentConfig();

  assert.deepEqual(result.preferredModes, ['local-model', 'cloud-api', 'agent-subagent']);
  assert.deepEqual(result.localModel, {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'deepseek-coder-v2:16b-ctx32k',
  });
  assert.deepEqual(result.cloudApi, {
    provider: 'openai-compatible',
    baseUrl: '',
    model: '',
    apiKeyEnv: 'PMC_CLOUD_API_KEY',
  });
  assert.deepEqual(result.agentSubagent, {
    enabled: true,
    agentName: 'enrich',
  });
  assert.equal(result.subagentTokenThreshold, 10000);
});

test('mergeEnrichmentConfig backfills missing fallback settings into partial configs', () => {
  const result = mergeEnrichmentConfig({
    localModel: {
      model: 'custom-model',
    },
  });

  assert.deepEqual(result.preferredModes, ['local-model', 'cloud-api', 'agent-subagent']);
  assert.equal(result.localModel.model, 'custom-model');
  assert.equal(result.localModel.baseUrl, 'http://localhost:11434');
  assert.deepEqual(result.cloudApi, {
    provider: 'openai-compatible',
    baseUrl: '',
    model: '',
    apiKeyEnv: 'PMC_CLOUD_API_KEY',
  });
  assert.deepEqual(result.agentSubagent, {
    enabled: true,
    agentName: 'enrich',
  });
});

test('mergeEnrichmentConfig preserves legacy nested enrichment config shape', () => {
  const result = mergeEnrichmentConfig({
    enrichment: {
      cloudApi: {
        model: 'gpt-legacy',
      },
    },
  });

  assert.equal(result.cloudApi.model, 'gpt-legacy');
  assert.deepEqual(result.preferredModes, ['local-model', 'cloud-api', 'agent-subagent']);
});

test('new-project.mjs re-exports config helpers from bootstrap for backward compat', async () => {
  const mod = await import('../cli/new-project.mjs');
  assert.equal(typeof mod.buildDefaultEnrichmentConfig, 'function');
  assert.equal(typeof mod.mergeEnrichmentConfig, 'function');

  const config = mod.buildDefaultEnrichmentConfig();
  assert.deepEqual(config.preferredModes, ['local-model', 'cloud-api', 'agent-subagent']);
  assert.equal(config.localModel.provider, 'ollama');
});
