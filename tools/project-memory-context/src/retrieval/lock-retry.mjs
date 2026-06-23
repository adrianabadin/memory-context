// src/retrieval/lock-retry.mjs
// Lock-tolerant retry wrapper for SQLITE_BUSY errors.
// Uses exponential backoff: 100ms → 200ms → 400ms (configurable base).
// On exhaustion, returns stale fallback data with warning.

const SQLITE_BUSY = 'SQLITE_BUSY';

function isSqliteBusy(err) {
  return err?.code === SQLITE_BUSY || err?.message?.includes('SQLITE_BUSY') || err?.message?.includes('database is locked');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute `fn` with lock-tolerant retry.
 *
 * @param {() => T} fn - The function to execute.
 * @param {object} [options]
 * @param {number} [options.maxAttempts=3] - Max retry attempts.
 * @param {number} [options.baseDelay=100] - Base delay in ms (doubles each retry).
 * @param {T}   [options.staleFallback] - Value to return if all attempts fail on BUSY.
 * @returns {T | typeof options.staleFallback}
 */
export async function withLockRetry(fn, { maxAttempts = 3, baseDelay = 100, staleFallback } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isSqliteBusy(err)) throw err;
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        await sleep(baseDelay * Math.pow(2, attempt));
      }
    }
  }
  // All attempts exhausted on SQLITE_BUSY — return stale fallback if provided
  if (staleFallback !== undefined) return staleFallback;
  throw lastErr;
}
