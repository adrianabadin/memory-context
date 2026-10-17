import { classifyEnrichmentError } from '../enrichment-errors.mjs';

function getLocalModelConfig(context) {
  return context?.config?.localModel ?? {};
}

function buildSignal(request) {
  return request?.timeoutMs ? AbortSignal.timeout(request.timeoutMs) : undefined;
}

// Ollama's `format` field accepts the literal "json" or a JSON-schema object
// (docs.ollama.com/api/generate). Anything else was explicitly requested but is
// unsupported here, so it must fail loudly instead of being dropped silently.
function normalizeFormatOption(format) {
  if (format === 'json') return 'json';
  if (format && typeof format === 'object' && !Array.isArray(format)) return format;
  throw new Error(`local-model: unsupported format option: ${format === undefined ? 'undefined' : JSON.stringify(format) ?? String(format)}`);
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
      if (!baseUrl || !model) {
        throw new Error('local-model requires baseUrl and model');
      }

      const body = {
        model,
        prompt: request.prompt,
        stream: false,
        options: { temperature: 0.1, num_predict: 512 },
      };
      // Structured-output requests forward the schema; legacy text requests
      // carry no `format` key at all.
      if (request?.format !== undefined) {
        body.format = normalizeFormatOption(request.format);
      }

      const response = await fetchImpl(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: buildSignal(request),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`Ollama ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();
      return { content: data.response, provider, model };
    },
  };
}
