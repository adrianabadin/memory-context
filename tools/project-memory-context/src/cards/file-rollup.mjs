// F5.1A (accepted plan 5.1 / spec S18): deterministic file-narrative
// rollups, source-only opt-in surface.
//
// This module aggregates EXISTING accepted symbol narratives into a
// file-level rollup with explicit provenance. It is pure, synchronous and
// read-only:
// - no model/provider calls, no I/O, no persistence, no graph mutation;
// - `summary` text is reproduced BYTE-VERBATIM from the supplied narratives;
// - ordering is canonical (ascending symbolKey), independent of input order;
// - the aggregate `text` is a deterministic provenance-marked concatenation
//   of the verbatim summaries, never a synthesized <=25-word narrative and
//   never validated against NARRATIVE_SCHEMA (schema constraints describe
//   SYMBOL narratives, not aggregate text);
// - supplied data that fails the shared N1 validator or that does not belong
//   to the requested file is reported per entry in `rejected` and NEVER
//   silently becomes rollup content;
// - inputs are never mutated.
//
// The caller supplies the accepted narratives (for example read from the
// accepted `.memory.json` artifacts) and the authoritative graph-key Set used
// for mention membership, exactly like validateNarrative. This unit adds no
// MCP/CLI wiring: buildFileCard and pmc_card default outputs are unchanged.

import { buildFileCard } from './file-card.mjs';
import { validateNarrative } from './narrative-schema.mjs';
import { isCanonicalSymbolKey } from './prompt-v2.mjs';

/**
 * Build a deterministic file-narrative rollup.
 *
 * @param {object} options
 * @param {object} options.graphDb    - GraphStore read surface (same as buildFileCard).
 * @param {string} options.filePath   - Project-relative file path, same contract as buildFileCard.
 * @param {Array<{symbolKey: string, narrative: object}>} [options.narratives]
 *                                     - Accepted symbol narratives; entries whose symbolKey is
 *                                       not a canonical member of this file, or whose narrative
 *                                       fails validateNarrative, are reported in `rejected`.
 * @param {Set<string>} [options.symbolKeys] - Authoritative graph-key Set for mention membership.
 * @returns {{path: string, kind: 'file-narrative-rollup',
 *            narratives: Array<{symbolKey: string, summary: string}>,
 *            text: string,
 *            rejected: Array<{symbolKey: string, reason: string, errors?: string[]}>}}
 */
export function buildFileNarrativeRollup({ graphDb, filePath, narratives, symbolKeys } = {}) {
  // buildFileCard owns the read-surface and path contract: identical
  // validation errors and identical path normalization for both surfaces.
  const card = buildFileCard(graphDb, filePath);
  if (narratives !== undefined && !Array.isArray(narratives)) {
    throw new TypeError('narratives must be an array of {symbolKey, narrative} entries');
  }
  if (symbolKeys !== undefined && !(symbolKeys instanceof Set)) {
    throw new TypeError('symbolKeys must be a Set of graph symbol keys');
  }
  const known = symbolKeys ?? new Set();

  // Authoritative membership: the canonical symbol keys that actually belong
  // to this file according to the graph, derived from the same read surface
  // buildFileCard uses. Names never fabricate membership.
  const membership = new Set();
  for (const node of graphDb.getNodesByFile(card.path)) {
    if (!['symbol', 'member'].includes(node.node_kind)) continue;
    const key = node.symbolKey ?? node.metadata?.symbolKey ?? node.id;
    if (!isCanonicalSymbolKey(key)) continue;
    if (key.split('|')[1].replace(/\\/g, '/') !== card.path) continue;
    membership.add(key);
  }

  const seen = new Set();
  const accepted = new Map();
  const rejected = [];
  for (const entry of narratives ?? []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('each narratives entry must be a {symbolKey, narrative} object');
    }
    const { symbolKey } = entry;
    if (typeof symbolKey !== 'string' || symbolKey.length === 0) {
      throw new TypeError('each narratives entry must carry a non-empty symbolKey string');
    }
    if (!Object.hasOwn(entry, 'narrative')) {
      throw new TypeError(`each narratives entry must carry a narrative for '${symbolKey}'`);
    }
    const { narrative } = entry;
    // Ambiguous provenance fails closed: two accepted entries for one symbol
    // never race through Map overwriting, and rejected duplicates are not
    // double-reported.
    if (seen.has(symbolKey)) throw new TypeError(`duplicate narratives entry for symbolKey: ${symbolKey}`);
    seen.add(symbolKey);
    if (!membership.has(symbolKey)) {
      rejected.push({ symbolKey, reason: isCanonicalSymbolKey(symbolKey) ? 'symbol-not-in-file' : 'non-canonical-symbol-key' });
      continue;
    }
    const validation = validateNarrative(narrative, { symbolKeys: known });
    if (!validation.valid) {
      rejected.push({ symbolKey, reason: 'invalid-narrative', errors: [...validation.errors] });
      continue;
    }
    accepted.set(symbolKey, narrative.summary);
  }

  const rollup = [...accepted.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([symbolKey, summary]) => ({ symbolKey, summary }));
  rejected.sort((a, b) => (a.symbolKey < b.symbolKey ? -1 : a.symbolKey > b.symbolKey ? 1 : 0));
  return {
    path: card.path,
    kind: 'file-narrative-rollup',
    narratives: rollup,
    text: rollup.map(item => `- ${item.symbolKey}: ${item.summary}`).join('\n'),
    rejected,
  };
}
