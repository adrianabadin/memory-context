/**
 * subagent-queue.mjs
 *
 * Manages the subagent-queue.json file — symbols that exceeded the token
 * threshold and are waiting to be enriched by a Claude Code Task subagent
 * (via the /enrich skill) rather than by Ollama directly.
 *
 * States: pending → in_progress → done | error
 *
 * The CLI (enrich-queue.mjs) writes entries (appendSubagentQueue).
 * The /enrich skill reads entries and dispatches Task subagents.
 * pmc subagent-apply marks entries done after persisting results.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { normalizeSymbolKeys } from './cards/prompt-v2.mjs';
import { validateQueuedNarrativeEvidence } from './cards/narrative-cache.mjs';

const QUEUE_FILE = 'subagent-queue.json';

function queuePath(enrichmentDir) {
  return join(enrichmentDir, QUEUE_FILE);
}

async function readQueue(enrichmentDir) {
  try {
    const raw = await readFile(queuePath(enrichmentDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.entries)) {
      parsed.entries = [];
    }
    return parsed;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    return { entries: [] };
  }
}

async function writeQueue(enrichmentDir, queue) {
  const path = queuePath(enrichmentDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
}

/**
 * Append a new pending entry to the subagent queue.
 *
 * Legacy calls (no narrative metadata) produce the exact historical entry.
 * Opt-in narrative calls must supply the complete metadata trio —
 * `promptVersion`, the shared `schema` and `knownGraphKeys` — all at once;
 * partial or malformed metadata rejects with TypeError before the queue file
 * is read or written, so a rejected call can never create a silent legacy
 * entry or store a defaulted value (N3 correction B3).
 *
 * @returns {object} the entry as written (with generated id)
 */
export async function appendSubagentQueue(enrichmentDir, {
  symbolKey,
  name,
  filePath,
  language,
  kind,
  tokenCount = null,
  prompt,
  queuedAt,
  promptVersion,
  schema,
  knownGraphKeys,
  narrativeEvidence,
}) {
  const supplied = [promptVersion, schema, knownGraphKeys].filter((value) => value !== undefined);
  if (supplied.length > 0 && supplied.length < 3) {
    throw new TypeError('promptVersion, schema and knownGraphKeys must be supplied together for narrative entries');
  }
  if (supplied.length === 3) {
    if (typeof promptVersion !== 'string' || !promptVersion) {
      throw new TypeError('promptVersion must be a non-empty string');
    }
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      throw new TypeError('schema must be a JSON schema object');
    }
    // Rejects non-collection shapes and non-canonical raw graph IDs up front.
    normalizeSymbolKeys(knownGraphKeys);
  }

  // N5B (plan 3.5 / S11): the complete opt-in fingerprint evidence rides
  // the queue entry so `subagent-apply` can re-derive it against the actual
  // source. The whole bundle is validated — including its consistency with
  // the transported trio and the queued symbol key — BEFORE the queue file
  // is read or written, so a rejected call can never store a partial bundle
  // or silently degrade into a legacy entry.
  let normalizedEvidence;
  if (narrativeEvidence !== undefined && narrativeEvidence !== null) {
    if (supplied.length !== 3) {
      throw new TypeError('narrativeEvidence requires promptVersion, schema and knownGraphKeys to be supplied together');
    }
    normalizedEvidence = validateQueuedNarrativeEvidence(narrativeEvidence);
    if (normalizedEvidence.symbolKey !== symbolKey) {
      throw new TypeError('narrativeEvidence.symbolKey must match the queued symbolKey');
    }
    if (normalizedEvidence.promptVersion !== promptVersion) {
      throw new TypeError('narrativeEvidence.promptVersion must match the queued promptVersion');
    }
  } else if (narrativeEvidence === null) {
    throw new TypeError('narrativeEvidence must be an object when supplied');
  }

  const queue = await readQueue(enrichmentDir);
  const entry = {
    id: randomUUID(),
    symbolKey,
    name,
    filePath,
    language,
    kind,
    tokenCount,
    prompt,
    status: 'pending',
    memoryId: null,
    queuedAt: queuedAt ?? new Date().toISOString(),
    claimedAt: null,
    doneAt: null,
    errorAt: null,
    error: null,
  };
  if (supplied.length === 3) {
    entry.promptVersion = promptVersion;
    entry.schema = schema;
    entry.knownGraphKeys = [...knownGraphKeys];
    if (normalizedEvidence) {
      entry.narrativeEvidence = normalizedEvidence;
    }
  }
  queue.entries.push(entry);
  await writeQueue(enrichmentDir, queue);
  return entry;
}

/**
 * Load the full subagent queue from disk.
 */
export async function loadSubagentQueue(enrichmentDir) {
  return readQueue(enrichmentDir);
}

/**
 * Atomically claim the next pending entry (sets status → in_progress).
 * Returns null if the queue is empty or all entries are non-pending.
 */
export async function claimNextPending(enrichmentDir) {
  const queue = await readQueue(enrichmentDir);
  const entry = queue.entries.find((e) => e.status === 'pending');
  if (!entry) return null;
  entry.status = 'in_progress';
  entry.claimedAt = new Date().toISOString();
  await writeQueue(enrichmentDir, queue);
  return entry;
}

/**
 * Mark an entry as done after successful enrichment.
 * @param {string} id    - entry id
 * @param {object} opts
 * @param {string} [opts.memoryId]  - the assigned memory id
 */
export async function markSubagentDone(enrichmentDir, id, { memoryId } = {}) {
  const queue = await readQueue(enrichmentDir);
  const entry = queue.entries.find((e) => e.id === id);
  if (!entry) throw new Error(`subagent-queue: entry not found: ${id}`);
  entry.status = 'done';
  entry.doneAt = new Date().toISOString();
  if (memoryId) entry.memoryId = memoryId;
  await writeQueue(enrichmentDir, queue);
  return entry;
}

/**
 * Mark an entry as error.
 * @param {string} id           - entry id
 * @param {string} errorMessage - human-readable error
 */
export async function markSubagentError(enrichmentDir, id, errorMessage) {
  const queue = await readQueue(enrichmentDir);
  const entry = queue.entries.find((e) => e.id === id);
  if (!entry) throw new Error(`subagent-queue: entry not found: ${id}`);
  entry.status = 'error';
  entry.errorAt = new Date().toISOString();
  entry.error = errorMessage ?? 'unknown error';
  await writeQueue(enrichmentDir, queue);
  return entry;
}

/**
 * Summarize queue counts by status.
 * @param {object} queue  - result of loadSubagentQueue
 */
export function summarizeSubagentQueue(queue) {
  const entries = queue?.entries ?? [];
  return {
    total: entries.length,
    pending: entries.filter((e) => e.status === 'pending').length,
    in_progress: entries.filter((e) => e.status === 'in_progress').length,
    done: entries.filter((e) => e.status === 'done').length,
    error: entries.filter((e) => e.status === 'error').length,
  };
}
