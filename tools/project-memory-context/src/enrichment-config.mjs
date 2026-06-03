import { join } from 'node:path';

import { resolveConfigDirs } from './platform.mjs';

const DEFAULTS = {
  preferredModes: ['local-model', 'cloud-api', 'agent-subagent'],
  localModel: {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'deepseek-coder-v2:16b-ctx16k',
  },
  cloudApi: {
    provider: 'openai-compatible',
    baseUrl: '',
    model: '',
    apiKeyEnv: 'PMC_CLOUD_API_KEY',
  },
  agentSubagent: {
    enabled: true,
    agentName: 'enrich',
  },
  // Symbols whose prompt_eval_count meets or exceeds this threshold are routed
  // to the subagent queue instead of being sent to Ollama directly.
  // Override with env PMC_SUBAGENT_TOKEN_THRESHOLD.
  subagentTokenThreshold: 5000,
  // Symbols whose line span covers this fraction (0–1) of their file are routed
  // to the subagent queue regardless of token count (e.g. EF migrations).
  // Override with env PMC_FILE_COVERAGE_THRESHOLD.
  fileCoverageThreshold: 0.8,
};

export const PMC_ENRICHMENT_CONFIG_FILE = 'project-memory-context.json';

const VALID_MODES = new Set(DEFAULTS.preferredModes);

function normalizePreferredModes(modes) {
  const filtered = [...new Set((modes ?? []).filter((mode) => VALID_MODES.has(mode)))];
  return filtered.length > 0 ? filtered : [...DEFAULTS.preferredModes];
}

function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    localModel: {
      ...base.localModel,
      ...override?.localModel,
    },
    cloudApi: {
      ...base.cloudApi,
      ...override?.cloudApi,
    },
    agentSubagent: {
      ...base.agentSubagent,
      ...override?.agentSubagent,
    },
  };
}

function unwrapEnrichmentConfig(config) {
  if (!config) {
    return {};
  }

  return config.enrichment ?? config;
}

export function readEnvPreferredModes(env) {
  return env.PMC_ENRICHMENT_PREFERRED_MODES
    ? env.PMC_ENRICHMENT_PREFERRED_MODES
      .split(',')
      .map((mode) => mode.trim())
      .filter(Boolean)
    : null;
}

export function resolveEnrichmentConfigPaths({
  projectRoot = process.cwd(),
  env = process.env,
  platformOptions,
} = {}) {
  const { projectConfigDir, globalConfigDir } = resolveConfigDirs(projectRoot, platformOptions);

  return {
    fileName: PMC_ENRICHMENT_CONFIG_FILE,
    projectConfigPath: env.PMC_PROJECT_CONFIG ?? join(projectConfigDir, PMC_ENRICHMENT_CONFIG_FILE),
    globalConfigPath: env.PMC_GLOBAL_CONFIG ?? join(globalConfigDir, PMC_ENRICHMENT_CONFIG_FILE),
  };
}

export function resolveEnrichmentConfig({ projectConfig, globalConfig, env }) {
  let resolved = mergeConfig(DEFAULTS, unwrapEnrichmentConfig(globalConfig));
  resolved = mergeConfig(resolved, unwrapEnrichmentConfig(projectConfig));

  const preferredModes = readEnvPreferredModes(env);
  if (preferredModes) {
    resolved.preferredModes = normalizePreferredModes(preferredModes);
  }

  if (env.PMC_LOCAL_MODEL_BASE_URL) {
    resolved.localModel.baseUrl = env.PMC_LOCAL_MODEL_BASE_URL;
  }

  if (env.PMC_LOCAL_MODEL_NAME) {
    resolved.localModel.model = env.PMC_LOCAL_MODEL_NAME;
  }

  if (env.PMC_CLOUD_API_BASE_URL) {
    resolved.cloudApi.baseUrl = env.PMC_CLOUD_API_BASE_URL;
  }

  if (env.PMC_CLOUD_API_MODEL) {
    resolved.cloudApi.model = env.PMC_CLOUD_API_MODEL;
  }

  if (env.PMC_CLOUD_API_KEY_ENV) {
    resolved.cloudApi.apiKeyEnv = env.PMC_CLOUD_API_KEY_ENV;
  }

  if (env.PMC_AGENT_SUBAGENT_NAME) {
    resolved.agentSubagent.agentName = env.PMC_AGENT_SUBAGENT_NAME;
  }

  if (env.PMC_SUBAGENT_TOKEN_THRESHOLD) {
    const threshold = parseInt(env.PMC_SUBAGENT_TOKEN_THRESHOLD, 10);
    if (Number.isFinite(threshold) && threshold > 0) {
      resolved.subagentTokenThreshold = threshold;
    }
  }

  if (env.PMC_FILE_COVERAGE_THRESHOLD) {
    const coverage = parseFloat(env.PMC_FILE_COVERAGE_THRESHOLD);
    if (Number.isFinite(coverage) && coverage > 0 && coverage <= 1) {
      resolved.fileCoverageThreshold = coverage;
    }
  }

  resolved.preferredModes = normalizePreferredModes(resolved.preferredModes);

  return resolved;
}

export { DEFAULTS };
