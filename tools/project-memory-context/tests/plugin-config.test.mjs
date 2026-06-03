import test from 'node:test';
import assert from 'node:assert/strict';

import { buildInjectedPmcConfig } from '../src/plugin-config.mjs';

test('buildInjectedPmcConfig launches public agent-memory through npx', () => {
  const injected = buildInjectedPmcConfig({
    installState: {
      ollamaBaseUrl: 'http://localhost:11434',
      ollamaModel: 'deepseek-coder-v2:16b-ctx32k',
      memoryDbPath: '/tmp/db',
    },
  });

  assert.deepEqual(injected.mcp['pmc-agent-memory'].command, ['npx', '-y', '@aabadin/agent-memory-mcp']);
  assert.equal(injected.mcp['pmc-agent-memory'].environment.MEMORY_DB_PATH, '/tmp/db');
  assert.equal(injected.mcp['pmc-agent-memory'].enabled, true);
});

test('buildInjectedPmcConfig includes embedding config', () => {
  const injected = buildInjectedPmcConfig({
    installState: {
      ollamaBaseUrl: 'http://localhost:11434',
      ollamaModel: 'deepseek-coder-v2:16b-ctx32k',
      memoryDbPath: '/tmp/db',
    },
  });

  assert.equal(injected.mcp['pmc-agent-memory'].environment.EMBEDDING_MODEL, 'Xenova/bge-m3');
});
