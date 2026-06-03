import { classifyEnrichmentError } from '../enrichment-errors.mjs';

function getLocalModelConfig(context) {
  return context?.config?.localModel ?? {};
}

function buildSignal(request) {
  return request?.timeoutMs ? AbortSignal.timeout(request.timeoutMs) : undefined;
}

export function createLocalModelProvider({ fetchImpl = fetch } = {}) {
  return {
    kind: 'local-model',
    isConfigured(context) {
      const { baseUrl, model } = getLocalModelConfig(context);
      if (!baseUrl || !model) {
        return { ok: false, reason: 'local-model requires baseUrl and model' };
      }

      return { ok: true };
    },
    async isAvailable(context) {
      const configured = this.isConfigured(context);
      if (!configured.ok) {
        return configured;
      }

      const { baseUrl } = getLocalModelConfig(context);

      try {
        const response = await fetchImpl(`${baseUrl}/api/tags`, {
          signal: buildSignal(context?.request),
        });
        if (!response.ok) {
          const message = `ollama ${response.status}: ${typeof response.text === 'function' ? await response.text() : 'provider unavailable'}`;
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
      const { provider = 'ollama', baseUrl, model } = getLocalModelConfig(context);
      const response = await fetchImpl(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: buildSignal(request),
        body: JSON.stringify({
          model,
          prompt: request.prompt,
          stream: false,
          options: { temperature: 0.1, num_predict: 512 },
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();
      return { content: data.response, provider, model };
    },
  };
}
