export function backfillGraphNode({
  graph,
  symbolKey,
  graphNodeId,
  memoryId,
  semanticSummary,
  codeHash,
  enrichedAt,
  status,
}) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  let targetIndex = -1;

  if (typeof graphNodeId === 'string' && graphNodeId.trim()) {
    const idMatches = nodes
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => node?.id === graphNodeId);
    if (idMatches.length === 1) {
      const [{ node, index }] = idMatches;
      const existingKeys = [node?.metadata?.symbolKey, node?.symbolKey]
        .filter((key) => typeof key === 'string' && key.length > 0);
      if (existingKeys.every((key) => key === symbolKey)) targetIndex = index;
    }
  } else if (symbolKey != null) {
    const keyMatches = nodes
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => {
        if (node?.metadata?.symbolKey !== symbolKey) return false;
        const existingKeys = [node?.metadata?.symbolKey, node?.symbolKey]
          .filter((key) => typeof key === 'string' && key.length > 0);
        return existingKeys.every((key) => key === symbolKey);
      });
    if (keyMatches.length === 1) targetIndex = keyMatches[0].index;
  }

  return {
    ...graph,
    nodes: nodes.map((node, index) => {
      if (index !== targetIndex) return node;
      return {
        ...node,
        metadata: {
          ...node.metadata,
          symbolKey,
          graphNodeId: graphNodeId ?? node.id,
          memoryId,
          semanticSummary,
          codeHash,
          lastEnrichedAt: enrichedAt,
          enrichmentStatus: status,
        },
      };
    }),
  };
}
