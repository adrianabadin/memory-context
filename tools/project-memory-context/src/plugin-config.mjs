export function buildPmcQueryConfig({ installState }) {
  return {
    type: 'local',
    command: ['npx', '--yes', '--package', '@aabadin/project-memory-context', 'pmc-query-server'],
    enabled: true,
    environment: {
      PMC_PROJECT_ROOT: installState.projectRoot,
    },
  };
}

export function buildPmcAgentMemoryConfig({ installState }) {
  return {
    type: 'local',
    command: ['npx', '-y', '@aabadin/agent-memory-mcp'],
    enabled: true,
    environment: {
      MEMORY_DB_PATH: installState.memoryDbPath,
      EMBEDDING_MODEL: 'Xenova/bge-m3',
      EMBEDDING_DIMENSIONS: '1024',
      EMBEDDING_POOLING: 'cls',
    },
  };
}

export function buildInjectedPmcConfig({ installState }) {
  return {
    mcp: {
      'pmc-query': buildPmcQueryConfig({ installState }),
      'pmc-agent-memory': buildPmcAgentMemoryConfig({ installState }),
    },
  };
}
