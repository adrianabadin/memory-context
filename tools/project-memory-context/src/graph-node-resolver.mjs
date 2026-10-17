function normalizePath(value) {
  let normalized = String(value ?? '').replace(/\\/g, '/');
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}

function normalizeGraphifyLabel(value) {
  return String(value ?? '').replace(/^\./, '').replace(/\(\)$/, '');
}

function validId(node) {
  return typeof node?.id === 'string' && node.id.trim().length > 0;
}

function explicitKind(node) {
  return node?.metadata?.kind ?? node?.kind ?? null;
}

function lineFromLocation(value) {
  if (typeof value !== 'string') return null;
  const match = /^L(\d+)(?:-L?(\d+))?$/i.exec(value.trim());
  if (!match) return null;
  const line = Number(match[1]);
  const endLine = match[2] == null ? line : Number(match[2]);
  return Number.isSafeInteger(line) && line > 0
    && Number.isSafeInteger(endLine) && endLine >= line
    ? line
    : null;
}

function validSymbolLine(symbol) {
  const line = symbol?.range?.startLine;
  return Number.isSafeInteger(line) && line > 0 ? line : null;
}

function uniqueById(nodes) {
  const grouped = new Map();
  for (const node of nodes) {
    const group = grouped.get(node.id) ?? [];
    group.push(node);
    grouped.set(node.id, group);
  }
  const unique = [];
  for (const [id, group] of grouped) {
    if (group.length === 1 || group.every((node) => sameCandidate(group[0], node))) {
      unique.push(group[0]);
    } else {
      // Conflicting descriptions for one id cannot provide deterministic identity.
      unique.push({ ...group[0], id: `\0ambiguous:${id}` });
    }
  }
  return unique;
}

function sameCandidate(left, right) {
  return left.id === right.id
    && left.label === right.label
    && (left.source_file ?? left.filePath) === (right.source_file ?? right.filePath)
    && (left.source_location ?? left.metadata?.source_location) === (right.source_location ?? right.metadata?.source_location)
    && explicitKind(left) === explicitKind(right)
    && left.metadata?.symbolKey === right.metadata?.symbolKey
    && left.symbolKey === right.symbolKey;
}

function matchResult(node, reason = null) {
  return node ? { node, reason: null } : { node: null, reason };
}

function explicitSymbolKeys(node) {
  return [node.metadata?.symbolKey, node.symbolKey]
    .filter((value) => typeof value === 'string' && value.length > 0);
}

function resolveOne(graphNodes, symbol) {
  const usableNodes = graphNodes.filter(validId);
  const key = typeof symbol?.symbolKey === 'string' ? symbol.symbolKey : null;
  if (key) {
    const claimsThroughEitherKey = usableNodes.some((node) => {
      const metadataKey = node.metadata?.symbolKey;
      const legacyKey = node.symbolKey;
      return typeof metadataKey === 'string' && typeof legacyKey === 'string'
        && metadataKey !== legacyKey
        && (metadataKey === key || legacyKey === key);
    });
    if (claimsThroughEitherKey) return matchResult(null, 'ambiguous');

    const exact = usableNodes.filter((node) => {
      const metadataKey = node.metadata?.symbolKey;
      if (typeof metadataKey === 'string' && metadataKey.length > 0) return metadataKey === key;
      return node.symbolKey === key;
    });
    const uniqueExact = uniqueById(exact);
    if (uniqueExact.length > 1 || uniqueExact.some((node) => node.id.startsWith('\0ambiguous:'))) {
      return matchResult(null, 'ambiguous');
    }
    if (uniqueExact.length === 1) return matchResult(uniqueExact[0]);
  }

  const filePath = normalizePath(symbol?.filePath);
  const fileNodes = usableNodes.filter((node) => normalizePath(node.source_file ?? node.filePath) === filePath);
  if (!filePath || fileNodes.length === 0) return matchResult(null, 'no-file-node');

  const labelNodes = fileNodes.filter((node) => {
    if (normalizeGraphifyLabel(node.label) !== symbol?.name) return false;
    const keys = explicitSymbolKeys(node);
    if (keys.some((candidateKey) => candidateKey !== key)) return false;
    const nodeKind = explicitKind(node);
    return !nodeKind || !symbol?.kind || nodeKind === symbol.kind;
  });
  if (labelNodes.length === 0) return matchResult(null, 'no-label-match');

  const candidates = uniqueById(labelNodes);
  if (candidates.length === 1 && !candidates[0].id.startsWith('\0ambiguous:')) {
    return matchResult(candidates[0]);
  }
  if (candidates.some((node) => node.id.startsWith('\0ambiguous:'))) return matchResult(null, 'ambiguous');

  const symbolLine = validSymbolLine(symbol);
  if (!symbolLine) return matchResult(null, 'ambiguous');
  const lineCandidates = candidates.map((node) => ({
    node,
    line: lineFromLocation(node.metadata?.source_location ?? node.source_location),
  }));
  if (lineCandidates.some(({ line }) => line == null)) return matchResult(null, 'ambiguous');
  lineCandidates.sort((a, b) => Math.abs(a.line - symbolLine) - Math.abs(b.line - symbolLine));
  if (lineCandidates.length > 1 && Math.abs(lineCandidates[0].line - symbolLine) === Math.abs(lineCandidates[1].line - symbolLine)) {
    return matchResult(null, 'ambiguous');
  }
  return matchResult(lineCandidates[0].node);
}

function resolveSymbols({ symbols, graph }) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  return (Array.isArray(symbols) ? symbols : []).map((symbol) => {
    const { node, reason } = resolveOne(nodes, symbol);
    const resolved = { ...symbol, graphNodeId: node?.id ?? null };
    delete resolved.resolutionReason;
    Object.defineProperty(resolved, 'resolutionReason', {
      value: reason,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    return resolved;
  });
}

export function attachGraphNodeIds({ symbols, graph }) {
  return resolveSymbols({ symbols, graph });
}

/**
 * Return { total, resolved, unresolved, nullRate, reasons, symbols }.
 * symbols are copied resolved records; resolutionReason is an own, non-enumerable
 * diagnostic property, available to callers but omitted by spread and JSON serialization.
 * Empty inputs have a nullRate of zero.
 */
export function resolverReport({ symbols, graph }) {
  const resolvedSymbols = resolveSymbols({ symbols, graph });
  const total = resolvedSymbols.length;
  const resolved = resolvedSymbols.filter((symbol) => symbol.graphNodeId != null).length;
  const reasons = { 'no-file-node': 0, 'no-label-match': 0, ambiguous: 0 };
  for (const symbol of resolvedSymbols) {
    if (symbol.resolutionReason) reasons[symbol.resolutionReason] += 1;
  }
  return {
    total,
    resolved,
    unresolved: total - resolved,
    nullRate: total === 0 ? 0 : (total - resolved) / total,
    reasons,
    symbols: resolvedSymbols,
  };
}
