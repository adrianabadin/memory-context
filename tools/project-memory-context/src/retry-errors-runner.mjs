export const MAX_RETRY_ITERATIONS = 5;

function collectPreviousErrors(entry) {
  const fromAttempts = (entry.attempts ?? [])
    .filter((attempt) => attempt.status === 'failed' && attempt.errorMessage)
    .map((attempt) => ({
      provider: attempt.provider ?? null,
      errorType: attempt.errorType ?? null,
      message: attempt.errorMessage,
      failedAt: attempt.endedAt ?? attempt.startedAt ?? null,
    }));

  if (fromAttempts.length > 0) {
    return fromAttempts;
  }

  return entry.error
    ? [{ provider: null, errorType: null, message: entry.error, failedAt: entry.failedAt ?? null }]
    : [];
}

export function collectRetryCandidates(worklist) {
  const bySymbol = new Map();

  for (const entry of worklist) {
    if (entry.status !== 'error') continue;
    const existing = bySymbol.get(entry.symbolKey);
    const previousErrors = collectPreviousErrors(entry);

    if (!existing) {
      bySymbol.set(entry.symbolKey, {
        ...entry,
        previousErrors: [...previousErrors],
      });
      continue;
    }

    existing.previousErrors.push(...previousErrors);
    if ((entry.attempts?.length ?? 0) >= (existing.attempts?.length ?? 0)) {
      Object.assign(existing, entry, { previousErrors: existing.previousErrors });
    }
  }

  return [...bySymbol.values()];
}

export function buildRetryState({ status, pid, projectRoot, startedAt, heartbeatAt, finishedAt = null, lastError = null }) {
  return {
    status,
    pid,
    projectRoot,
    startedAt,
    heartbeatAt,
    finishedAt,
    lastError,
  };
}