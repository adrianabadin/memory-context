// src/query/impact.mjs
//
// F4B / S15: `pmc_impact(target)` — "dependents, covering tests, and affected
// roles, ranked by PageRank" (plan 4.3).
//
// Contracts kept here:
//   * The ranking graph is the FULL known canonical dependency view, never
//     target-relative: one node per canonical registry key plus one endpoint
//     per known project file (files with registry symbols, files with native
//     import evidence, and standalone known file nodes recognized by the
//     canonical reader/card coherence — an empty file never disappears from
//     the ranking), and one directed edge per grounded dependency pair — a call
//     edge from caller to callee (native plus legacy through the same guarded
//     engine adapter as every other query, with its endpoint coherence and
//     constructor-edge exclusions preserved) and a file-import edge from the
//     importing file to the imported file (the scope-aware file-card path).
//     Directed neighbour pairs are deduplicated, so one relationship is
//     never double-weighted, and the same node carries the SAME rank for
//     every target of one database state. Ranking edges never include the
//     file-scoped symbol lift below, which would re-count one import
//     relation at two levels.
//   * The pure PageRank helper (src/query/pagerank.mjs) computes the scores:
//     damping 0.85, tolerance 1e-8, maxIterations 100 are documented
//     implementation defaults reported through `rankModel` — not new MCP/CLI
//     knobs; the tool signature stays `{target}` only.
//   * Dependents are the COMPLETE reverse closure over grounded calls and
//     imports from the selected target: no hop cut, no role boundary cut, a
//     visited set so cycles terminate, and one-hop candidates gathered per
//     sorted frontier key (the S14 per-seed union remedy) then processed in
//     sorted canonical edge-key order, so equal-distance ties and diamond
//     branches resolve identically under every database insertion order. A
//     class/file target expands only to its proven registry members or
//     exact-path symbols as zero-hop seeds (steps shown in `path`), never a
//     fabricated class-level edge. File import dependents reuse the existing
//     binding-resolved inbound import path of the relations adapter: the
//     exported symbols of a file whose binding actually targets the visited
//     symbol are dependents with `scope: file` evidence — never same-file or
//     name guesses. `distance` counts actual dependency hops.
//   * `tests` reuses the EXISTING `buildFacts` evidence verbatim (importer
//     files + the existing test-path filter + top-level exported symbols):
//     STATIC referenced-test candidates, never executed coverage — labelled
//     with `provenance: 'static-import-reference'`. A member target keeps the
//     same facts.tests projection as its class; a file target keeps the
//     file-scope shape (`file|<path>`).
//   * Roles/layer values come ONLY from the canonical `node_role_assignments`
//     ledger through the shared S13 `createRoleResolver`: explicit unknowns,
//     excluded node kinds (doc/config/data), metadata-only legacy roles and
//     name/filename guesses never produce a role or an aggregate entry.
//     `roles` aggregates the canonical non-null roles of the unique affected
//     keys (dependents and tests deduplicated once per canonical key) with
//     the SUM of each contributing node's rank and its sorted symbol keys;
//     the aggregated `layer` projects only when EVERY contributing record
//     carries the SAME known canonical layer — an absent layer or any
//     mixture yields null, never an inference from profile, filename or
//     owner.
//   * Every returned record is a node of the ranking graph, so its rank is a
//     computed score (never an invented 0); records sort rank DESC then
//     canonical key ASC, roles sort rank DESC then role ASC. Missing or
//     ambiguous targets keep the shared `{status, candidates}` shape with
//     empty projections and no rankModel, exactly like pmc_entrypoints_for.
import { buildFacts } from '../cards/facts.mjs';
import { buildFileCard } from '../cards/file-card.mjs';
import { createRoleResolver, parseKey } from './role-traversal.mjs';
import { computePageRank, PAGERANK_DEFAULTS } from './pagerank.mjs';

const FILE_PREFIX = 'file|';
const TEST_PROVENANCE = 'static-import-reference';

const cmpKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const rankNumber = value => (typeof value === 'number' && Number.isFinite(value) ? value : -Infinity);

