# Agent Memory Concurrency Design

## Problem

`agent-memory-mcp` does not support concurrent writers safely. The `update()` method in `LanceMemoryStore` uses a delete-then-re-add pattern that creates a data loss window when multiple agents (e.g. Claude Code + OpenCode) point to the same `MEMORY_DB_PATH` simultaneously. Additionally, repeated invocations of the enrichment pipeline re-embed identical text through the ONNX model, adding unnecessary latency on warm runs.

## Use Case

Developer uses Claude Code and OpenCode interchangeably within a single project. Both agents share the same LanceDB path at `<repo>/.planning/project-memory-context/.memory`. Both can read and write memories concurrently. No namespace separation is needed — isolation is per-project via `MEMORY_DB_PATH`, not per-agent.

## Solution Overview

### 1. Optimistic Concurrency Control on `update()`

Add a `version: int32` column to the LanceDB schema (migration-safe via `addColumns` with SQL default `1`). The `update()` method reads the current version, performs `table.delete("id='X' AND version=N")`, and checks affected rows. If 0 rows deleted, another writer won, and a `ConcurrentUpdateError` is thrown. Callers (MCP tool handlers) should retry after re-reading the current state.

```
update(id, patch):
  row = fetchById(id)
  table.delete("id='X' AND version=N")    # conditional delete
  if affectedRows == 0 → throw ConcurrentUpdateError(id, N, currentVersion)
  table.add({...row, ...patch, version: N+1})
```

**Why not a transaction?** LanceDB does not expose cross-row transactions. Optimistic locking achieves equivalent safety for single-row updates at the cost of requiring client-side retry.

### 2. Atomic Hardcopy Writes

Replace `writeFile(path, json)` with `writeFile(path + '.tmp.{pid}', json)` + `rename(tmp, path)`. On both NTFS (Windows) and POSIX filesystems, `rename` is atomic within the same volume — the final path is either the old content or the new content, never a partial write.

### 3. Content-Addressed Embedding Cache

Persist embeddings as binary files at `{EMBEDDING_CACHE_PATH}/{SHA1(modelName:text)}.bin`. On cache hit, ONNX inference is skipped entirely. The SHA1 key includes the model name so changing `EMBEDDING_MODEL` automatically invalidates all cached entries without manual clearing. Cache writes use the same write-temp-rename pattern for atomicity.

## Schema Changes

| Column | Type | Default | Migration |
|--------|------|---------|-----------|
| `version` | `int32` | `1` | `addColumns([{name:'version', valueSql:'1'}])` — idempotent |

No existing columns change. Records created before this change read `version=1` and can be updated normally.

## Error Types

```typescript
class ConcurrentUpdateError extends Error {
  constructor(
    public readonly id: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number | null
  )
}
```

## New Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `EMBEDDING_CACHE_PATH` | No | — | Directory for binary embedding cache. Disabled if unset. |

## Files Affected

| File | Change |
|------|--------|
| `src/memory-store.ts` | Schema migration + optimistic delete |
| `src/types.ts` | Add `version?: number` to `Memory` |
| `src/hardcopy-store.ts` | write-temp-then-rename |
| `src/embedder.ts` | Cache lookup before ONNX inference |
| `src/index.ts` | Instantiate `EmbeddingCache` if env var set |
| `src/errors.ts` | NEW — `ConcurrentUpdateError` |
| `src/embedding-cache.ts` | NEW — content-addressed cache |

## Constraints

- Backward compatible: existing DBs without `version` column work (migration adds it with default `1`)
- `EMBEDDING_CACHE_PATH` is opt-in; omitting it preserves current behavior exactly
- Cache is write-once per key (content-addressed) → safe for concurrent readers/writers
