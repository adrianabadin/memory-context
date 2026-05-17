import test from 'node:test';
import assert from 'node:assert/strict';

import { buildInjectedPmcConfig } from '../src/plugin-config.mjs';

test('buildInjectedPmcConfig creates local MCP entries for bundled model and agent memory servers', () => {
  const injected = buildInjectedPmcConfig({
    packageRoot: 'C:/pmc',
    installState: {
      ollamaBaseUrl: 'http://localhost:11434',
      ollamaModel: 'deepseek-coder-v2:16b-ctx32k',
      memoryDbPath: 'C:/workspace/.planning/project-memory-context/memory-db',
    },
  });

  assert.equal(injected.mcp['pmc-local-model'].type, 'local');
  assert.equal(injected.mcp['pmc-local-model'].environment.OLLAMA_MODEL, 'deepseek-coder-v2:16b-ctx32k');
  assert.equal(injected.mcp['pmc-agent-memory'].environment.MEMORY_DB_PATH, 'C:/workspace/.planning/project-memory-context/memory-db');
  assert.deepEqual(injected.mcp['pmc-local-model'].command.slice(0, 1), ['node']);
});
