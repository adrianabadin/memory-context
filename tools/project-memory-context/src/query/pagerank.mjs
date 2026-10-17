// src/query/pagerank.mjs
//
// F4B / S15: pure, dependency-free PageRank used by `pmc_impact` to rank
// dependents, covering tests and affected roles. "New ranking must be
// deterministic and dependency-free; no LLM-generated relationship facts."
//
// Contracts kept here:
//   * PURE: no imports, no I/O, no graph store, no database, no timers, no
//     persistent cache or state. Input arrays/objects are never mutated and
//     are validated strictly BEFORE any computation; a violation throws
//     TypeError instead of silently ignoring bad input.
//   * The graph is the CALLER's full known graph — one node per canonical
//     key, one directed edge per dependency pair (source depends on target,
//     so rank flows from a dependency to the nodes that point at it). The
//     same node therefore carries the SAME score regardless of which target
//     a later query asks about; scores are never impact-closure relative.
//   * Directed neighbour pairs are deduplicated (a repeated pair never
//     double-weights one relationship), self loops are legal, and nodes are
//     processed in sorted key order with sorted adjacency, so results are
//     byte-identical for every node/edge insertion order.
//   * Dangling nodes (out-degree 0) redistribute their mass uniformly, the
//     teleport is uniform, and the total mass over a non-empty graph stays 1
//     in every iteration. Iteration is bounded (default 100, matching Aider's
//     repo-map parameters): a graph that has not met the tolerance reports
//     `converged: false` together with its honest finite approximation —
//     never a fake success and never an unbounded loop.
//   * Keys are held in Maps (and any object projection must go through
//     Object.fromEntries), so `__proto__`-shaped canonical keys stay own
//     properties instead of being lost to prototype assignment.
//
// These numeric parameters are an implementation detail of the ranking, NOT
// new user-facing knobs: the MCP `pmc_impact` signature stays `{target}` only.

/** Documented implementation defaults (Aider repo-map parameters). */
export const PAGERANK_DEFAULTS = Object.freeze({
  damping: 0.85,
  tolerance: 1e-8,
  maxIterations: 100,
});

const isPlainObject = value =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function validateFiniteNumber(name, value, { min, max, minInclusive, maxInclusive }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number, got ${String(value)}`);
  }
  const belowMin = minInclusive ? value < min : value <= min;
  const aboveMax = maxInclusive ? value > max : value >= max;
  if (belowMin || aboveMax) {
    throw new TypeError(`${name} must satisfy ${minInclusive ? '[' : '('}${min}, ${max}${maxInclusive ? ']' : ')'}, got ${value}`);
  }
  return value;
}

/**
 * Compute PageRank scores for one complete directed graph.
 *
 * @param {{
 *   nodes: string[],
 *   edges: Array<{source: string, target: string}>,
 *   damping?: number,
 *   tolerance?: number,
 *   maxIterations?: number,
 * }} options
 *   `nodes` — every known node key (unique, non-empty strings).
 *   `edges` — directed dependency pairs; both endpoints must be known nodes
 *   (an unknown endpoint is a caller bug and throws). Repeated pairs are
 *   deduplicated; extra edge properties are ignored.
 * @returns {{scores: Map<string, number>, iterations: number, converged: boolean, nodeCount: number}}
 */
export function computePageRank(options) {
  if (!isPlainObject(options)) throw new TypeError('computePageRank requires an options object');
  const allowed = new Set(['nodes', 'edges', 'damping', 'tolerance', 'maxIterations']);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new TypeError(`computePageRank accepts only documented options; unknown option '${key}'`);
  }

  const { nodes, edges } = options;
  if (!Array.isArray(nodes)) throw new TypeError('nodes must be an array of node keys');
  if (!Array.isArray(edges)) throw new TypeError('edges must be an array of {source, target} pairs');
  const damping = options.damping === undefined
    ? PAGERANK_DEFAULTS.damping
    : validateFiniteNumber('damping', options.damping, { min: 0, max: 1, minInclusive: true, maxInclusive: true });
  const tolerance = options.tolerance === undefined
    ? PAGERANK_DEFAULTS.tolerance
    : validateFiniteNumber('tolerance', options.tolerance, { min: 0, max: Infinity, minInclusive: false, maxInclusive: false });
  const maxIterations = options.maxIterations === undefined
    ? PAGERANK_DEFAULTS.maxIterations
    : (() => {
      if (typeof options.maxIterations !== 'number' || !Number.isFinite(options.maxIterations)) {
        throw new TypeError(`maxIterations must be a finite positive integer, got ${String(options.maxIterations)}`);
      }
      if (options.maxIterations < 1 || !Number.isInteger(options.maxIterations)) {
        throw new TypeError(`maxIterations must be a finite positive integer, got ${options.maxIterations}`);
      }
      return options.maxIterations;
    })();

  // Validate and canonicalize the node set before touching any edge.
  const seen = new Set();
  for (const node of nodes) {
    if (typeof node !== 'string' || node.length === 0) {
      throw new TypeError(`node keys must be non-empty strings, got ${String(node)}`);
    }
    if (seen.has(node)) throw new TypeError(`duplicate node key '${node}'`);
    seen.add(node);
  }
  const order = [...seen].sort(byKey);
  const index = new Map(order.map((key, position) => [key, position]));

  // Normalize edges: known endpoints only, directed pairs deduplicated.
  const adjacency = order.map(() => []);
  const pairs = new Set();
  for (const edge of edges) {
    if (!isPlainObject(edge)) throw new TypeError('every edge must be a {source, target} object');
    const { source, target } = edge;
    if (typeof source !== 'string' || typeof target !== 'string') {
      throw new TypeError('edge endpoints must be node key strings');
    }
    if (!index.has(source)) throw new TypeError(`edge source '${source}' is not a known node`);
    if (!index.has(target)) throw new TypeError(`edge target '${target}' is not a known node`);
    const pairKey = JSON.stringify([source, target]);
    if (pairs.has(pairKey)) continue; // dedup directed neighbour pairs: no double weights
    pairs.add(pairKey);
    adjacency[index.get(source)].push(index.get(target));
  }
  for (const list of adjacency) list.sort((a, b) => byKey(order[a], order[b]));

  const nodeCount = order.length;
  if (nodeCount === 0) {
    return { scores: new Map(), iterations: 0, converged: true, nodeCount: 0 };
  }

  const uniform = 1 / nodeCount;
  let rank = new Array(nodeCount).fill(uniform);
  let iterations = 0;
  let converged = false;
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    let danglingMass = 0;
    for (let i = 0; i < nodeCount; i += 1) {
      if (adjacency[i].length === 0) danglingMass += rank[i];
    }
    const base = (1 - damping) / nodeCount + (damping * danglingMass) / nodeCount;
    const next = new Array(nodeCount).fill(base);
    for (let i = 0; i < nodeCount; i += 1) {
      const outDegree = adjacency[i].length;
      if (outDegree === 0) continue; // dangling: mass already redistributed uniformly
      const share = (damping * rank[i]) / outDegree;
      for (const j of adjacency[i]) next[j] += share;
    }
    let delta = 0;
    for (let i = 0; i < nodeCount; i += 1) {
      const change = Math.abs(next[i] - rank[i]);
      if (change > delta) delta = change;
    }
    rank = next;
    iterations = iteration;
    if (delta < tolerance) { converged = true; break; }
  }

  return {
    scores: new Map(order.map((key, position) => [key, rank[position]])),
    iterations,
    converged,
    nodeCount,
  };
}
