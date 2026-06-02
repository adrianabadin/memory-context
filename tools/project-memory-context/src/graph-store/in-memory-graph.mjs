// tools/project-memory-context/src/graph-store/in-memory-graph.mjs

function normalizePath(filePath) {
  return String(filePath ?? '').replace(/\\/g, '/');
}

/**
 * Creates a GraphStore backed by an in-memory adjacency scan over `graph`.
 * Used for: backward-compat when `createQueryEngine` receives a `graph` object,
 *           and as the reference implementation in parity tests.
 *
 * @param {{ nodes?: object[], links?: object[] }} graph
 * @returns {GraphStore}
 */
export function createInMemoryGraphStore(graph) {
  const nodeMap = new Map();
  for (const node of graph.nodes ?? []) {
    nodeMap.set(node.id, node);
  }
  const links = graph.links ?? [];

  function traverse({ nodeIds, maxHops, edgeTypes, direction }) {
    const types = edgeTypes ?? ['calls', 'imports', 'imports_from', 'contains', 'method'];
    const dir = direction ?? 'outbound';

    const visited = new Set();
    const resultNodes = [];
    const resultEdges = [];
    let frontier = [];

    for (const id of nodeIds) {
      const node = nodeMap.get(id);
      if (!node) continue;
      visited.add(id);
      resultNodes.push(node);
      frontier.push(id);
    }

    let depthReached = 0;

    for (let hop = 0; hop < maxHops; hop++) {
      const nextFrontier = [];
      for (const nodeId of frontier) {
        for (const link of links) {
          if (!types.includes(link.relation)) continue;
          let neighbor = null;
          if (dir === 'outbound' && link.source === nodeId) {
            neighbor = link.target;
          } else if (dir === 'inbound' && link.target === nodeId) {
            neighbor = link.source;
          }
          if (neighbor != null && !visited.has(neighbor)) {
            visited.add(neighbor);
            const neighborNode = nodeMap.get(neighbor);
            if (neighborNode) {
              resultNodes.push(neighborNode);
              resultEdges.push(link);
              nextFrontier.push(neighbor);
            }
          }
        }
      }
      if (nextFrontier.length === 0) break;
      frontier = nextFrontier;
      depthReached = hop + 1;
    }

    return { nodes: resultNodes, edges: resultEdges, depth_reached: depthReached };
  }

  return {
    getNode(id) {
      return nodeMap.get(id) ?? null;
    },

    getNodesByFile(filePath) {
      const normalized = normalizePath(filePath);
      const result = [];
      for (const node of nodeMap.values()) {
        if (normalizePath(node.source_file ?? '') === normalized) result.push(node);
      }
      return result;
    },

    traverse,

    close() {
      // No-op: nothing to release for in-memory store.
    },
  };
}
