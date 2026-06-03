import { classifyEnrichmentError } from './enrichment-errors.mjs';

function isFallbackEligible(type) {
  return type === 'auth'
    || type === 'timeout'
    || type === 'network'
    || type === 'rate-limit'
    || type === 'provider';
}

function providerConfigForMode(config, mode) {
  if (mode === 'local-model') {
    return config?.localModel ?? {};
  }

  if (mode === 'cloud-api') {
    return config?.cloudApi ?? {};
  }

  if (mode === 'agent-subagent') {
    return config?.agentSubagent ?? {};
  }

  return {};
}

function providerNameForMode(config, mode, provider) {
  return providerConfigForMode(config, mode).provider ?? provider?.kind ?? mode;
}

export async function runEnrichmentWithFallback({ request, config, providers, env = process.env }) {
  const attempts = [];

  for (const mode of config.preferredModes ?? []) {
    const provider = providers.find((candidate) => candidate.kind === mode);
    if (!provider) {
      continue;
    }

    const providerName = providerNameForMode(config, mode, provider);
    const startedAt = new Date().toISOString();
    const configured = provider.isConfigured({ request, config, env });

    if (!configured.ok) {
      attempts.push({
        mode,
        provider: providerName,
        status: 'skipped',
        errorType: 'config',
        errorMessage: configured.reason,
        startedAt,
        endedAt: new Date().toISOString(),
      });
      continue;
    }

    let available;
    try {
      available = await provider.isAvailable({ request, config, env });
    } catch (error) {
      const classified = classifyEnrichmentError(error);
      attempts.push({
        mode,
        provider: providerName,
        status: 'failed',
        errorType: classified.type,
        errorMessage: classified.message,
        startedAt,
        endedAt: new Date().toISOString(),
      });

      if (!isFallbackEligible(classified.type)) {
        return {
          status: 'error',
          content: null,
          mode: null,
          provider: null,
          model: null,
          attempts,
        };
      }
      continue;
    }

    if (!available.ok) {
      const classified = available.errorType
        ? { type: available.errorType, message: available.reason }
        : classifyEnrichmentError(new Error(available.reason ?? 'provider unavailable'));
      const attempt = {
        mode,
        provider: providerName,
        status: 'skipped',
        errorType: classified.type,
        errorMessage: classified.message,
        startedAt,
        endedAt: new Date().toISOString(),
      };
      attempts.push(attempt);

      if (!isFallbackEligible(classified.type)) {
        return {
          status: 'error',
          content: null,
          mode: null,
          provider: null,
          model: null,
          attempts,
        };
      }
      continue;
    }

    try {
      const result = await provider.enrich(request, { request, config, env });
      const attempt = {
        mode,
        provider: result.provider ?? providerName,
        model: result.model ?? null,
        status: 'succeeded',
        startedAt,
        endedAt: new Date().toISOString(),
      };
      attempts.push(attempt);

      return {
        status: 'succeeded',
        content: result.content,
        mode,
        provider: result.provider ?? providerName,
        model: result.model ?? null,
        attempts,
      };
    } catch (error) {
      const classified = classifyEnrichmentError(error);
      const attempt = {
        mode,
        provider: providerName,
        status: 'failed',
        errorType: classified.type,
        errorMessage: classified.message,
        startedAt,
        endedAt: new Date().toISOString(),
      };
      attempts.push(attempt);

      if (!isFallbackEligible(classified.type)) {
        return {
          status: 'error',
          content: null,
          mode: null,
          provider: null,
          model: null,
          attempts,
        };
      }
    }
  }

  return {
    status: 'error',
    content: null,
    mode: null,
    provider: null,
    model: null,
    attempts,
  };
}
