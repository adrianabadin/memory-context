function messageOf(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? 'Unknown enrichment error');
}

export function classifyEnrichmentError(error) {
  const message = messageOf(error);
  const normalized = message.toLowerCase();

  let type = 'runtime';

  if (normalized.includes('401') || normalized.includes('unauthorized') || normalized.includes('forbidden')) {
    type = 'auth';
  } else if (normalized.includes('429') || normalized.includes('rate limit')) {
    type = 'rate-limit';
  } else if (
    normalized.includes('500')
    || normalized.includes('502')
    || normalized.includes('503')
    || normalized.includes('504')
    || normalized.includes('404')
    || normalized.includes('provider unavailable')
    || normalized.includes('model missing')
  ) {
    type = 'provider';
  } else if (
    normalized.includes('econnrefused')
    || normalized.includes('enotfound')
    || normalized.includes('econnreset')
    || normalized.includes('socket')
    || normalized.includes('network')
  ) {
    type = 'network';
  } else if (normalized.includes('timeout')) {
    type = 'timeout';
  } else if (normalized.includes('config')) {
    type = 'config';
  } else if (normalized.includes('provider')) {
    type = 'provider';
  }

  return { type, message };
}
