// src/query/role-traversal.mjs
//
// F4A1 / S13: the optional `stopAtRole` contract for `pmc_relations`.
// "traversals that stop at the first node with the target role" (v3 §49):
// a bounded BFS over exactly the requested direction/relations/depth where a
// node whose canonical role equals `stopAtRole` is RETAINED as boundary
// evidence but never expanded further (first match per traversed path, all
// ties/multiple boundaries kept in deterministic order).
//
// Contracts kept here:
//   * Roles come ONLY from the canonical `node_role_assignments` ledger via
//     `store.getNodeRole` — never from `node.metadata.roleClassification` or
//     any name/label/filename guess. Nodes without a role stay traversable and
//     simply never match.
//   * A member inherits its container's role only when the member has no own
//     assignment, its canonical key proves the container (the structured
//     `member` scope written by buildSymbolKey) and the registry resolves
//     exactly one same-file container of a container kind. An explicit unknown
//     member assignment is never overridden by inheritance.
//   * A container-level start (class/function/file) may expand to its proven
//     members as zero-distance seeds, and a matched member projects to its
//     uniquely resolved owner so a container-level query answers at
//     container level. A member-level start keeps member boundaries.
//   * Known-graph walk only: cycles bounded by the visited set, depth ≤ 3,
//     no edges beyond a matching node, no fabricated class-level edges.
import { buildFacts } from '../cards/facts.mjs';
import { buildFileCard } from '../cards/file-card.mjs';
import { loadProfile } from '../roles/classify.mjs';

// Canonical role vocabulary: the packaged profiles (generic plus the six
// profile overlays), read-only. Profiles are never written by this module.
const PROFILE_NAMES = ['generic', 'node-cli', 'express', 'nest', 'spring', 'aspnet', 'django'];
const CONTAINER_KINDS = new Set(['class', 'interface', 'enum', 'struct', 'trait', 'object', 'protocol', 'record']);

let vocabulary = null;
function builtinRoleNames() {
  if (vocabulary === null) {
    vocabulary = new Set();
    for (const name of PROFILE_NAMES) {
      for (const role of Object.keys(loadProfile(name).roleLayers)) vocabulary.add(role);
    }
  }
  return vocabulary;
}

/**
 * Structural parse of a canonical symbol key. Returns null for anything that
 * is not a well-formed generic six-part or C# seven-part key, so malformed
 * identities fail closed instead of being guessed.
 */
export function parseKey(key) {
  if (typeof key !== 'string') return null;
  const parts = key.split('|');
  if (parts.length === 6 && parts.every(Boolean)) {
    const member = parts[3] === 'member';
    const dot = member ? parts[4].lastIndexOf('.') : -1;
    return { path: parts[1], kind: parts[2], name: parts[4], member,
      container: member && dot > 0 ? parts[4].slice(0, dot) : null };
  }
  if (parts.length === 7 && parts[0] === 'csharp' && parts[1] && parts[4] && parts[5]) {
    const container = parts[3] !== 'none' && parts[3] !== '' ? parts[3] : null;
    return { path: parts[1], kind: parts[4], name: parts[5], member: container != null, container };
  }
  return null;
}

const layerOf = value =>
  typeof value === 'string' && value.length > 0 ? value : null;

/**
 * Shared canonical role/ownership resolver for the role-aware walkers (S13
 * `stopAtRole` and S14 `pmc_entrypoints_for`). It exposes exactly the two
 * primitives both walks need and nothing else:
 *
 *   * `roleDetails(key)` — `{role, layer}` from the canonical
 *     `node_role_assignments` ledger via `store.getNodeRole`, or `null`. An
 *     explicit assignment always wins, including an explicit unknown (null
 *     role), which never falls back to container inheritance. A member without
 *     its own assignment inherits only when its CURRENT node kind is
 *     role-eligible (`symbol`/`member`), its canonical key proves the
 *     container, and exactly one same-file container of a container kind
 *     resolves — fail closed otherwise (no foreign, prefix or ambiguous
 *     ownership guess, never `metadata.roleClassification`).
 *   * `provenContainerOf(key)` — the unique same-file registry container for a
 *     structured member key, or null.
 */
export function createRoleResolver(store, registryKeys) {
  const containerCache = new Map();
  const provenContainerOf = key => {
    if (containerCache.has(key)) return containerCache.get(key);
    const parsed = parseKey(key);
    let owner = null;
    if (parsed && parsed.member && parsed.container) {
      const owners = registryKeys.filter(candidate => {
        if (candidate === key) return false;
        const other = parseKey(candidate);
        return other !== null && !other.member && other.path === parsed.path &&
          other.name === parsed.container && CONTAINER_KINDS.has(other.kind);
      });
      if (owners.length === 1) owner = owners[0];
    }
    containerCache.set(key, owner);
    return owner;
  };

  const roleDetails = key => {
    const explicit = store.getNodeRole(key);
    // An explicit assignment always wins — including an explicit unknown
    // (null role), which must not fall back to container inheritance.
    if (explicit) {
      if (typeof explicit.role !== 'string' || explicit.role.length === 0) return null;
      return { role: explicit.role, layer: layerOf(explicit.layer) };
    }
    const parsed = parseKey(key);
    if (!parsed || !parsed.member || !parsed.container) return null;
    // Correction B2 (S13): the node's CURRENT kind must be role-eligible BEFORE
    // any inheritance runs — exactly the canonical node-roles.mjs allowed-kind
    // guard (`node_kind` symbol/member): a doc/config/data node never acquires
    // a role through container fallback, so it can neither match nor reach
    // owner projection.
    const current = store.getNode(key);
    if (!current || (current.node_kind !== 'symbol' && current.node_kind !== 'member')) return null;
    const containerKey = provenContainerOf(key);
    if (!containerKey) return null;
    const container = store.getNodeRole(containerKey);
    if (!container) return null;
    if (typeof container.role !== 'string' || container.role.length === 0) return null;
    return { role: container.role, layer: layerOf(container.layer) };
  };

  return { roleDetails, provenContainerOf };
}