export async function walkImpact(context, { resolved }) {
  const { store, engine, endpoint } = context;
  const registryKeys = Object.keys(context.symbolIndex).sort();
  const { roleDetails, provenContainerOf } = createRoleResolver(store, Object.keys(context.symbolIndex));

  // ── Full known canonical dependency graph (target-independent) ───────────
  const importEdges = store.listNativeEdges({ relation: 'imports' });
  const filePaths = new Set();
  for (const key of registryKeys) {
    const parsed = parseKey(key);
    if (parsed && parsed.path) filePaths.add(parsed.path);
  }
  for (const edge of importEdges) {
    for (const side of [edge.source, edge.target]) {
      if (typeof side?.id === 'string' && side.id.startsWith(FILE_PREFIX)) filePaths.add(side.id.slice(FILE_PREFIX.length));
    }
  }
  // S15 correction B1: standalone known file endpoints recognized by the
  // canonical reader/card coherence (empty files with no symbols and no
  // import edges included) join the ranking graph, so the "full known
  // canonical dependencies" scope never drops an existing file vertex and
  // every node's rank matches the complete node set.
  for (const path of context.knownFileEndpoints ?? []) {
    if (typeof path === 'string' && path.length > 0) filePaths.add(path);
  }
  const nodeKeys = new Set(registryKeys);
  for (const path of filePaths) nodeKeys.add(FILE_PREFIX + path);

  const pairEdges = new Map(); // JSON([sourceKey, targetKey]) -> {source, target}
  const putPair = (sourceKey, targetKey) => {
    const key = JSON.stringify([sourceKey, targetKey]);
    if (!pairEdges.has(key)) pairEdges.set(key, { source: sourceKey, target: targetKey });
  };
  // Calls: one compact outbound query per sorted registry key through the
  // existing guarded engine seam, unioned and deduplicated here (S14's
  // per-seed remedy — a batched multi-seed scan could drop a tied edge).
  for (const seed of registryKeys) {
    const query = await engine.querySymbolContext({ symbolKey: seed, depth: 'compact', edgeTypes: ['calls'] });
    for (const edge of query.edges) {
      if (edge.relation !== 'calls') continue;
      const source = endpoint(engine.graphNodeIdToSymbolKey(edge.source));
      const target = endpoint(engine.graphNodeIdToSymbolKey(edge.target));
      if (!source || !target) continue;
      putPair(source.symbolKey, target.symbolKey);
    }
  }
  // File imports: the same scope-aware file-card contract as the default
  // file-mode relations query; an incoherent file endpoint fails closed.
  for (const path of [...filePaths].sort()) {
    let card;
    try { card = buildFileCard(store, path); } catch { continue; }
    for (const item of card.importsFrom) {
      if (!filePaths.has(item.path)) continue; // an unknown endpoint is never invented
      putPair(FILE_PREFIX + path, FILE_PREFIX + item.path);
    }
  }

  const ranking = computePageRank({ nodes: [...nodeKeys].sort(), edges: [...pairEdges.values()] });

  // ── Inbound adjacency for the reverse closure ─────────────────────────────
  const inbound = new Map(); // key -> Set of dependent keys
  const addInbound = (to, from) => {
    if (!inbound.has(to)) inbound.set(to, new Set());
    inbound.get(to).add(from);
  };
  for (const { source, target } of pairEdges.values()) addInbound(target, source);

  // Binding-resolved inbound import lift — the existing relations contract:
  // a file whose RESOLVED binding actually targets the visited symbol makes
  // its exported registry symbols dependents (file-scoped evidence). These
  // walk edges are deliberately not ranking edges (see docblock).
  const exportedByPath = new Map();
  for (const key of registryKeys) {
    const parts = key.split('|');
    if (parts[3] !== 'exported') continue;
    if (!exportedByPath.has(parts[1])) exportedByPath.set(parts[1], []);
    exportedByPath.get(parts[1]).push(key);
  }
  for (const binding of store.listNativeImportBindings()) {
    const targetKey = binding.target?.id;
    if (typeof targetKey !== 'string' || !Object.prototype.hasOwnProperty.call(context.symbolIndex, targetKey)) continue;
    const sourceId = binding.sourceId;
    if (typeof sourceId !== 'string' || !sourceId.startsWith(FILE_PREFIX)) continue;
    for (const key of exportedByPath.get(sourceId.slice(FILE_PREFIX.length)) ?? []) addInbound(targetKey, key);
  }

  // ── Seeds: proven registry membership only ────────────────────────────────
  const startKey = resolved.mode === 'symbol' ? resolved.symbolKey : FILE_PREFIX + resolved.target;
  const startParsed = parseKey(startKey);
  const expansion = [];
  if (resolved.mode === 'file') {
    for (const key of registryKeys) {
      const parsed = parseKey(key);
      if (parsed && parsed.path === resolved.target) expansion.push(key);
    }
  } else if (startParsed && !startParsed.member) {
    for (const key of registryKeys) {
      if (key === startKey) continue;
      const member = parseKey(key);
      if (!member || !member.member || member.path !== startParsed.path) continue;
      if (provenContainerOf(key) === startKey) expansion.push(key);
    }
  }
  expansion.sort();

  const parent = new Map([[startKey, null]]);
  const walkPath = key => {
    const chain = [];
    for (let current = key; current != null; current = parent.get(current)) chain.push(current);
    return chain.reverse();
  };
  const visited = new Set([startKey]);
  const distance = new Map();
  let frontier = [startKey];
  for (const key of expansion) {
    if (visited.has(key)) continue;
    visited.add(key);
    parent.set(key, startKey);
    frontier.push(key);
  }

  let hop = 0;
  while (frontier.length > 0) {
    hop += 1;
    const active = [...frontier].sort();
    frontier = [];
    const hopEdges = new Map(); // JSON([dependent, dependency])
    for (const seed of active) {
      for (const from of inbound.get(seed) ?? []) hopEdges.set(JSON.stringify([from, seed]), { from, to: seed });
    }
    for (const key of [...hopEdges.keys()].sort()) {
      const edge = hopEdges.get(key);
      if (!visited.has(edge.to) || visited.has(edge.from)) continue;
      visited.add(edge.from);
      parent.set(edge.from, edge.to);
      distance.set(edge.from, hop);
      frontier.push(edge.from);
    }
  }

  // ── Records ───────────────────────────────────────────────────────────────
  const rankOf = key => (ranking.scores.has(key) ? ranking.scores.get(key) : null);
  const roleOf = key => {
    const details = roleDetails(key);
    return details === null ? { role: null, layer: null } : details;
  };
  const kindOf = key => {
    if (key.startsWith(FILE_PREFIX)) return 'file';
    const node = endpoint(key);
    return node === null ? null : node.kind;
  };

  const dependents = [...distance].map(([key, hops]) => {
    const { role, layer } = roleOf(key);
    return { symbolKey: key, kind: kindOf(key), distance: hops, role, layer, rank: rankOf(key), path: walkPath(key) };
  });

  const facts = buildFacts(store, startKey);
  const tests = facts.tests.map(item => {
    const key = typeof item.symbolKey === 'string' ? item.symbolKey : FILE_PREFIX + item.path;
    const { role, layer } = roleOf(key);
    return { symbolKey: key, relation: 'tests', kind: item.kind ?? null, rank: rankOf(key), role, layer,
      provenance: TEST_PROVENANCE };
  });

  // Affected roles: canonical non-null roles of the unique affected keys —
  // one contribution per canonical key even when a key is both dependent and
  // covering test; no unknown-classification is ever fabricated.
  const affected = new Map();
  for (const record of [...dependents, ...tests]) {
    if (!affected.has(record.symbolKey)) affected.set(record.symbolKey, record);
  }
  const groups = new Map();
  for (const record of affected.values()) {
    if (record.role === null) continue;
    if (!groups.has(record.role)) groups.set(record.role, { role: record.role, layers: new Set(), rank: 0, symbolKeys: [] });
    const group = groups.get(record.role);
    // S15 correction B2: absent layers stay INSIDE the unanimity set — the
    // aggregate layer projects only when EVERY contributing canonical record
    // carries the SAME known layer. An all-null set, a known/unknown mixture
    // or two different known layers all aggregate as null; nothing is
    // inferred from a profile, filename or owner when the record's own
    // canonical layer field is absent.
    group.layers.add(record.layer ?? null);
    group.rank += typeof record.rank === 'number' ? record.rank : 0;
    group.symbolKeys.push(record.symbolKey);
  }
  const roles = [...groups.values()].map(group => ({
    role: group.role,
    layer: group.layers.size === 1 && !group.layers.has(null) ? [...group.layers][0] : null,
    rank: group.rank,
    symbolKeys: group.symbolKeys.sort(cmpKey),
  }));

  const byRankThenKey = (a, b) => (rankNumber(b.rank) - rankNumber(a.rank)) || cmpKey(a.symbolKey, b.symbolKey);
  return {
    status: 'resolved',
    target: resolved.symbolKey ?? resolved.target,
    dependents: dependents.sort(byRankThenKey),
    tests: tests.sort(byRankThenKey),
    roles: roles.sort((a, b) => (rankNumber(b.rank) - rankNumber(a.rank)) || cmpKey(a.role, b.role)),
    rankModel: {
      algorithm: 'PageRank',
      damping: PAGERANK_DEFAULTS.damping,
      tolerance: PAGERANK_DEFAULTS.tolerance,
      maxIterations: PAGERANK_DEFAULTS.maxIterations,
      iterations: ranking.iterations,
      converged: ranking.converged,
      scope: 'full-known-canonical-dependencies',
    },
  };
}
