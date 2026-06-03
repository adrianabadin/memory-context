import { HASH_VERSION } from './hash.mjs';

export function computeSymbolDelta(currentSymbols, existingWorklist, { hashVersion = HASH_VERSION } = {}) {
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
        hashVersion,
      });
    } else if (existing.hashVersion !== hashVersion) {
      // Hash algorithm changed — silent re-hash, no re-enrichment.
      // We cannot compare old (sha1/sha256) with new (xxh3) hashes directly,
      // so we trust the first post-migration run to baseline. Real code changes
      // will be caught on subsequent runs once both sides are XXH3.
      unchanged.push({
        ...existing,
        codeHash: sym.codeHash,
        hashVersion,
        verifiedAt: new Date().toISOString(),
      });
    } else if (existing.codeHash !== sym.codeHash) {
      stale.push({
        ...sym,
        status: 'stale',
        staleReason: 'code-hash-changed',
        memoryId: existing.memoryId,
        graphNodeId: existing.graphNodeId ?? null,
        hashVersion,
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
