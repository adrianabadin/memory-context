// F5.1B (accepted plan 5.1 second half / spec S19): feature cards,
// source-only opt-in surface.
//
// Feature membership is EXPLICIT (user decision: "Grupo explícito de
// símbolos/archivos (recomendado)" — "El consumidor proporciona nombre y
// miembros canónicos; PMC agrega evidencia sin inferir funcionalidades.").
// The caller supplies the feature name and the canonical symbol/file member
// keys; this module VERIFIES every declared member against the graph and
// aggregates existing verified identities plus optional accepted narratives.
// It never infers feature clustering from names, filenames, roles or topology.
//
// It is pure, synchronous and read-only:
// - no model/provider calls, no I/O, no persistence, no graph mutation;
// - a declared symbol member verifies only when exactly ONE node carried by
//   its file carries that canonical key; zero matches ('symbol-not-in-graph',
//   including stale identities whose node id is contradicted by canonical
//   metadata) and more than one match ('ambiguous-symbol-key', the
//   buildFileCard collision rule) are withheld from `symbols` and reported in
//   `rejected` — invalid members are never presented as valid graph evidence;
// - a declared `file|<path>` member verifies only when the graph carries
//   nodes for that file; its path contract is buildFileCard's;
// - narratives aggregate exactly like the F5.1A file rollup: BYTE-VERBATIM
//   accepted summaries with explicit symbolKey provenance, canonical ascending
//   order independent of input order, deterministic provenance-marked `text`,
//   shared N1 validateNarrative gating and per-entry machine-readable
//   rejections that never become content;
// - inputs are never mutated.
//
// This unit adds no MCP/CLI wiring: buildFileCard, buildFileNarrativeRollup
// and pmc_card outputs are unchanged.

import { buildFileCard } from './file-card.mjs';
import { validateNarrative } from './narrative-schema.mjs';
import { isCanonicalSymbolKey } from './prompt-v2.mjs';

const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const rejectedOrder = (a, b) => byKey(a.member, b.member) || byKey(a.reason, b.reason);

/** Canonical member key of a probed node: same derivation as buildFileNarrativeRollup. */
function nodeSymbolKey(node) {
  return node.symbolKey ?? node.metadata?.symbolKey ?? node.id;
}

/**
 * Build a feature card from caller-explicit membership.
 *
 * @param {object} options
 * @param {object} options.graphDb - GraphStore read surface (getNodesByFile, same as buildFileCard).
 * @param {string} options.name    - Explicit feature name supplied by the consumer, reproduced verbatim.
 * @param {string[]} options.members - Explicit canonical member keys: canonical symbol keys
 *                                     (`lang|path|kind|scope|name|arity`, including the 7-part
 *                                     csharp form) and file keys (`file|<path>`). Duplicates fail
 *                                     closed; malformed types fail closed; a well-formed key that
 *                                     the graph does not verify is honestly reported in `rejected`.
 * @param {Array<{symbolKey: string, narrative: object}>} [options.narratives]
 *                                     - Accepted symbol narratives; entries whose symbolKey is not
 *                                       a VERIFIED symbol member, or whose narrative fails
 *                                       validateNarrative, are reported in `rejected`.
 * @param {Set<string>} [options.symbolKeys] - Authoritative graph-key Set for mention membership.
 * @returns {{kind: 'feature-card', name: string,
 *            symbols: Array<{id: string, symbolKey: string, kind: string, path: string}>,
 *            files: Array<{id: string, path: string, kind: 'file'}>,
 *            narratives: Array<{symbolKey: string, summary: string}>, text: string,
 *            rejected: Array<{member: string, reason: string, errors?: string[]}>}}
 */
