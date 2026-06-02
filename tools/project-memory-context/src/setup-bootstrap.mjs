import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { ensureProjectMemoryContextDirs, writeJsonArtifact } from './artifacts.mjs';
import { PMC_ENRICHMENT_CONFIG_FILE } from './enrichment-config.mjs';
import { buildPmcQueryConfig } from './plugin-config.mjs';

async function readJson(filePath, fallback) {
  try {
    const content = await readFile(filePath, 'utf8');
    if (!content || !content.trim()) return fallback;
    return JSON.parse(content);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error instanceof SyntaxError)) return fallback;
    throw error;
  }
}

function buildMcpConfig(installState) {
  const pmcQuery = buildPmcQueryConfig({ installState });
  return {
    mcpServers: {
      'agent-memory': {
        command: 'npx',
        args: ['-y', '@aabadin/agent-memory-mcp'],
        env: {
          MEMORY_DB_PATH: installState.memoryDbPath,
          ...(installState.embeddingCachePath
            ? { EMBEDDING_CACHE_PATH: installState.embeddingCachePath }
            : {}),
        },
      },
      'pmc-query': {
        command: pmcQuery.command[0],
        args: pmcQuery.command.slice(1),
        env: {
          ...pmcQuery.environment,
        },
      },
    },
  };
}

function buildOpencodeMcpConfig(installState) {
  return {
    mcp: {
      'agent-memory': {
        type: 'local',
        command: ['npx', '-y', '@aabadin/agent-memory-mcp'],
        enabled: true,
        environment: {
          MEMORY_DB_PATH: installState.memoryDbPath,
          ...(installState.embeddingCachePath
            ? { EMBEDDING_CACHE_PATH: installState.embeddingCachePath }
            : {}),
        },
      },
    },
  };
}

async function writeMcpJson(projectRoot, installState) {
  const mcpPath = join(projectRoot, '.mcp.json');
  const existing = await readJson(mcpPath, {});
  const merged = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      ...buildMcpConfig(installState).mcpServers,
    },
  };
  await writeFile(mcpPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return mcpPath;
}

async function ensureOpencodeConfig(projectRoot, installState) {
  const opencodeDir = join(projectRoot, '.opencode');
  await mkdir(opencodeDir, { recursive: true });
  const configPath = join(opencodeDir, 'opencode.json');
  const config = await readJson(configPath, { $schema: 'https://opencode.ai/config.json' });
  const existing = Array.isArray(config.plugin) ? config.plugin : [];
  if (!existing.includes('@aabadin/project-memory-context')) {
    config.plugin = [...existing, '@aabadin/project-memory-context'];
  }
  config.mcp = {
    ...(config.mcp ?? {}),
    ...buildOpencodeMcpConfig(installState).mcp,
  };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return configPath;
}

async function ensureEnrichmentConfig(projectRoot, configDir, installState) {
  const enrichPath = join(configDir, PMC_ENRICHMENT_CONFIG_FILE);
  const existingConfig = await readJson(enrichPath, {});
  const config = {
    ...existingConfig,
    enrichment: {
      ...existingConfig.enrichment,
      localModel: {
        ...existingConfig.enrichment?.localModel,
        baseUrl: installState.ollamaBaseUrl,
        model: installState.ollamaModel,
      },
    },
  };
  await mkdir(dirname(enrichPath), { recursive: true });
  await writeFile(enrichPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function ensureAntigravityConfig(projectRoot, installState) {
  const mcpConfigPath = join(homedir(), '.gemini', 'config', 'mcp_config.json');
  const existing = await readJson(mcpConfigPath, {});
  const merged = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      ...buildMcpConfig(installState).mcpServers,
    },
  };
  await mkdir(dirname(mcpConfigPath), { recursive: true });
  await writeFile(mcpConfigPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return mcpConfigPath;
}

async function ensureAgentConfigs(projectRoot, installState, agents) {
  let primaryConfigPath = null;

  for (const agent of agents) {
    if (agent === 'opencode') {
      primaryConfigPath = primaryConfigPath ?? await ensureOpencodeConfig(projectRoot, installState);
    }
    if (agent === 'claude-code') {
      const claudeDir = join(projectRoot, '.claude');
      await mkdir(claudeDir, { recursive: true });
      await ensureEnrichmentConfig(projectRoot, claudeDir, installState);
      primaryConfigPath = primaryConfigPath ?? join(projectRoot, '.mcp.json');
    }
    if (agent === 'cursor') {
      const cursorDir = join(projectRoot, '.cursor');
      await mkdir(cursorDir, { recursive: true });
      await ensureEnrichmentConfig(projectRoot, cursorDir, installState);
      primaryConfigPath = primaryConfigPath ?? join(projectRoot, '.mcp.json');
    }
    if (agent === 'antigravity') {
      primaryConfigPath = primaryConfigPath ?? await ensureAntigravityConfig(projectRoot, installState);
    }
  }

  await writeMcpJson(projectRoot, installState);
  return primaryConfigPath ?? join(projectRoot, '.mcp.json');
}

async function copyTemplate(packageRoot, templateName, projectRoot) {
  const source = join(packageRoot, 'templates', templateName);
  const target = join(projectRoot, templateName);
  const content = await readFile(source, 'utf8');
  const rendered = content.replaceAll('__PMC_PACKAGE_ROOT__', packageRoot);
  await writeFile(target, rendered, 'utf8');
  return target;
}

async function ensureGitignore(projectRoot) {
  const gitignorePath = join(projectRoot, '.gitignore');
  let content = '';
  try {
    content = await readFile(gitignorePath, 'utf8');
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }

  const pmcIgnoreBlock = `
# PMC (Project Memory Context)
.planning/project-memory-context/enrichment/
.planning/project-memory-context/intake/
.planning/project-memory-context/graph/graph.db
.planning/project-memory-context/graph/graph.db-shm
.planning/project-memory-context/graph/graph.db-wal
graphify-out/`;

  // Check if PMC block already exists
  if (!content.includes('.planning/project-memory-context/graph/graph.db')) {
    content = content.trimEnd() + pmcIgnoreBlock + '\n';
    await writeFile(gitignorePath, content, 'utf8');
  }

  return gitignorePath;
}

export async function bootstrapProjectInstall({
  projectRoot,
  packageRoot,
  ollamaBaseUrl,
  ollamaModel,
  embeddingCachePath,
  agents = [],
  agent,
}) {
  const resolvedAgents = agents.length > 0 ? agents : (agent ? [agent] : ['generic']);
  const dirs = await ensureProjectMemoryContextDirs(projectRoot);
  const memoryDbPath = join(dirs.base, 'memory-db');
  const installState = {
    projectRoot,
    packageRoot,
    ollamaBaseUrl,
    ollamaModel,
    memoryDbPath,
    embeddingCachePath: embeddingCachePath ?? join(dirs.base, 'embedding-cache'),
    installedAt: new Date().toISOString(),
  };

  await mkdir(memoryDbPath, { recursive: true });
  await writeJsonArtifact(join(dirs.base, 'install.json'), installState);
  const configPath = await ensureAgentConfigs(projectRoot, installState, resolvedAgents);
  const commandPath = await copyTemplate(packageRoot, 'project-memory-context.md', projectRoot);
  const workflowPath = await copyTemplate(packageRoot, 'project-memory-context workflow.md', projectRoot);
  const gitignorePath = await ensureGitignore(projectRoot);

  return {
    installState,
    configPath,
    commandPath,
    workflowPath,
    gitignorePath,
    agents: resolvedAgents,
  };
}
