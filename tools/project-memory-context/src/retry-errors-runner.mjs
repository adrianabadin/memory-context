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

export async function runRetryLoop({
  worklist,
  maxIterations = MAX_RETRY_ITERATIONS,
  retrySymbol,
}) {
  const reportBySymbol = new Map(
    collectRetryCandidates(worklist).map((candidate) => [
      candidate.symbolKey,
      {
        symbolKey: candidate.symbolKey,
        name: candidate.name,
        filePath: candidate.filePath,
        kind: candidate.kind,
        language: candidate.language,
        previousErrors: candidate.previousErrors,
        iterationResults: [],
        finalStatus: 'error',
        memoryId: null,
        contentPreview: null,
      },
    ]),
  );

  let iterations = 0;

  while (iterations < maxIterations) {
    const currentCandidates = collectRetryCandidates(worklist);
    if (currentCandidates.length === 0) break;

    iterations += 1;
    for (const symbol of currentCandidates) {
      const outcome = await retrySymbol(symbol, iterations);
      const reportEntry = reportBySymbol.get(symbol.symbolKey);
      reportEntry.iterationResults.push({ iteration: iterations, ...outcome });
      reportEntry.finalStatus = outcome.status === 'succeeded' ? 'enriched' : 'error';
      reportEntry.memoryId = outcome.memoryId ?? reportEntry.memoryId;
      reportEntry.contentPreview = outcome.contentPreview ?? reportEntry.contentPreview;

      if (outcome.status === 'succeeded') {
        const worklistEntry = worklist.find((e) => e.symbolKey === symbol.symbolKey);
        if (worklistEntry) {
          worklistEntry.status = 'enriched';
        }
      }
    }
  }

  const symbols = [...reportBySymbol.values()];
  const symbolsRecovered = symbols.filter((item) => item.finalStatus === 'enriched').length;
  const symbolsStillFailing = symbols.length - symbolsRecovered;

  return {
    iterations,
    symbols,
    summary: {
      symbolsRetried: symbols.length,
      symbolsRecovered,
      symbolsStillFailing,
      maxIterationsReached: symbolsStillFailing > 0 && iterations === maxIterations,
    },
  };
}