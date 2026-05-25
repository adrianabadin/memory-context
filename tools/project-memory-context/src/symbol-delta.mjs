export function computeSymbolDelta(currentSymbols, existingWorklist) {
  const existingMap = new Map(
    existingWorklist.map((entry) => [entry.symbolKey, entry])
  );

  const currentKeys = new Set(currentSymbols.map((s) => s.symbolKey));

  const new_ = [];
  const stale = [];
  const removed = [];
  const unchanged = [];

  for (const sym of currentSymbols) {
    const existing = existingMap.get(sym.symbolKey);
    if (!existing) {
      new_.push({
        ...sym,
        status: 'pending',
        memoryId: null,
        graphNodeId: null,
      });
    } else if (existing.codeHash !== sym.codeHash) {
      stale.push({
        ...sym,
        status: 'stale',
        staleReason: 'code-hash-changed',
        memoryId: existing.memoryId,
        graphNodeId: existing.graphNodeId ?? null,
      });
    } else {
      unchanged.push({
        ...existing,
        verifiedAt: new Date().toISOString(),
      });
    }
  }

  for (const entry of existingWorklist) {
    if (!currentKeys.has(entry.symbolKey)) {
      removed.push({ ...entry });
    }
  }

  return { new: new_, stale, removed, unchanged };
}
