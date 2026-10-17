// src/query/entrypoints.mjs
//
// F4A2 / S14: `pmc_entrypoints_for(target)` — complete reverse `calls`
// reachability with a role-aware result.
//
// Plan 4.2: "reverse reachability to roles `entrypoint`, `cli-command`,
// `mcp-tool`, `controller`, or route handlers"; v3 purpose: "Which CLI
// commands, MCP tools, routes, or `main` functions reach X".
//
// Contracts kept here:
//   * Roles/layers come ONLY from the canonical `node_role_assignments`
//     ledger through the shared `createRoleResolver` (the same corrected S13
//     helper) — never from `node.metadata.roleClassification` and never from a
//     name/label/filename guess. Explicit unknowns, excluded node kinds and
//     unproven ownership never match or inherit.
//   * The walk is COMPLETE reverse `calls` reachability over known graph keys:
//     iterative, visited-set bounded (a cycle visits each key once), no hop
//     cap, and no cut at a matching controller/entrypoint — upstream matches
//     are still reached. Only actual call relations are followed (native and
//     legacy through the existing adapter, with its endpoint coherence and
//     constructor-edge exclusions preserved); imports/aliases/other relation
//     types are never walked as calls, and no class-level call edge is
//     invented — membership expansion stays zero-hop evidence.
//   * `matches` is the deduplicated union of application entrypoint evidence
//     (canonical role `entrypoint`/`cli-command`/`mcp-tool`, or ANY canonical
//     layer `entrypoint` — which is how the fixture's role `cli` main
//     qualifies without touching the fixture) and controller evidence
//     (canonical role `controller`; express route handlers are classified
//     `controller`). `entrypoints` and `controllers` are the two projections
//     of that union and may overlap when the canonical data justifies it;
//     dedup key is the canonical symbol key, so no category ever wins by
//     accident.
//   * `distance` counts actual call hops; registry membership expansion of a
//     class/file target is zero-hop with the membership step shown in
//     `path`. A recognized entrypoint/controller start records a truthful
//     distance-0 match AND keeps walking upstream (S14 is complete
//     reachability, not the S13 stop-at-role cut). Frontier and edge
//     processing are sorted, so shortest-path ties resolve by canonical key
//     independent of database insertion order.
import { createRoleResolver, parseKey } from './role-traversal.mjs';

// Canonical plan-4.2 role vocabulary (v3: the roles whose nodes answer "which
// CLI command / MCP tool / route / main reaches X"). Roles outside this set
// are still classified through their canonical layer, never by name guess.
const ENTRYPOINT_ROLES = new Set(['entrypoint', 'cli-command', 'mcp-tool']);
const CONTROLLER_ROLE = 'controller';

const isEntrypointEvidence = details =>
  ENTRYPOINT_ROLES.has(details.role) || details.layer === 'entrypoint';
const isControllerEvidence = details => details.role === CONTROLLER_ROLE;
const isMatchEvidence = details => isEntrypointEvidence(details) || isControllerEvidence(details);

export async function walkEntrypoints(context, { resolved }) {
  const { store, engine, endpoint } = context;
  const registryKeys = Object.keys(context.symbolIndex);
  const { roleDetails, provenContainerOf } = createRoleResolver(store, registryKeys);

  const matchDetails = key => {
    const details = roleDetails(key);
    if (details === null) return null;
    return isMatchEvidence(details) ? details : null;
  };

  const startKey = resolved.mode === 'symbol' ? resolved.symbolKey : `file|${resolved.target}`;
  const startParsed = parseKey(startKey);

  // ── Seeds: proven registry membership only ────────────────────────────────
  // A container expands to its OWN proven current registry members, a file to
  // its exact-path registry symbols. Foreign files, name prefixes and
  // ambiguous same-file containers never expand; class-level call edges are
  // never fabricated.
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

  const parent = new Map();
  const walkPath = key => {
    const chain = [];
    for (let current = key; current != null; current = parent.get(current)) chain.push(current);
    return chain.reverse();
  };
  const matches = new Map();
  const record = (key, details, distance) => {
    if (matches.has(key)) return; // first arrival is the BFS shortest path
    matches.set(key, { symbolKey: key, role: details.role, layer: details.layer, distance, path: walkPath(key) });
  };

  const visited = new Set([startKey]);
  parent.set(startKey, null);
  const startDetails = matchDetails(startKey);
  if (startDetails !== null) record(startKey, startDetails, 0);
  let frontier = [startKey];
  for (const key of expansion) {
    if (visited.has(key)) continue;
    visited.add(key);
    parent.set(key, startKey);
    const details = matchDetails(key);
    if (details !== null) record(key, details, 0);
    frontier.push(key);
  }

  // ── Complete reverse `calls` reachability ─────────────────────────────────
  // Reverse `calls` reachability hop by hop over exactly `calls` relations
  // — the existing adapter's native+legacy call relations. A matched node is
  // recorded but still expanded (no early controller/entrypoint cut), and the
  // visited set keeps the walk finite on any graph.
  let hop = 0;
  while (frontier.length > 0) {
    hop += 1;
    const active = [...frontier].sort();
    frontier = [];
    const symbolFrontier = active.filter(key => !key.startsWith('file|'));
    if (symbolFrontier.length === 0) break; // file endpoints carry no call edges
  // One compact (one-hop) inbound impact query PER SORTED FRONTIER KEY, unioned
  // and deduplicated here BEFORE the stable BFS parent selection (S14 B1): the
  // shared legacy multi-seed scan marks a neighbor visited on its first tied
  // edge and drops the sibling edge before this walker ever sees it, so which
  // equal-distance diamond branch survives would follow database insertion
  // order. Single-seed queries give every frontier key its own fresh scan, the
  // union keeps the COMPLETE eligible one-hop candidate set, and the sorted-key
  // loop below then picks parents deterministically (smallest canonical edge
  // key wins) for every node/edge insertion order. Native+legacy mixing,
  // endpoint coherence and constructor-edge exclusions keep their existing
  // adapter contracts; no raw SQL, no fabricated edge, no depth cap, visited
  // keys stay finite.
    const hopEdges = new Map();
    for (const seed of symbolFrontier) { // active frontier is sorted; union order is deterministic
      const query = await engine.queryImpactScope({ symbolKeys: [seed], depth: 'compact', edgeTypes: ['calls'] });
      for (const edge of query.edges) {
        const source = endpoint(engine.graphNodeIdToSymbolKey(edge.source));
        const target = endpoint(engine.graphNodeIdToSymbolKey(edge.target));
        if (!source || !target) continue;
        hopEdges.set(JSON.stringify([source.symbolKey, target.symbolKey, edge.relation]),
          { source, target, relation: edge.relation });
      }
    }
    for (const edgeKey of [...hopEdges.keys()].sort()) {
      const edge = hopEdges.get(edgeKey);
      // Reverse walk: expand FROM the callee and advance TO its caller.
      const from = edge.target.symbolKey;
      const to = edge.source.symbolKey;
      if (!visited.has(from) || visited.has(to)) continue;
      visited.add(to);
      parent.set(to, from);
      const details = matchDetails(to);
      if (details !== null) record(to, details, hop);
      frontier.push(to);
    }
  }

  const ordered = [...matches.values()].sort((a, b) =>
    a.distance - b.distance || (a.symbolKey < b.symbolKey ? -1 : a.symbolKey > b.symbolKey ? 1 : 0));
  return {
    status: 'resolved',
    target: resolved.symbolKey ?? resolved.target,
    matches: ordered,
    entrypoints: ordered.filter(isEntrypointEvidence),
    controllers: ordered.filter(isControllerEvidence),
  };
}
