import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function appendProviderEvent(enrichmentDir, event) {
  await mkdir(enrichmentDir, { recursive: true });
  await appendFile(join(enrichmentDir, 'provider-events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
}

export function withRecordedAttempt(entry, attempt) {
  const attempts = [...(entry.attempts ?? []), attempt];

  return {
    ...entry,
    attempts,
    lastModeUsed: attempt.mode ?? entry.lastModeUsed ?? null,
  };
}
