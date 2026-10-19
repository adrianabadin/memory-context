// S23 (accepted plan 5.1 / specs S18-S19): public aggregate-card reader
// helpers shared by `pmc_file_rollup`, `pmc_community_card` and
// `pmc_feature_card`.
//
// This module is read-only and deterministic. It owns three small pieces so
// src/query/relations.mjs stays focused:
//
// 1. `rejectUnknownOptions` — the strict single-purpose option contract used
//    by the three new reader methods (mirrors the existing pmc_entrypoints_for
//    / pmc_impact wording) so an undocumented option fails loudly instead of
//    being silently ignored, BEFORE any database or artifact read.
// 2. `enumerateKnownFilePaths` / `fileMemberKeys` — internally derived
//    enumeration bounds for community cards (ALL currently coherent known file
//    endpoints plus indexed source files — never caller-supplied files) and
//    candidate membership for file rollups, derived through the same reader
//    store views and the same canonical-key rules the shared builders use.
// 3. `loadAcceptedNarratives` — loads EXISTING accepted symbol narrative
//    artifacts from the canonical `narrativeMemoryPath(enrichmentDir, key)`
//    and returns only provably accepted `{symbolKey, narrative}` entries plus
//    honest per-key diagnostics for everything withheld.
//
// Acceptance is proven by the actual stored three-way binding, never by file
// existence and never by the index `semanticSummary`:
//   - the artifact must exist at the canonical path, be readable, be
//     well-formed JSON with string `content` and a valid `narrativeEvidence`
//     bundle whose `symbolKey` equals the requested graph key (this also
//     defeats sanitized filename collisions and foreign artifacts) — a key
//     with no artifact is reported honestly as `no-accepted-artifact` before
//     any stored state is consulted;
//   - the symbol-index entry must carry a valid stored fingerprint bundle
//     (`validateNarrativeEvidence`: narrativeHash, promptVersion,
//     calleeSummaryHashes);
//   - the worklist entry must carry the same valid bundle;
//   - the two stored bundles must agree pairwise, and the artifact bundle must
//     agree with them (stale/conflicting artifacts are withheld);
//   - the parsed `content` must validate against the shared N1 schema using
//     the authoritative canonical graph-key Set.
// This mirrors what `evaluateNarrativeCache` proves about stored state minus
// the live source recompute, which stays the enrichment queue's job; when any
// step cannot be proven the key is reported in `diagnostics` and never becomes
// rollup content. Artifact paths are derived ONLY from canonical graph keys
// through narrativeMemoryPath's sanitization — caller input never reaches the
// filesystem. Realpath containment additionally rejects symlink/junction
// escapes before reading metadata or artifact bytes.

import { readFile, realpath } from 'node:fs/promises';
import { relative, isAbsolute } from 'node:path';

import { buildFileNarrativeRollup } from '../cards/file-rollup.mjs';
import { buildCommunityCard } from '../cards/community-card.mjs';
import { buildFeatureCard } from '../cards/feature-card.mjs';
import { narrativeMemoryPath, validateNarrativeEvidence } from '../cards/narrative-cache.mjs';
import { validateNarrative } from '../cards/narrative-schema.mjs';
import { isCanonicalSymbolKey } from '../cards/prompt-v2.mjs';

