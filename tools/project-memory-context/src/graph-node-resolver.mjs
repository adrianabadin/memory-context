function normalizePath(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

function getNodeMetadata(node) {
  return node?.metadata ?? {};
}

function findBySymbolKey(graph, symbolKey) {
  return (graph.nodes ?? []).find((node) => {
    const metadata = getNodeMetadata(node);
    return metadata.symbolKey === symbolKey || node.symbolKey === symbolKey;
  }) ?? null;
}

function findByFallback(graph, symbol) {
  const filePath = normalizePath(symbol.filePath);
  return (graph.nodes ?? []).find((node) => {
    const metadata = getNodeMetadata(node);
    const nodeFilePath = normalizePath(metadata.filePath ?? metadata.source_file ?? node.filePath);
    const nodeKind = metadata.kind ?? node.kind;
    const nodeLabel = node.label ?? metadata.name;
    return nodeFilePath === filePath && nodeKind === symbol.kind && nodeLabel === symbol.name;
  }) ?? null;
}

export function attachGraphNodeIds({ symbols, graph }) {
  return symbols.map((symbol) => {
    const matchedNode = findBySymbolKey(graph, symbol.symbolKey) ?? findByFallback(graph, symbol);
    return {
      ...symbol,
      graphNodeId: matchedNode?.id ?? symbol.graphNodeId ?? null,
    };
  });
}