export function buildFeatureCard({ graphDb, name, members, narratives, symbolKeys } = {}) {
  if (!graphDb || typeof graphDb.getNodesByFile !== 'function') {
    throw new TypeError('buildFeatureCard requires a GraphStore read surface');
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('name must be a non-empty string supplied by the consumer');
  }
  if (!Array.isArray(members)) {
    throw new TypeError('members must be an array of canonical symbol or file keys');
  }
  const seenMembers = new Set();
  for (const member of members) {
    if (typeof member !== 'string' || member.length === 0) {
      throw new TypeError('each members entry must be a non-empty string');
    }
    // Ambiguous declared membership fails closed before any verification.
    if (seenMembers.has(member)) throw new TypeError(`duplicate members entry: ${member}`);
    seenMembers.add(member);
  }
  if (narratives !== undefined && !Array.isArray(narratives)) {
    throw new TypeError('narratives must be an array of {symbolKey, narrative} entries');
  }
  const entries = narratives ?? [];
  const seenEntries = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('each narratives entry must be a {symbolKey, narrative} object');
    }
    if (typeof entry.symbolKey !== 'string' || entry.symbolKey.length === 0) {
      throw new TypeError('each narratives entry must carry a non-empty symbolKey string');
    }
    if (!Object.hasOwn(entry, 'narrative')) {
      throw new TypeError(`each narratives entry must carry a narrative for '${entry.symbolKey}'`);
    }
    if (seenEntries.has(entry.symbolKey)) throw new TypeError(`duplicate narratives entry for symbolKey: ${entry.symbolKey}`);
    seenEntries.add(entry.symbolKey);
  }
  if (symbolKeys !== undefined && !(symbolKeys instanceof Set)) {
    throw new TypeError('symbolKeys must be a Set of graph symbol keys');
  }
  const known = symbolKeys ?? new Set();

  const rejected = [];
  const symbols = [];
  const files = [];
  const seenFiles = new Set();
  for (const member of members) {
    if (member.startsWith('file|')) {
      // buildFileCard owns the path contract; graph presence is the proof.
      const card = buildFileCard(graphDb, member.slice('file|'.length));
      if (seenFiles.has(card.path)) continue; // two spellings of one file are one member
      seenFiles.add(card.path);
      if (graphDb.getNodesByFile(card.path).length === 0) {
        rejected.push({ member: `file|${card.path}`, reason: 'file-not-in-graph' });
        continue;
      }
      files.push({ id: `file|${card.path}`, path: card.path, kind: 'file' });
      continue;
    }
    if (!isCanonicalSymbolKey(member)) {
      rejected.push({ member, reason: 'non-canonical-member-key' });
      continue;
    }
    const parts = member.split('|');
    const path = parts[1].replace(/\\/g, '/');
    const matches = graphDb.getNodesByFile(path).filter(node => nodeSymbolKey(node) === member);
    if (matches.length === 0) {
      // Never present a stale identity (node id contradicted by canonical
      // metadata) or an absent symbol as verified graph evidence.
      rejected.push({ member, reason: 'symbol-not-in-graph' });
      continue;
    }
    if (matches.length > 1) {
      rejected.push({ member, reason: 'ambiguous-symbol-key' });
      continue;
    }
    symbols.push({ id: matches[0].id, symbolKey: member, kind: matches[0].kind ?? parts[2], path });
  }
  symbols.sort((a, b) => byKey(a.symbolKey, b.symbolKey));
  files.sort((a, b) => byKey(a.path, b.path));

  // Narratives aggregate only VERIFIED symbol members; the graph decides.
  const memberKeys = new Set(symbols.map(symbol => symbol.symbolKey));
  const accepted = [];
  for (const entry of entries) {
    const { symbolKey } = entry;
    if (!isCanonicalSymbolKey(symbolKey)) {
      rejected.push({ member: symbolKey, reason: 'non-canonical-symbol-key' });
      continue;
    }
    if (!memberKeys.has(symbolKey)) {
      rejected.push({ member: symbolKey, reason: 'symbol-not-in-feature' });
      continue;
    }
    const validation = validateNarrative(entry.narrative, { symbolKeys: known });
    if (!validation.valid) {
      rejected.push({ member: symbolKey, reason: 'invalid-narrative', errors: [...validation.errors] });
      continue;
    }
    accepted.push({ symbolKey, summary: entry.narrative.summary });
  }
  accepted.sort((a, b) => byKey(a.symbolKey, b.symbolKey));
  rejected.sort(rejectedOrder);

  return {
    kind: 'feature-card',
    name,
    symbols,
    files,
    narratives: accepted,
    text: accepted.map(item => `- ${item.symbolKey}: ${item.summary}`).join('\n'),
    rejected,
  };
}
