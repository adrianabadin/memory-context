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
}) {
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