const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function equalStringMaps(a, b) {
  if (!plainObject(a) || !plainObject(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(key => Object.hasOwn(b, key) && a[key] === b[key]);
}

/**
 * Strict single-purpose option contract: only the listed option names are
 * accepted; anything else throws a TypeError naming the first unknown key.
 * Validation happens before any database or artifact read.
 */
export function rejectUnknownOptions(toolName, options, allowed) {
  const unknown = Object.keys(options ?? {}).filter(key => !allowed.includes(key));
  if (unknown.length > 0) {
    const noun = allowed.length === 1 ? 'option' : 'options';
    throw new TypeError(`${toolName} accepts only the ${allowed.join(' and ')} ${noun}; unknown option '${unknown[0]}'`);
  }
}

/**
 * ALL currently coherent known file endpoints (the reader's S15 coherence
 * scan) plus every indexed source file, sorted and deduplicated. Community
 * cards scan exactly this internal list — never caller-supplied files.
 */
export function enumerateKnownFilePaths(context) {
  const paths = new Set(context.knownFileEndpoints ?? []);
  for (const key of Object.keys(context.symbolIndex ?? {})) {
    const parts = key.split('|');
    if (parts.length >= 2 && parts[1]) paths.add(parts[1].replace(/\\/g, '/'));
  }
  for (const edge of context.store.listNativeEdges({ relation: 'imports' })) {
    for (const side of [edge.source, edge.target]) {
      if (side?.kind === 'file' && typeof side.id === 'string' && side.id.startsWith('file|')) {
        const path = side.id.slice(5);
        if (side.path == null || side.path === path) paths.add(path);
      }
    }
  }
  return [...paths].sort(byKey);
}

/**
 * Canonical member keys of one file through the SAME rules the file rollup
 * builder uses (node kind symbol/member, canonical six/seven-part key whose
 * path part equals the file, deduplicated, sorted) — via the reader's
 * registry-filtered store view, so incoherent identities never become
 * artifact-load candidates.
 */
export function fileMemberKeys(context, filePath) {
  const keys = new Set();
  for (const node of context.store.getNodesByFile(filePath)) {
    if (!['symbol', 'member'].includes(node.node_kind)) continue;
    const key = node.symbolKey ?? node.metadata?.symbolKey ?? node.id;
    if (typeof key !== 'string' || !isCanonicalSymbolKey(key)) continue;
    if (key.split('|')[1].replace(/\\/g, '/') !== filePath) continue;
    keys.add(key);
  }
  return [...keys].sort(byKey);
}

/** Check existing read targets without following an escape into file content. */
export async function assertContainedRead(root, path) {
  let actual;
  try { actual = await realpath(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const base = await realpath(root);
  const rel = relative(base, actual);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
    throw new Error('read target escapes outside the project containment boundary');
  }
}

async function readArtifactPayload(enrichmentDir, symbolKey) {
  const path = narrativeMemoryPath(enrichmentDir, symbolKey);
  let raw;
  try {
    await assertContainedRead(enrichmentDir, path);
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
  if (payload.narrativeEvidence === undefined) return { ok: false, reason: 'missing-stored-hash' };
  let evidence;
  try {
    evidence = validateNarrativeEvidence(payload.narrativeEvidence);
  } catch {
    return { ok: false, reason: 'invalid-evidence' };
  }
  // Identity proof: the artifact must belong to THIS graph key. A sanitized
  // filename collision or a foreign payload shows up here, before anything is
  // compared or used.
  if (evidence.symbolKey !== symbolKey) return { ok: false, reason: 'wrong-key' };
  return { ok: true, payload, evidence };
}

/**
 * Load accepted narratives for the candidate keys.
 *
 * @param {object} options
 * @param {string} options.enrichmentDir - canonical enrichment directory.
 * @param {string[]} options.candidateKeys - graph-derived canonical keys to probe.
 * @param {object} options.symbolIndex - reader symbolIndex (coherent registry entries).
 * @param {Array<object>} options.worklist - worklist entries as read per request.
 * @param {Set<string>} options.knownKeys - authoritative canonical graph keys for mention validation.
 * @returns {Promise<{narratives: Array<{symbolKey: string, narrative: object}>,
 *                    diagnostics: Array<{symbolKey: string, reason: string, errors?: string[]}>}>}
 *   Sorted canonically; diagnostics list EVERY candidate that could not be
 *   proven accepted with its honest machine-readable reason.
 */
export async function loadAcceptedNarratives({ enrichmentDir, candidateKeys, symbolIndex, worklist, knownKeys } = {}) {
  if (typeof enrichmentDir !== 'string' || enrichmentDir.length === 0) {
    throw new TypeError('enrichmentDir must be a non-empty string');
  }
  if (!Array.isArray(candidateKeys)) throw new TypeError('candidateKeys must be an array');
  if (!(knownKeys instanceof Set)) throw new TypeError('knownKeys must be a Set of graph symbol keys');
  const worklistByKey = new Map();
  for (const entry of worklist ?? []) {
    if (plainObject(entry) && typeof entry.symbolKey === 'string') {
      // Duplicate rows are ambiguous even if their current fingerprints agree.
      worklistByKey.set(entry.symbolKey, worklistByKey.has(entry.symbolKey) ? null : entry);
    }
  }

  const narratives = [];
  const diagnostics = [];
  const withhold = (symbolKey, reason, errors) => {
    diagnostics.push(errors ? { symbolKey, reason, errors } : { symbolKey, reason });
  };

  for (const symbolKey of [...new Set(candidateKeys)].sort(byKey)) {
    // Artifact first: when nothing was ever accepted for a key, the honest
    // reason is the artifact-level one (no-accepted-artifact / corrupt /
    // foreign / collision) — the stored bindings are only consulted to prove
    // or reject an acceptance once an artifact exists.
    const artifact = await readArtifactPayload(enrichmentDir, symbolKey);
    if (!artifact.ok) {
      withhold(symbolKey, artifact.reason);
      continue;
    }

    if (worklistByKey.has(symbolKey) && worklistByKey.get(symbolKey) === null) {
      withhold(symbolKey, 'ambiguous-worklist-evidence');
      continue;
    }
    const indexEntry = symbolIndex?.[symbolKey];
    if (!indexEntry || indexEntry.narrativeHash === undefined) {
      withhold(symbolKey, 'missing-index-fingerprint');
      continue;
    }
    let indexEvidence;
    try {
      indexEvidence = validateNarrativeEvidence(indexEntry);
    } catch {
      withhold(symbolKey, 'invalid-index-evidence');
      continue;
    }
    if (indexEvidence.symbolKey !== undefined && indexEvidence.symbolKey !== symbolKey) {
      withhold(symbolKey, 'wrong-index-key');
      continue;
    }
    const worklistEntry = worklistByKey.get(symbolKey);
    if (!worklistEntry || worklistEntry.narrativeHash === undefined) {
      withhold(symbolKey, 'missing-worklist-fingerprint');
      continue;
    }
    let storedEvidence;
    try {
      storedEvidence = validateNarrativeEvidence(worklistEntry);
    } catch {
      withhold(symbolKey, 'invalid-worklist-evidence');
      continue;
    }
    if (storedEvidence.symbolKey !== symbolKey) {
      withhold(symbolKey, 'wrong-worklist-key');
      continue;
    }
    if (indexEvidence.narrativeHash !== storedEvidence.narrativeHash
      || indexEvidence.promptVersion !== storedEvidence.promptVersion
      || !equalStringMaps(indexEvidence.calleeSummaryHashes, storedEvidence.calleeSummaryHashes)) {
      withhold(symbolKey, 'fingerprint-mismatch');
      continue;
    }
    if (artifact.evidence.narrativeHash !== storedEvidence.narrativeHash
      || artifact.evidence.promptVersion !== storedEvidence.promptVersion
      || !equalStringMaps(artifact.evidence.calleeSummaryHashes, storedEvidence.calleeSummaryHashes)) {
      // Stale or conflicting artifact: the stored acceptance does not match
      // what is on disk right now.
      withhold(symbolKey, 'fingerprint-mismatch');
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(artifact.payload.content);
    } catch {
      withhold(symbolKey, 'invalid-content', ['artifact content is not valid JSON']);
      continue;
    }
    const validation = validateNarrative(parsed, { symbolKeys: knownKeys });
    if (!validation.valid) {
      withhold(symbolKey, 'invalid-content', [...validation.errors]);
      continue;
    }
    narratives.push({ symbolKey, narrative: parsed });
  }

  narratives.sort((a, b) => byKey(a.symbolKey, b.symbolKey));
  diagnostics.sort((a, b) => byKey(a.symbolKey, b.symbolKey));
  return { narratives, diagnostics };
}

/**
 * File narrative rollup response assembly: shared builder output plus honest
 * artifact diagnostics, with the canonical resolution status preserved.
 */
export async function buildFileRollupResponse(context, { enrichmentDir, filePath }) {
  const knownKeys = new Set(Object.keys(context.symbolIndex));
  const { narratives, diagnostics } = await loadAcceptedNarratives({
    enrichmentDir,
    candidateKeys: fileMemberKeys(context, filePath),
    symbolIndex: context.symbolIndex,
    worklist: context.worklist,
    knownKeys,
  });
  const rollup = buildFileNarrativeRollup({ graphDb: context.store, filePath, narratives, symbolKeys: knownKeys });
  return { status: 'resolved', target: rollup.path, ...rollup, diagnostics };
}

/**
 * Community card response assembly: first pass derives the verified members
 * from actual graph community assignments (the reader's internal enumeration
 * bounds), second pass attaches only provably accepted narratives.
 */
export async function buildCommunityCardResponse(context, { enrichmentDir, communityId }) {
  const knownKeys = new Set(Object.keys(context.symbolIndex));
  const filePaths = enumerateKnownFilePaths(context);
  const probe = buildCommunityCard({ graphDb: context.store, communityId, filePaths, symbolKeys: knownKeys });
  const { narratives, diagnostics } = await loadAcceptedNarratives({
    enrichmentDir,
    candidateKeys: probe.members.map(member => member.symbolKey),
    symbolIndex: context.symbolIndex,
    worklist: context.worklist,
    knownKeys,
  });
  const card = buildCommunityCard({ graphDb: context.store, communityId, filePaths, narratives, symbolKeys: knownKeys });
  return { ...card, diagnostics };
}

/**
 * Feature card response assembly: membership stays exactly what the consumer
 * declared, verified against the graph; artifacts are loaded ONLY for the
 * symbols the graph actually verified (declared-but-absent keys never reach
 * the filesystem).
 */
export async function buildFeatureCardResponse(context, { enrichmentDir, name, members }) {
  const knownKeys = new Set(Object.keys(context.symbolIndex));
  const probe = buildFeatureCard({ graphDb: context.store, name, members, symbolKeys: knownKeys });
  const { narratives, diagnostics } = await loadAcceptedNarratives({
    enrichmentDir,
    candidateKeys: probe.symbols.map(symbol => symbol.symbolKey),
    symbolIndex: context.symbolIndex,
    worklist: context.worklist,
    knownKeys,
  });
  const card = buildFeatureCard({ graphDb: context.store, name, members, narratives, symbolKeys: knownKeys });
  return { ...card, diagnostics };
}
