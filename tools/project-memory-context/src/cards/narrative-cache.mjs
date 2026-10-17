// N5B (accepted plan 3.5 / spec S11): the opt-in narrative fingerprint
// cache and the upward summary-propagation helpers.
//
// The fingerprint is the accepted S11 formula, computed exclusively through
// the shared N5A helpers in src/hash.mjs — this module never forks the
// formula:
//
//   narrativeHash = h(code, signature, role, calleeSummaryHashes, promptVersion)
//
// `code` is the EXACT source slice the prompt uses (same range slicing rule
// as buildSymbolPromptMeta), `signature`/`role` come from the caller-supplied
// narrative context with the same fallbacks buildNarrativePromptV2 applies,
// `calleeSummaryHashes` hashes the canonical FULL callee summary TEXT list
// (never callee bodies, caller display lists, names, topology or NodeIDs),
// and `promptVersion` is the shared PROMPT_VERSION. Everything fails closed:
// missing, unreadable or malformed context rejects BEFORE any cache read or
// write, and no failure is ever swallowed into a persisted fingerprint.
//
// This module performs reads only; all persistence orchestration lives in
// cli/enrich-queue.mjs and cli/subagent-apply.mjs.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { computeNarrativeHash, hashCalleeSummaries } from '../hash.mjs';
import { PROMPT_VERSION, isCanonicalSymbolKey, normalizeSymbolKeys } from './prompt-v2.mjs';
import { validateNarrative } from './narrative-schema.mjs';

const MEMORY_SUFFIX = '.memory.json';

// Explicit staleness marks produced by this unit. saveWorklistMerged must
// never revert them through its "disk enriched wins" guard, because they are
// deliberate downgrades made by the current run.
export const EXPLICIT_STALE_REASONS = new Set([
  'narrative-hash-changed',
  'narrative-hash-missing',
  'callee-summary-changed',
  'queued-fingerprint-mismatch',
]);