/**
 * Validate the optional `stopAtRole` against the canonical vocabulary: the
 * packaged profile role names plus the roles actually assigned in this
 * project's canonical role ledger (so custom persisted roles are accepted
 * without any profile/config write). Returns the role name, `undefined` when
 * the option is absent, and throws TypeError for a non-empty-string violation
 * or an unknown role so an invalid predicate can never be ignored as success.
 */
export function resolveStopAtRole(context, stopAtRole) {
  if (stopAtRole === undefined) return undefined;
  if (typeof stopAtRole !== 'string' || stopAtRole.trim().length === 0) {
    throw new TypeError('stopAtRole must be a nonempty role name string');
  }
  if (builtinRoleNames().has(stopAtRole)) return stopAtRole;
  const assigned = typeof context.assignedRoleNames === 'function' ? context.assignedRoleNames() : [];
  if (assigned.includes(stopAtRole)) return stopAtRole;
  throw new TypeError(`stopAtRole must name a canonical role; unknown role '${stopAtRole}'`);
}

/**
 * Role-stopping bounded BFS for one resolved `pmc_relations` request.
 * Returns the default resolved shape (`status`/`target`/`direction`/`depth`/
 * `edges`, byte-compatible ordering) plus `stoppedAtRole` and `matches`
 * (`{symbolKey, role, distance, path}`; `distance` counts relation hops,
 * `path` is the full evidence chain from the start to the boundary).
 */
