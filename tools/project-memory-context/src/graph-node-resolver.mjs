function normalizePath(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

function getNodeMetadata(node) {
  return node?.metadata ?? {};
}

function extractLabelFromGraphify(raw) {
  return raw.replace(/^\./, '').replace(/\(\)$/, '');
}

function inferKindFromLabel(raw) {
  if (/^\./.test(raw)) return 'function';
  if (/\.\w+\(\)$/.test(raw)) return 'method';
  return null;
}

function findBySymbolKey(graph, symbolKey) {
  return (graph.nodes ?? []).find((node) => {
    const metadata = getNodeMetadata(node);
    return metadata.symbolKey === symbolKey || node.symbolKey === symbolKey;
  }) ?? null;
}

function findByFilePathAndName(graph, symbol) {
  const filePath = normalizePath(symbol.filePath);
  const candidates = (graph.nodes ?? []).filter((node) => {
    const nodeFilePath = normalizePath(node.source_file ?? node.filePath ?? '');
    return nodeFilePath === filePath;
  });

  const exact = candidates.find((node) => {
    const raw = node.label ?? '';
    const cleaned = extractLabelFromGraphify(raw);
    return cleaned === symbol.name;
  });
  if (exact) return exact;

  const inferable = candidates.find((node) => {
    const raw = node.label ?? '';
    const cleaned = extractLabelFromGraphify(raw);
    const inferredKind = inferKindFromLabel(raw);
    if (cleaned !== symbol.name) return false;
    if (!inferredKind) return true;
    if (symbol.kind === 'method' && inferredKind === 'function') return true;
    if (symbol.kind === inferredKind) return true;
    return false;
  });
  if (inferable) return inferable;

  const normLabel = (symbol.name ?? '').toLowerCase();
  return candidates.find((node) => (node.norm_label ?? '').toLowerCase() === normLabel) ?? null;
}

export function attachGraphNodeIds({ symbols, graph }) {
  return symbols.map((symbol) => {
    const matchedNode = findBySymbolKey(graph, symbol.symbolKey) ?? findByFilePathAndName(graph, symbol);
    return {
      ...symbol,
      graphNodeId: matchedNode?.id ?? symbol.graphNodeId ?? null,
    };
  });
}