export function narrativeMemoryPath(enrichmentDir, symbolKey) {
  if (typeof symbolKey !== 'string' || symbolKey.length === 0) {
    throw new TypeError('symbolKey must be a non-empty string');
  }
  return resolve(enrichmentDir, `${symbolKey.replace(/[^a-zA-Z0-9_-]+/g, '_')}${MEMORY_SUFFIX}`);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function equalStringMaps(a, b) {
  if (!plainObject(a) || !plainObject(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

function normalizeCalleeHashMap(value) {
  if (!plainObject(value)) {
    throw new TypeError('narrativeEvidence.calleeSummaryHashes must be an object map of canonical keys to hashes');
  }
  const normalized = {};
  for (const [key, hash] of Object.entries(value)) {
    if (!isCanonicalSymbolKey(key)) {
      throw new TypeError(`narrativeEvidence.calleeSummaryHashes keys must be canonical graph symbol keys: ${key}`);
    }
    if (typeof hash !== 'string' || hash.length === 0) {
      throw new TypeError(`narrativeEvidence.calleeSummaryHashes['${key}'] must be a non-empty string`);
    }
    normalized[key] = hash;
  }
  return normalized;
}

/**
 * Validate the persisted fingerprint bundle
 * `{symbolKey?, narrativeHash, calleeSummaryHashes, promptVersion}`.
 * Throws TypeError on any incomplete or malformed field; returns a
 * normalized copy so callers never persist unvalidated metadata.
 */
export function validateNarrativeEvidence(evidence) {
  if (!plainObject(evidence)) {
    throw new TypeError('narrativeEvidence must be an object');
  }
  const { narrativeHash, calleeSummaryHashes, promptVersion } = evidence;
  if (typeof narrativeHash !== 'string' || narrativeHash.length === 0) {
    throw new TypeError('narrativeEvidence.narrativeHash must be a non-empty string');
  }
  if (typeof promptVersion !== 'string' || promptVersion.length === 0) {
    throw new TypeError('narrativeEvidence.promptVersion must be a non-empty string');
  }
  const normalized = {
    narrativeHash,
    calleeSummaryHashes: normalizeCalleeHashMap(calleeSummaryHashes),
    promptVersion,
  };
  if (evidence.symbolKey !== undefined) {
    if (typeof evidence.symbolKey !== 'string' || evidence.symbolKey.length === 0) {
      throw new TypeError('narrativeEvidence.symbolKey must be a non-empty string');
    }
    normalized.symbolKey = evidence.symbolKey;
  }
  return normalized;
}

function validRange(range) {
  return plainObject(range)
    && Number.isInteger(range.startLine)
    && Number.isInteger(range.endLine)
    && range.startLine >= 1
    && range.endLine >= range.startLine;
}

/**
 * Own a caller-supplied narrative context BEFORE the first await that
 * touches it (B1 metadata coherence). The resolver hands back caller-owned
 * objects; any await afterwards (cache reads, prompt build, tokenizer probe)
 * lets that caller mutate nested `signature`/`role`/`callee` data while the
 * prompt already rendered the older values — producing a fingerprint for
 * inputs the model never saw. `structuredClone` (global since Node 17)
 * copies the complete value graph — Sets, Maps, arrays, `undefined`
 * properties, Dates and plain JSON data — without the field drops a JSON
 * round-trip would cause, and without ever writing into (or freezing) the
 * caller's object: the queue keeps a separate owned value, the caller's
 * input stays byte-identical. Non-cloneable values (functions, symbols)
 * reject with `TypeError` — fail closed instead of sharing a mutable alias.
 *
 * @param {object|null|undefined} narrativeContext
 * @returns {object|null|undefined} an owned deep copy (or the same nullish value)
 */
export function snapshotNarrativeContext(narrativeContext) {
  if (narrativeContext === null || narrativeContext === undefined) {
    return narrativeContext;
  }
  if (typeof narrativeContext !== 'object' || Array.isArray(narrativeContext)) {
    throw new TypeError('narrativeContext must be an object');
  }
  try {
    return structuredClone(narrativeContext);
  } catch (error) {
    throw new TypeError(
      `narrativeContext must be structured-cloneable snapshot data (JSON values, Sets, arrays; structuredClone is global since Node 17): ${error.message}`,
    );
  }
}

async function readSymbolSource(symbol, projectRoot) {
  if (!plainObject(symbol) || typeof symbol.symbolKey !== 'string' || symbol.symbolKey.length === 0) {
    throw new TypeError('symbol.symbolKey must be a non-empty string to derive the narrative fingerprint');
  }
  if (!validRange(symbol.range)) {
    throw new TypeError(`symbol range is missing or invalid for '${symbol.symbolKey}'`);
  }
  if (typeof symbol.filePath !== 'string' || symbol.filePath.length === 0) {
    throw new TypeError(`symbol.filePath must be a non-empty string for '${symbol.symbolKey}'`);
  }
  return readFile(resolve(projectRoot, symbol.filePath), 'utf8');
}

/**
 * Validate the COMPLETE queue-transported evidence bundle: the persisted
 * fingerprint plus the inputs needed to recompute it against the actual
 * source at apply time (`symbolKey`, `signature`, `role`, `range`).
 */
export function validateQueuedNarrativeEvidence(evidence) {
  const normalized = validateNarrativeEvidence(evidence);
  if (normalized.symbolKey === undefined) {
    throw new TypeError('narrativeEvidence.symbolKey is required for queued evidence');
  }
  const { signature, role, range } = evidence;
  if (signature !== null && typeof signature !== 'string') {
    throw new TypeError('narrativeEvidence.signature must be a string or null');
  }
  if (role === undefined) {
    throw new TypeError('narrativeEvidence.role is required');
  }
  if (!validRange(range)) {
    throw new TypeError('narrativeEvidence.range must be {startLine, endLine} with startLine >= 1 and endLine >= startLine');
  }
  return {
    ...normalized,
    signature,
    role,
    range: { startLine: range.startLine, endLine: range.endLine },
  };
}

function signatureOf(narrativeContext, code) {
  const provided = narrativeContext.signature;
  if (typeof provided === 'string' && provided.trim()) {
    return provided.trim();
  }
  const [first = ''] = String(code).split('\n');
  const line = first.trim();
  return line || '(not available)';
}

/**
 * Derive the complete current fingerprint evidence for an opt-in narrative
 * entry. Mirrors the prompt's own input derivation exactly (code slice,
 * signature fallback, role, canonical callee summary text list) and throws
 * TypeError/Error on missing, unreadable or malformed inputs — never a
 * partial bundle.
 *
 * @returns {Promise<{symbolKey, narrativeHash, calleeSummaryHashes, promptVersion, signature, role, range}>}
 */
export async function computeCurrentNarrativeEvidence({ symbol, projectRoot, narrativeContext, source } = {}) {
  if (!plainObject(narrativeContext)) {
    throw new TypeError('narrativeContext must be an object to derive the narrative fingerprint');
  }
  if (!plainObject(symbol) || typeof symbol.symbolKey !== 'string' || symbol.symbolKey.length === 0) {
    throw new TypeError('symbol.symbolKey must be a non-empty string to derive the narrative fingerprint');
  }
  const { range } = symbol;
  if (!validRange(range)) {
    throw new TypeError(`symbol range is missing or invalid for '${symbol.symbolKey}'`);
  }
  if (typeof symbol.filePath !== 'string' || symbol.filePath.length === 0) {
    throw new TypeError(`symbol.filePath must be a non-empty string for '${symbol.symbolKey}'`);
  }

  let content = source;
  if (typeof content !== 'string') {
    // Fail closed: an unreadable source never yields a fingerprint.
    try {
      content = await readSymbolSource(symbol, projectRoot);
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw new Error(`narrative fingerprint source unavailable for '${symbol.symbolKey}': ${error.message}`);
    }
  }

  // Identical slicing rule to buildSymbolPromptMeta: the fingerprint always
  // covers the exact bytes the prompt shows the model.
  const code = content.split('\n').slice(range.startLine - 1, range.endLine).join('\n');

  const callees = narrativeContext.callees === undefined ? [] : narrativeContext.callees;
  if (!Array.isArray(callees)) {
    throw new TypeError('narrativeContext.callees must be an array');
  }
  const pairs = [];
  for (const entry of callees) {
    if (!plainObject(entry) || entry.ambiguous) continue;
    if (!isCanonicalSymbolKey(entry.key)) continue;
    // The prompt withholds non-string summaries; they never reach the model,
    // so they never reach the fingerprint either.
    if (typeof entry.summary !== 'string') continue;
    pairs.push({ symbolKey: entry.key, summaryText: entry.summary });
  }

  const signature = signatureOf(narrativeContext, code);
  const role = narrativeContext.role ?? null;
  const calleeSummaryHashes = await hashCalleeSummaries(pairs);
  const narrativeHash = await computeNarrativeHash({
    code,
    signature,
    role,
    calleeSummaryHashes,
    promptVersion: PROMPT_VERSION,
  });

  return {
    symbolKey: symbol.symbolKey,
    narrativeHash,
    calleeSummaryHashes,
    promptVersion: PROMPT_VERSION,
    signature,
    role,
    range: { startLine: range.startLine, endLine: range.endLine },
  };
}

async function readNarrativeArtifact(enrichmentDir, symbolKey) {
  const path = narrativeMemoryPath(enrichmentDir, symbolKey);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, reason: 'no-accepted-artifact' };
    return { ok: false, reason: 'unreadable-artifact' };
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'corrupt-artifact' };
  }
  if (!plainObject(payload)) return { ok: false, reason: 'corrupt-artifact' };
  if (typeof payload.content !== 'string' || payload.content.length === 0) {
    return { ok: false, reason: 'missing-content' };
  }
  if (payload.narrativeEvidence === undefined) {
    return { ok: false, reason: 'missing-stored-hash' };
  }
  let evidence;
  try {
    evidence = validateNarrativeEvidence(payload.narrativeEvidence);
  } catch {
    return { ok: false, reason: 'invalid-evidence' };
  }
  if (evidence.symbolKey !== symbolKey) return { ok: false, reason: 'wrong-key' };

  return { ok: true, payload, content: payload.content, evidence };
}

/**
 * Evaluate the opt-in narrative cache for one symbol. A hit requires ALL of:
 * the current fingerprint, the stored worklist fingerprint, the stored index
 * fingerprint and the accepted artifact fingerprint to agree, and the accepted
 * content to validate against the shared N1 schema with the current known
 * graph keys. Mere file existence is never a hit; every failure returns a
 * machine-readable `reason` and never throws for missing state.
 *
 * The optional `source` supplies the exact bytes to evaluate (the caller's
 * prompt snapshot, already proven current) instead of re-reading — used by the
 * runner so evidence and cache proof come from ONE inspectable snapshot.
 * An unreadable source resolves to the `source-unavailable` miss (still a
 * fail-closed outcome: no hit, no persisted fingerprint) so the caller's own
 * prompt/recheck flow keeps producing its exact legacy error (C1).
 * Malformed context (bad shape, invalid range) still throws (fail closed)
 * from computeCurrentNarrativeEvidence before any cache read.
 */
export async function evaluateNarrativeCache({
  symbol,
  projectRoot,
  narrativeContext,
  enrichmentDir,
  worklistEntry = null,
  indexEntry = null,
  source: providedSource,
} = {}) {
  // An unreadable source is a MISS, never a hit and never a persisted
  // fingerprint: the caller's own honest prompt/recheck flow keeps producing
  // its exact legacy error (C1), while this check stays fail-closed.
  let source = providedSource;
  if (typeof source !== 'string') {
    try {
      source = await readSymbolSource(symbol, projectRoot);
    } catch (error) {
      if (error instanceof TypeError) throw error;
      return {
        hit: false,
        reason: 'source-unavailable',
        current: null,
        source: null,
        error,
      };
    }
  }

  const current = await computeCurrentNarrativeEvidence({ symbol, narrativeContext, source });
  // Every miss carries the just-read source so the queue can build its prompt
  // from the SAME bytes without a second read (C1 proof-read ordering).
  const miss = (reason) => ({ hit: false, reason, current, source });

  const matchesCurrent = (stored) => stored.narrativeHash === current.narrativeHash
    && stored.promptVersion === current.promptVersion
    && equalStringMaps(stored.calleeSummaryHashes, current.calleeSummaryHashes);

  if (!worklistEntry || worklistEntry.narrativeHash === undefined) {
    return miss('missing-stored-hash');
  }
  let storedWorklist;
  try {
    storedWorklist = validateNarrativeEvidence(worklistEntry);
  } catch {
    return miss('invalid-stored-evidence');
  }
  if (!matchesCurrent(storedWorklist)) return miss('worklist-fingerprint-mismatch');

  if (!indexEntry || indexEntry.narrativeHash === undefined) {
    return miss('missing-stored-hash');
  }
  let storedIndex;
  try {
    storedIndex = validateNarrativeEvidence(indexEntry);
  } catch {
    return miss('invalid-stored-evidence');
  }
  if (!matchesCurrent(storedIndex)) return miss('index-fingerprint-mismatch');

  const artifact = await readNarrativeArtifact(enrichmentDir, symbol.symbolKey);
  if (!artifact.ok) {
    return miss(artifact.reason);
  }
  if (artifact.evidence.promptVersion !== current.promptVersion) {
    return miss('prompt-version-mismatch');
  }
  if (artifact.evidence.narrativeHash !== current.narrativeHash) {
    return miss('fingerprint-mismatch');
  }
  if (!equalStringMaps(artifact.evidence.calleeSummaryHashes, current.calleeSummaryHashes)) {
    return miss('callee-summaries-mismatch');
  }

  let parsed;
  try {
    parsed = JSON.parse(artifact.content);
  } catch {
    return miss('invalid-content');
  }
  const symbolKeys = normalizeSymbolKeys(narrativeContext.symbolKeys);
  const validation = validateNarrative(parsed, { symbolKeys });
  if (!validation.valid) {
    return miss('invalid-content');
  }

  return {
    hit: true,
    reason: null,
    current,
    source,
    content: artifact.content,
    narrative: parsed,
    semanticSummary: parsed.summary,
    memoryId: worklistEntry.memoryId ?? null,
    enrichedAt: worklistEntry.enrichedAt ?? null,
    lastModeUsed: worklistEntry.lastModeUsed ?? null,
    evidence: artifact.evidence,
  };
}

/**
 * The previously ACCEPTED full summary text of a symbol, read from its
 * accepted artifact. The index `semanticSummary` is deliberately not used as
 * the propagation unit: legacy extraction truncates at 200 characters, while
 * S11 propagates on exact FULL summary bytes. Returns null when there is no
 * readable previously accepted narrative (nothing to compare).
 */
export async function readPreviousAcceptedSummary(memoryFile) {
  try {
    const raw = await readFile(memoryFile, 'utf8');
    const payload = JSON.parse(raw);
    if (!plainObject(payload) || typeof payload.content !== 'string') return null;
    const narrative = JSON.parse(payload.content);
    if (!plainObject(narrative) || typeof narrative.summary !== 'string') return null;
    return narrative.summary;
  } catch {
    return null;
  }
}

/**
 * S11 upward invalidation: when a callee's ACCEPTED summary text changed,
 * mark every previously accepted dependent caller `stale` for the NEXT pass.
 *
 * Dependents are derived ONLY from the complete stored callee-key hash maps
 * of previously accepted entries — never from top-5 display callers, names
 * or any native DB open. "Previously accepted" is proven by the stored
 * accepted fingerprint + dependency bundle, NOT by the transient worklist
 * status: a dependent stranded in `error` or `subagent-queued` after an
 * earlier acceptance is invalidated exactly like an `enriched` one (it must
 * become next-pass eligible instead of silently retaining superseded
 * proof), while a pending/unaccepted row without an accepted fingerprint is
 * never faked into an accepted one. Callers whose stored hash already equals
 * the new summary hash, callers without the callee key, and the callee
 * itself (bounded self/cycle handling for the next pass, no fixed-point
 * loop) are left untouched. Accepted memory, fingerprints and summaries are
 * preserved until the caller is actually regenerated.
 *
 * @returns {Promise<string[]>} symbol keys marked stale
 */
export async function markDependentCallersStale({ worklist, symbolKey, newSummaryText } = {}) {
  if (!Array.isArray(worklist)) throw new TypeError('worklist must be an array');
  if (typeof symbolKey !== 'string' || symbolKey.length === 0) {
    throw new TypeError('symbolKey must be a non-empty string');
  }
  if (typeof newSummaryText !== 'string') {
    throw new TypeError('newSummaryText must be a string');
  }

  const hashes = await hashCalleeSummaries({ [symbolKey]: newSummaryText });
  const newHash = hashes[symbolKey];
  const marked = [];

  for (const entry of worklist) {
    if (!plainObject(entry)) continue;
    if (entry.symbolKey === symbolKey) continue;
    const map = entry.calleeSummaryHashes;
    if (!plainObject(map)) continue;
    if (!Object.hasOwn(map, symbolKey)) continue;
    const stored = map[symbolKey];
    if (typeof stored !== 'string' || stored === newHash) continue;
    // Accepted proof gate: the stored accepted fingerprint is what makes a
    // row previously accepted, regardless of its transient status.
    if (typeof entry.narrativeHash !== 'string' || entry.narrativeHash.length === 0) continue;

    entry.status = 'stale';
    entry.staleReason = 'callee-summary-changed';
    marked.push(entry.symbolKey);
  }

  return marked;
}

/**
 * Validate a queue-transported evidence bundle against the ACTUAL current
 * source bytes at apply time. Returns `{ok: true, evidence}` when the queued
 * fingerprint still reproduces from the live source, otherwise
 * `{ok: false, problem}` with the exact honest reason — never a hit by
 * metadata alone.
 */
export async function queuedEvidenceCheck({ entry, projectRoot } = {}) {
  let evidence;
  try {
    evidence = validateQueuedNarrativeEvidence(entry?.narrativeEvidence);
  } catch (error) {
    return { ok: false, problem: `queued narrative evidence invalid: ${error.message}` };
  }
  if (evidence.symbolKey !== entry.symbolKey) {
    return { ok: false, problem: `queued narrative evidence symbol key does not match entry '${entry.symbolKey}'` };
  }
  if (evidence.promptVersion !== entry.promptVersion) {
    return { ok: false, problem: `queued narrative evidence prompt version '${evidence.promptVersion}' does not match the entry prompt version '${entry.promptVersion}'` };
  }

  const absolute = resolve(projectRoot, entry.filePath);
  let content;
  try {
    content = await readFile(absolute, 'utf8');
  } catch (error) {
    return { ok: false, problem: `queued narrative source unavailable: ${error.message}` };
  }

  const code = content.split('\n').slice(evidence.range.startLine - 1, evidence.range.endLine).join('\n');
  let current;
  try {
    current = await computeNarrativeHash({
      code,
      signature: evidence.signature,
      role: evidence.role,
      calleeSummaryHashes: evidence.calleeSummaryHashes,
      promptVersion: evidence.promptVersion,
    });
  } catch (error) {
    return { ok: false, problem: `queued narrative evidence invalid: ${error.message}` };
  }

  if (current !== evidence.narrativeHash) {
    return {
      ok: false,
      problem: `queued narrative fingerprint no longer matches the current source (queued ${evidence.narrativeHash}, current ${current})`,
    };
  }
  return { ok: true, evidence };
}
