export function upsertSymbolIndexEntry(index, entry) {
  return {
    ...index,
    [entry.symbolKey]: {
      memoryId: entry.memoryId ?? null,
      graphNodeId: entry.graphNodeId ?? null,
      codeHash: entry.codeHash,
      status: entry.status,
      lastEnrichedAt: entry.lastEnrichedAt ?? null,
    },
  };
}

export function findGraphNodeIdByMemoryId(index, memoryId) {
  for (const entry of Object.values(index)) {
    if (entry.memoryId === memoryId) {
      return entry.graphNodeId ?? null;
    }
  }
  return null;
}

export function findMemoryIdByGraphNodeId(index, graphNodeId) {
  for (const entry of Object.values(index)) {
    if (entry.graphNodeId === graphNodeId) {
      return entry.memoryId ?? null;
    }
  }
  return null;
}
