import { join } from 'node:path';

export function buildInjectedPmcConfig({ packageRoot, installState }) {
  return {
    mcp: {
      'pmc-local-model': {
        type: 'local',
        command: ['node', join(packageRoot, 'mcp', 'local-model-server.mjs')],
        enabled: true,
        environment: {
          OLLAMA_BASE_URL: installState.ollamaBaseUrl,
          OLLAMA_MODEL: installState.ollamaModel,
        },
      },
      'pmc-agent-memory': {
        type: 'local',
        command: ['node', join(packageRoot, 'mcp', 'agent-memory-wrapper.mjs')],
        enabled: true,
        environment: {
          MEMORY_DB_PATH: installState.memoryDbPath,
        },
      },
    },
  };
}
