import { backfillGraphNode } from './graph-backfill.mjs';
import { upsertSymbolIndexEntry } from './symbol-index.mjs';

export function applyEnrichmentResult({ graph, symbolIndex, result }) {
  const updatedGraph = backfillGraphNode({
    graph,
    symbolKey: result.symbolKey,
    graphNodeId: result.graphNodeId,
    memoryId: result.memoryId,
    semanticSummary: result.semanticSummary,
    codeHash: result.codeHash,
    enrichedAt: result.enrichedAt,
    status: result.status,
  });

  const updatedIndex = upsertSymbolIndexEntry(symbolIndex, {
    symbolKey: result.symbolKey,
    graphNodeId: result.graphNodeId,
    memoryId: result.memoryId,
    codeHash: result.codeHash,
    status: result.status,
    lastEnrichedAt: result.enrichedAt,
  });

  return {
    graph: updatedGraph,
    symbolIndex: updatedIndex,
  };
}
