import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PMC_ENRICHMENT_CONFIG_FILE,
  resolveEnrichmentConfig,
  resolveEnrichmentConfigPaths,
} from '../src/enrichment-config.mjs';

test('resolveEnrichmentConfig applies defaults', () => {
  const result = resolveEnrichmentConfig({ projectConfig: null, globalConfig: null, env: {} });

  assert.deepEqual(result.preferredModes, ['local-model', 'cloud-api', 'agent-subagent']);
  assert.equal(result.localModel.provider, 'ollama');
  assert.equal(result.subagentTokenThreshold, 5000);
  assert.equal(result.fileCoverageThreshold, 0.8);
});

test('resolveEnrichmentConfig lets project override global', () => {
  const result = resolveEnrichmentConfig({
    globalConfig: { enrichment: { localModel: { model: 'global-model' } } },
    projectConfig: { enrichment: { localModel: { model: 'project-model' } } },
    env: {},
  });

  assert.equal(result.localModel.model, 'project-model');
});

test('resolveEnrichmentConfig lets env override explicit fields', () => {
  const result = resolveEnrichmentConfig({
    projectConfig: null,
    globalConfig: null,
    env: {
      PMC_ENRICHMENT_PREFERRED_MODES: 'cloud-api,agent-subagent',
      PMC_LOCAL_MODEL_BASE_URL: 'http://remote-ollama:11434',
      PMC_LOCAL_MODEL_NAME: 'qwen3-coder:30b',
      PMC_CLOUD_API_BASE_URL: 'https://api.example.test/v1',
      PMC_CLOUD_API_MODEL: 'gpt-test',
      PMC_CLOUD_API_KEY_ENV: 'CUSTOM_KEY_ENV',
      PMC_AGENT_SUBAGENT_NAME: 'custom-enrich',
    },
  });

  assert.deepEqual(result.preferredModes, ['cloud-api', 'agent-subagent']);
  assert.equal(result.localModel.baseUrl, 'http://remote-ollama:11434');
  assert.equal(result.localModel.model, 'qwen3-coder:30b');
  assert.equal(result.cloudApi.baseUrl, 'https://api.example.test/v1');
  assert.equal(result.cloudApi.model, 'gpt-test');
  assert.equal(result.cloudApi.apiKeyEnv, 'CUSTOM_KEY_ENV');
  assert.equal(result.agentSubagent.agentName, 'custom-enrich');
});

test('resolveEnrichmentConfig falls back to defaults when preferred modes are invalid', () => {
  const result = resolveEnrichmentConfig({
    projectConfig: null,
    globalConfig: null,
    env: { PMC_ENRICHMENT_PREFERRED_MODES: 'bad-mode,another-bad-mode' },
  });

  assert.deepEqual(result.preferredModes, ['local-model', 'cloud-api', 'agent-subagent']);
});

test('resolveEnrichmentConfig deduplicates preferred modes', () => {
  const result = resolveEnrichmentConfig({
    projectConfig: null,
    globalConfig: null,
    env: { PMC_ENRICHMENT_PREFERRED_MODES: 'cloud-api,cloud-api,agent-subagent' },
  });

  assert.deepEqual(result.preferredModes, ['cloud-api', 'agent-subagent']);
});

test('resolveEnrichmentConfig PMC_FILE_COVERAGE_THRESHOLD env override', () => {
  const result = resolveEnrichmentConfig({
    projectConfig: null,
    globalConfig: null,
    env: { PMC_FILE_COVERAGE_THRESHOLD: '0.9' },
  });
  assert.equal(result.fileCoverageThreshold, 0.9);
});

test('resolveEnrichmentConfig ignores invalid PMC_FILE_COVERAGE_THRESHOLD (>1)', () => {
  const result = resolveEnrichmentConfig({
    projectConfig: null,
    globalConfig: null,
    env: { PMC_FILE_COVERAGE_THRESHOLD: '1.5' },
  });
  assert.equal(result.fileCoverageThreshold, 0.8);
});

test('resolveEnrichmentConfig ignores invalid PMC_FILE_COVERAGE_THRESHOLD (<=0)', () => {
  const result = resolveEnrichmentConfig({
    projectConfig: null,
    globalConfig: null,
    env: { PMC_FILE_COVERAGE_THRESHOLD: '0' },
  });
  assert.equal(result.fileCoverageThreshold, 0.8);
});

test('resolveEnrichmentConfigPaths honours PMC_GLOBAL_CONFIG before platform global config dirs', () => {
  const result = resolveEnrichmentConfigPaths({
    projectRoot: '/repo',
    env: { PMC_GLOBAL_CONFIG: '/tmp/pmc.json' },
    platformOptions: {
      exists: () => false,
      homeDir: '/Users/alice',
    },
  });

  assert.match(result.projectConfigPath.replace(/\\/g, '/'), /\/repo\/\.pmc\/project-memory-context\.json$/);
  assert.equal(result.globalConfigPath, '/tmp/pmc.json');
  assert.equal(result.fileName, PMC_ENRICHMENT_CONFIG_FILE);
});
