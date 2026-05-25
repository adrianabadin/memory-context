export function mergeGraphDelta(existing, delta) {
  const nodeMap = new Map();
  for (const node of existing.nodes) {
    nodeMap.set(node.id, node);
  }
  for (const node of delta.nodes) {
    nodeMap.set(node.id, node);
  }

  const edgeSet = new Set();
  const edges = [];
  for (const edge of existing.edges) {
    const key = `${edge.source}|${edge.target}|${edge.relation}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      edges.push(edge);
    }
  }
  for (const edge of delta.edges) {
    const key = `${edge.source}|${edge.target}|${edge.relation}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      edges.push(edge);
    }
  }

  return { nodes: [...nodeMap.values()], edges };
}

export function extractChangedFilesFromGraph(delta) {
  const files = new Set();
  for (const node of delta.nodes) {
    if (node.source_file) {
      files.add(node.source_file);
    }
  }
  return [...files];
}
