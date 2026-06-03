import { classifyEnrichmentError } from '../enrichment-errors.mjs';

function getCloudApiConfig(context) {
  return context?.config?.cloudApi ?? {};
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function buildSignal(request) {
  return request?.timeoutMs ? AbortSignal.timeout(request.timeoutMs) : undefined;
}

export function createCloudApiProvider({ fetchImpl = fetch } = {}) {
  return {
    kind: 'cloud-api',
    isConfigured(context) {
      const { provider = 'openai-compatible', baseUrl, model, apiKeyEnv } = getCloudApiConfig(context);
      const apiKey = context?.env?.[apiKeyEnv];

      if (!baseUrl || !model || !apiKeyEnv) {
        return { ok: false, reason: 'cloud-api requires baseUrl, model, and apiKeyEnv' };
      }

      if (!apiKey) {
        return { ok: false, reason: `cloud-api requires api key in ${apiKeyEnv}` };
      }

      return { ok: true, provider };
    },
    async isAvailable(context) {
      const configured = this.isConfigured(context);
      if (!configured.ok) {
        return configured;
      }

      const { provider = 'openai-compatible', baseUrl, apiKeyEnv } = getCloudApiConfig(context);
      const apiKey = context?.env?.[apiKeyEnv];

      try {
        const response = await fetchImpl(`${trimTrailingSlash(baseUrl)}/models`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          signal: buildSignal(context?.request),
        });
        if (!response.ok) {
          const message = `${provider} ${response.status}: ${typeof response.text === 'function' ? await response.text() : 'provider unavailable'}`;
          const classified = classifyEnrichmentError(new Error(message));
          return { ok: false, reason: classified.message, errorType: classified.type };
        }
        return { ok: true };
      } catch (error) {
        const classified = classifyEnrichmentError(error);
        return { ok: false, reason: classified.message, errorType: classified.type };
      }
    },
    async enrich(request, context) {
      const { provider = 'openai-compatible', baseUrl, model, apiKeyEnv } = getCloudApiConfig(context);
      const apiKey = context?.env?.[apiKeyEnv];
      const response = await fetchImpl(`${trimTrailingSlash(baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        signal: buildSignal(request),
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: request.prompt }],
        }),
      });

      if (!response.ok) {
        throw new Error(`${provider} ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();
      return {
        content: data.choices?.[0]?.message?.content ?? '',
        provider,
        model,
      };
    },
  };
}
