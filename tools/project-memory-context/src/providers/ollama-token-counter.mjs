/**
 * Count prompt tokens using Ollama's prompt_eval_count.
 *
 * Sends a /api/generate request with num_predict:1 so the model tokenizes the
 * prompt but generates (almost) nothing. Returns the prompt_eval_count from the
 * response — the real token count from deepseek's tokenizer.
 *
 * Verified on Ollama 0.24.0: num_predict:0 is ignored by deepseek-coder and
 * generates a full response. num_predict:1 returns in ~280ms with the correct
 * prompt_eval_count.
 *
 * Throws on HTTP error or timeout. Callers should catch and fall back to the
 * chars/4 heuristic: Math.ceil(prompt.length / 4).
 *
 * @param {object} opts
 * @param {string} opts.baseUrl  - Ollama base URL, e.g. http://localhost:11434
 * @param {string} opts.model    - Model name, e.g. deepseek-coder-v2:16b-ctx16k
 * @param {string} opts.prompt   - The full prompt text to count tokens for
 * @param {number} [opts.timeoutMs=30000] - Abort timeout in ms
 * @param {Function} [opts.fetchImpl=fetch] - Injectable fetch for testing
 * @returns {Promise<number|null>} token count, or null if field missing from response
 */
export async function countPromptTokens({ baseUrl, model, prompt, timeoutMs = 30000, fetchImpl = fetch }) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { num_predict: 1 },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama token count ${response.status}: ${typeof response.text === 'function' ? await response.text() : 'error'}`);
  }

  const data = await response.json();
  return typeof data.prompt_eval_count === 'number' ? data.prompt_eval_count : null;
}

/**
 * Estimate token count from character length using the chars/4 heuristic.
 * Used as a fallback when countPromptTokens fails or times out.
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