export async function walkRoleBoundary(context, { resolved, direction, relations, depth, stopAtRole }) {
  const { store, engine, endpoint } = context;
  const incoming = direction === 'in' || direction === 'inbound';
  const symbolTarget = resolved.mode === 'symbol';
  const startKey = symbolTarget ? resolved.symbolKey : `file|${resolved.target}`;
  const registryKeys = Object.keys(context.symbolIndex);

  // Shared canonical role/ownership resolution (byte-exact S13 semantics via
  // createRoleResolver; S14 consumes the same helper with its layer).
  const { roleDetails, provenContainerOf } = createRoleResolver(store, registryKeys);
  const roleOf = key => {
    const details = roleDetails(key);
    return details === null ? null : details.role;
  };

  const edges = new Map();
  const put = edge => edges.set(JSON.stringify([
    edge.source.symbolKey ?? edge.source.id, edge.target.symbolKey ?? edge.target.id, edge.relation]), edge);

  const startParsed = parseKey(startKey);
  const startIsMember = symbolTarget && startParsed != null && startParsed.member;
  const parent = new Map();
  const walkPath = key => {
    const chain = [];
    for (let current = key; current != null; current = parent.get(current)) chain.push(current);
    return chain.reverse();
  };
  const matches = new Map();
  const recordBoundary = (key, role, distance) => {
    let boundaryKey = key;
    let extra = [];
    // Owner projection only for container-level starts, only through the
    // proven registry owner, never onto the start node itself, and only when
    // the owner ITSELF canonically carries the requested role (correction B1):
    // an owner whose own canonical role differs (or is absent/explicitly
    // unknown) is never advertised — the matching member stays the boundary.
    if (!startIsMember) {
      const owner = provenContainerOf(key);
      if (owner != null && owner !== startKey && roleOf(owner) === stopAtRole) { boundaryKey = owner; extra = [owner]; }
    }
    if (!matches.has(boundaryKey)) {
      matches.set(boundaryKey, { symbolKey: boundaryKey, role, distance, path: [...walkPath(key), ...extra] });
    }
  };

  // ── Seeds ────────────────────────────────────────────────────────────────
  parent.set(startKey, null);
  const visited = new Set([startKey]);
  // A matching start is the depth-0 boundary: no outgoing walk at all.
  const startRole = roleOf(startKey);
  if (startRole === stopAtRole) {
    recordBoundary(startKey, startRole, 0);
    return finish();
  }

  const expansion = [];
  if (symbolTarget) {
    if (startParsed && !startParsed.member) {
      // Proven member expansion: only canonical member keys whose structured
      // container resolves back to this exact start key, same file.
      for (const key of registryKeys) {
        if (key === startKey) continue;
        const member = parseKey(key);
        if (!member || !member.member || member.path !== startParsed.path) continue;
        if (provenContainerOf(key) === startKey) expansion.push(key);
      }
    }
  } else {
    for (const key of registryKeys) {
      const parsed = parseKey(key);
      if (parsed && parsed.path === resolved.target) expansion.push(key);
    }
  }

  let frontier = [startKey];
  expansion.sort();
  for (const key of expansion) {
    if (visited.has(key)) continue;
    visited.add(key);
    parent.set(key, startKey);
    const role = roleOf(key);
    if (role === stopAtRole) recordBoundary(key, role, 0);
    else frontier.push(key);
  }

  // ── Bounded BFS over exactly the requested direction/relations/depth ─────
  const engineTypes = symbolTarget ? relations : relations.filter(type => type !== 'imports');
  const symbolImports = symbolTarget && relations.includes('imports');
  const fileImports = !symbolTarget && relations.includes('imports');
  const bindings = symbolImports && incoming ? store.listNativeImportBindings() : [];
  const registrySnapshot = registryKeys;

  for (let hop = 1; hop <= depth && frontier.length > 0; hop++) {
    const active = [...frontier].sort();
    frontier = [];
    const hopEdges = new Map();
    const addCandidate = (source, target, relation, extra) => {
      hopEdges.set(JSON.stringify([source.symbolKey ?? source.id, target.symbolKey ?? target.id, relation]),
        { source, target, relation, ...(extra ?? {}) });
    };

    const symbolFrontier = active.filter(key => !key.startsWith('file|'));
    if (engineTypes.length > 0 && symbolFrontier.length > 0) {
      if (incoming) {
        const query = await engine.queryImpactScope({ symbolKeys: symbolFrontier, depth: 'compact', edgeTypes: engineTypes });
        for (const edge of query.edges) {
          const source = endpoint(engine.graphNodeIdToSymbolKey(edge.source));
          const target = endpoint(engine.graphNodeIdToSymbolKey(edge.target));
          if (source && target) addCandidate(source, target, edge.relation);
        }
      } else {
        for (const key of symbolFrontier) {
          const query = await engine.querySymbolContext({ symbolKey: key, depth: 'compact', edgeTypes: engineTypes });
          for (const edge of query.edges) {
            const source = endpoint(engine.graphNodeIdToSymbolKey(edge.source));
            const target = endpoint(engine.graphNodeIdToSymbolKey(edge.target));
            if (source && target) addCandidate(source, target, edge.relation);
          }
        }
      }
    }

    // File-scoped symbol import adjacency mirrors the default symbol-mode
    // contract (binding-resolved, marked scope: 'file'); file targets keep
    // the default file-mode contract instead.
    if (symbolImports) {
      for (const key of symbolFrontier) {
        const origin = endpoint(key);
        if (!origin) continue;
        const adjacent = [];
        if (!incoming) adjacent.push(...buildFacts(store, key).imports.map(item => item.symbolKey));
        else for (const binding of bindings) {
          if (binding.target?.id !== key) continue;
          for (const candidate of registrySnapshot) {
            const parts = candidate.split('|');
            if (parts[1] === binding.sourceId.slice(5) && parts[3] === 'exported') adjacent.push(candidate);
          }
        }
        for (const neighbor of adjacent) {
          const other = endpoint(neighbor);
          if (!other) continue;
          if (incoming) addCandidate(other, origin, 'imports', { scope: 'file' });
          else addCandidate(origin, other, 'imports', { scope: 'file' });
        }
      }
    }

    if (fileImports) {
      for (const key of active) {
        if (!key.startsWith('file|')) continue;
        const card = buildFileCard(store, key.slice('file|'.length));
        const origin = { id: `file|${card.path}`, path: card.path, kind: 'file' };
        for (const item of incoming ? card.importedBy : card.importsFrom) {
          if (incoming) addCandidate(item, origin, 'imports');
          else addCandidate(origin, item, 'imports');
        }
      }
    }

    // Deterministic processing: edges in sorted key order, first arrival wins
    // the parent slot, matched nodes are recorded but never expanded.
    for (const key of [...hopEdges.keys()].sort()) {
      const edge = hopEdges.get(key);
      put(edge);
      const sourceKey = edge.source.symbolKey ?? edge.source.id;
      const targetKey = edge.target.symbolKey ?? edge.target.id;
      const from = incoming ? targetKey : sourceKey;
      const to = incoming ? sourceKey : targetKey;
      if (!visited.has(from) || visited.has(to)) continue;
      visited.add(to);
      parent.set(to, from);
      const role = roleOf(to);
      if (role === stopAtRole) recordBoundary(to, role, hop);
      else frontier.push(to);
    }
  }

  return finish();

  function finish() {
    return {
      status: 'resolved',
      target: resolved.symbolKey ?? resolved.target,
      direction: incoming ? 'in' : 'out',
      depth,
      edges: [...edges.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      stoppedAtRole: stopAtRole,
      matches: [...matches.values()].sort((a, b) =>
        a.distance - b.distance || (a.symbolKey < b.symbolKey ? -1 : a.symbolKey > b.symbolKey ? 1 : 0)),
    };
  }
}
