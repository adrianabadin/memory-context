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
  return {
    ...graph,
    nodes: (graph.nodes ?? []).map((node) => {
      const matchesGraphNodeId = graphNodeId && node?.id === graphNodeId;
      const matchesSymbolKey = node?.metadata?.symbolKey === symbolKey;
      if (!matchesGraphNodeId && !matchesSymbolKey) {
        return node;
      }

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
