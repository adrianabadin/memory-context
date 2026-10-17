import { HASH_VERSION } from './hash.mjs';

// N5A (plan 3.5 / S11): opt-in narrative invalidation. A current symbol
// supplies its own narrativeHash to opt in; stored-only narrativeHash
// metadata on legacy entries never changes old codeHash/hashVersion
// behavior. null/undefined mean "not supplied" (legacy path); any other
// malformed explicit value rejects with TypeError before any output.
function readCurrentNarrativeHash(sym) {
  const value = sym.narrativeHash;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`narrativeHash must be a non-empty string when supplied for '${sym.symbolKey}'`);
  }
  return value;
}

export function computeSymbolDelta(currentSymbols, existingWorklist, { hashVersion = HASH_VERSION } = {}) {
  const narrativeHashes = new Map();
  for (const sym of currentSymbols) {
    narrativeHashes.set(sym.symbolKey, readCurrentNarrativeHash(sym));
  }

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
    const currentNarrativeHash = narrativeHashes.get(sym.symbolKey);
    if (!existing) {
      new_.push({
        ...sym,
        status: 'pending',
        memoryId: null,
        graphNodeId: null,
        hashVersion,
      });
    } else if (currentNarrativeHash !== null) {
      // Opt-in narrative invalidation: the fingerprint comparison is
      // authoritative and runs before hashVersion migration so a migration
      // can never mask an explicit current narrativeHash change.
      if (existing.narrativeHash === currentNarrativeHash) {
        unchanged.push({
          ...existing,
          codeHash: sym.codeHash,
          hashVersion,
          narrativeHash: currentNarrativeHash,
          verifiedAt: new Date().toISOString(),
        });
      } else {
        stale.push({
          ...sym,
          status: 'stale',
          staleReason: 'narrative-hash-changed',
          memoryId: existing.memoryId,
          graphNodeId: existing.graphNodeId ?? null,
          hashVersion,
        });
      }
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
