// F5.1B (accepted plan 5.1 second half / spec S19): community cards,
// source-only opt-in surface.
//
// A community card aggregates EXISTING verified identities and optional
// accepted symbol narratives for one graph community. It is pure,
// synchronous and read-only:
// - no model/provider calls, no I/O, no persistence, no graph mutation;
// - MEMBERSHIP COMES ONLY FROM ACTUAL CURRENT GRAPH COMMUNITY ASSIGNMENTS
//   (the nodes.community column read through existing GraphStore read
//   operations). Filenames, roles and symbol names never fabricate
//   membership: the caller's `filePaths` only bounds the enumeration (the
//   store exposes no node-listing API, and this module must not widen shared
//   surfaces); every listed member was verified row-by-row against the graph;
// - the display NAME comes only from the existing verified community-name
//   read API (`getCommunityName`) and is honestly `null` when absent — names
//   are never generated here;
// - ambiguous canonical identities (one canonical symbolKey carried by more
//   than one probed node) are withheld from members and reported in
//   `rejected`, exactly like buildFileCard withholds canonical collisions;
// - narratives are aggregated exactly like the F5.1A file rollup: BYTE-VERBATIM
//   accepted summaries with explicit symbolKey provenance, canonical ascending
//   order independent of input order, deterministic provenance-marked `text`
//   (never a synthesized <=25-word narrative and never schema-validated as a
//   whole), shared N1 validateNarrative gating and per-entry machine-readable
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

function normalizeCommunityId(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new TypeError('communityId must be a non-empty string or a finite number');
}

/** Canonical member key of a probed node: same derivation as buildFileNarrativeRollup. */
function nodeSymbolKey(node) {
  return node.symbolKey ?? node.metadata?.symbolKey ?? node.id;
}

/**
 * Build a community card for one graph community.
 *
 * @param {object} options
 * @param {object} options.graphDb    - GraphStore read surface (getNodesByFile + getCommunityName).
 * @param {string|number} options.communityId - Community assignment to aggregate (compared as
 *                                       String(node.community) === String(communityId)).
 * @param {string[]} options.filePaths - Explicit enumeration bound: only nodes carried by these
 *                                       project-relative files are probed for the community
 *                                       assignment. Deterministic dedup after normalization.
 * @param {Array<{symbolKey: string, narrative: object}>} [options.narratives]
 *                                     - Accepted symbol narratives; entries whose symbolKey is not
 *                                       a VERIFIED member of this community, or whose narrative fails
 *                                       validateNarrative, are reported in `rejected`.
 * @param {Set<string>} [options.symbolKeys] - Authoritative graph-key Set for mention membership.
 * @returns {{kind: 'community-card', communityId: string, name: string|null, scannedFiles: string[],
 *            members: Array<{id: string, symbolKey: string, kind: string, path: string}>,
 *            narratives: Array<{symbolKey: string, summary: string}>, text: string,
 *            rejected: Array<{member: string, reason: string, errors?: string[]}>}}
 */
export function buildCommunityCard({ graphDb, communityId, filePaths, narratives, symbolKeys } = {}) {
  if (!graphDb || typeof graphDb.getNodesByFile !== 'function'
    || typeof graphDb.getCommunityName !== 'function') {
    throw new TypeError('buildCommunityCard requires a GraphStore read surface');
  }
  const id = normalizeCommunityId(communityId);
  if (!Array.isArray(filePaths)) {
    throw new TypeError('filePaths must be an array of project-relative file paths');
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
    // Ambiguous provenance fails closed: two accepted entries for one symbol never race through.
    if (seenEntries.has(entry.symbolKey)) throw new TypeError(`duplicate narratives entry for symbolKey: ${entry.symbolKey}`);
    seenEntries.add(entry.symbolKey);
  }
  if (symbolKeys !== undefined && !(symbolKeys instanceof Set)) {
    throw new TypeError('symbolKeys must be a Set of graph symbol keys');
  }
  const known = symbolKeys ?? new Set();

  const rejected = [];
  const scanned = new Set();
  const byCanonicalKey = new Map();
  for (const filePath of filePaths) {
    // buildFileCard owns the read-surface and path contract: identical
    // validation errors and identical path normalization for both surfaces.
    const card = buildFileCard(graphDb, filePath);
    if (scanned.has(card.path)) continue; // deterministic dedup after normalization
    scanned.add(card.path);
    const rows = graphDb.getNodesByFile(card.path);
    if (rows.length === 0) {
      rejected.push({ member: `file|${card.path}`, reason: 'file-not-in-graph' });
      continue;
    }
    for (const node of rows) {
      if (!['symbol', 'member'].includes(node.node_kind)) continue;
      const key = nodeSymbolKey(node);
      if (typeof key !== 'string' || !isCanonicalSymbolKey(key)) continue;
      if (key.split('|')[1].replace(/\\/g, '/') !== card.path) continue;
      if (node.community == null || String(node.community) !== id) continue;
      if (!byCanonicalKey.has(key)) byCanonicalKey.set(key, []);
      byCanonicalKey.get(key).push({ id: node.id, symbolKey: key, kind: node.kind ?? key.split('|')[2], path: card.path });
    }
  }

  // Never let duplicate graph rows present one canonical identity as two members.
  const members = [];
  for (const [key, group] of byCanonicalKey) {
    if (group.length > 1) {
      rejected.push({ member: key, reason: 'ambiguous-symbol-key' });
      continue;
    }
    members.push(group[0]);
  }
  members.sort((a, b) => byKey(a.symbolKey, b.symbolKey));

  // Narratives aggregate only VERIFIED community members; the graph decides.
  const memberKeys = new Set(members.map(member => member.symbolKey));
  const accepted = [];
  for (const entry of entries) {
    const { symbolKey } = entry;
    if (!isCanonicalSymbolKey(symbolKey)) {
      rejected.push({ member: symbolKey, reason: 'non-canonical-symbol-key' });
      continue;
    }
    if (!memberKeys.has(symbolKey)) {
      rejected.push({ member: symbolKey, reason: 'symbol-not-in-community' });
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
    kind: 'community-card',
    communityId: id,
    name: graphDb.getCommunityName(id),
    scannedFiles: [...scanned].sort(byKey),
    members,
    narratives: accepted,
    text: accepted.map(item => `- ${item.symbolKey}: ${item.summary}`).join('\n'),
    rejected,
  };
}
