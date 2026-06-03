# Agent Memory SQLite Migration Design

**Date:** 2026-06-03
**Status:** Approved
**Scope:** `agent-memory-mcp/` only — `tools/project-memory-context` is not affected

---

## Why

`agent-memory-mcp` currently uses LanceDB as its storage backend. LanceDB lacks cross-row transactions, causing five active concurrency problems:

1. `store`/`storeBatch`/`delete` have no serialization
2. `touchAccessed` is a racy read-delete-add on every search
3. `update()` uses non-atomic delete-then-add (OCC incomplete)
4. No retry/backoff on cross-process conflicts
5. Real exposure: the sync CLI opens its own server on the same `MEMORY_DB_PATH` as the live agent

**Why SQLite:** `node:sqlite` is built into Node 22.5+ (the project's minimum engine), WAL mode resolves cross-process concurrency via OS-level locking without any additional code, and ACID transactions eliminate the structural races. It also simplifies future packaging: it removes LanceDB's platform-specific native binaries.

---

## Expected outcome

- `SqliteMemoryStore` implements the same `MemoryStore` interface as `LanceMemoryStore`
- Correct concurrency: WAL multi-reader + automatic write serialization
- Hybrid search: FTS5 (BM25 built-in) + JS cosine similarity + manual RRF(k=60)
- One-shot automatic migration on first start (LanceDB → SQLite)
- `agent-memory-mcp` continues as `@aabadin/agent-memory-mcp` with the same MCP interface
- Temporal decay, forgetting algorithms, and all existing logic are preserved
- Zero new dependencies (only `node:sqlite` built-in)

---

## SQLite Schema

```sql
-- Main table (same fields as MemoryRow, no vector column)
CREATE TABLE IF NOT EXISTS memories (
  id               TEXT PRIMARY KEY,
  content          TEXT NOT NULL,
  category         TEXT NOT NULL,
  tags             TEXT NOT NULL,      -- JSON array: '["tag1","tag2"]'
  created_at       TEXT NOT NULL,      -- ISO-8601
  updated_at       TEXT NOT NULL,
  access_count     INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1
);

-- FTS5 for BM25 search (built-in SQLite, zero deps)
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED,
  content,
  tags,
  tokenize='unicode61',
  content='memories',
  content_rowid='rowid'
);

-- Embeddings as Float32 BLOB (~4×dim bytes per row)
CREATE TABLE IF NOT EXISTS memory_embeddings (
  id        TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL
);

-- FTS5 sync triggers
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, id, content, tags)
    VALUES (new.rowid, new.id, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, id, content, tags)
    VALUES ('delete', old.rowid, old.id, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, id, content, tags)
    VALUES ('delete', old.rowid, old.id, old.content, old.tags);
  INSERT INTO memories_fts(rowid, id, content, tags)
    VALUES (new.rowid, new.id, new.content, new.tags);
END;

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA synchronous=NORMAL;   -- safe with WAL, better performance
```

---

## File Architecture

```
agent-memory-mcp/src/
  sqlite-store.ts     ← NEW: SqliteMemoryStore implements MemoryStore
  store-factory.ts    ← NEW: createStore() — detect, migrate, return store
  migrate.ts          ← NEW: migrateLanceToSqlite() one-shot
  index.ts            ← MODIFY: use createStore() instead of new LanceMemoryStore()
  memory-store.ts     ← UNCHANGED (kept as legacy/backup)
  hardcopy-store.ts   ← UNCHANGED (decorates any MemoryStore)
  types.ts            ← UNCHANGED (MemoryStore interface unchanged)
  errors.ts           ← UNCHANGED
```

---

## Hybrid Search (no new dependencies)

```
search(query, mode, filters):
  if mode === 'hybrid' || mode === 'keyword':
    bm25Results ← SELECT id, bm25(memories_fts) AS score
                  FROM memories_fts WHERE memories_fts MATCH ?
  if mode === 'hybrid' || mode === 'semantic':
    queryVec ← embedder.embed(query)
    candidates ← SELECT m.id, e.embedding
                  FROM memories m JOIN memory_embeddings e USING (id)
    semanticResults ← cosineRank(queryVec, candidates)  // JS Float32Array
  if mode === 'hybrid':
    return rrf(bm25Results, semanticResults, k=60)       // manual RRF in JS
  apply filters (category, tags, date range) + decay scoring
```

**Performance estimate:** 10k memories × 384 dims ≈ 10ms cosine scan in JS V8. Acceptable. `sqlite-vec` can be added as an optional extension later if needed.

---

## Concurrency Fix Matrix

| Operation | Before (LanceDB) | After (SQLite WAL) |
|-----------|------------------|-------------------|
| `update()` | delete-then-add, non-atomic | `BEGIN / UPDATE SET ... WHERE id=? AND version=N / COMMIT` — atomic |
| `touchAccessed()` | read-delete-add racy, errors swallowed | `UPDATE SET access_count=access_count+1, last_accessed_at=? WHERE id=?` — atomic |
| `store`/`storeBatch` | no serialization | `BEGIN / INSERT / COMMIT` transaction |
| `delete()` | no version guard | `DELETE WHERE id=?` with rows-affected check |
| cross-process | no lock | WAL OS-level locking, automatic |

---

## Migration Strategy (one-shot)

```
migrateLanceToSqlite(lanceDbPath, sqliteDbPath, embedder):
  1. Open LanceMemoryStore(lanceDbPath, embedder)
  2. await store.initialize()
  3. await store.listRecent(999999) → allMemories
  4. For each memory: fetch raw embedding vector
  5. INSERT OR REPLACE INTO memories (...) in batch transaction
  6. INSERT OR REPLACE INTO memory_embeddings (id, embedding)
  7. INSERT INTO memories_fts(memories_fts) VALUES('rebuild')
  8. Write sentinel: writeFile(join(lanceDbPath, '.migrated'), timestamp)
  9. LanceDB path left intact as backup (not deleted)

createStore(dbPath, embedder):
  sentinelPath = join(dbPath + '-lance', '.migrated')
  lanceExists = existsSync(dbPath + '-lance')
  sqliteExists = existsSync(dbPath + '.db')
  if lanceExists && !sqliteExists && !existsSync(sentinelPath):
    await migrateLanceToSqlite(...)
  return new SqliteMemoryStore(dbPath + '.db', embedder)
```

**Path convention:** `MEMORY_DB_PATH` (e.g. `~/.cache/agent-memory`) stays the same env var. SQLite file will be at `${MEMORY_DB_PATH}.db`.

---

## Internal Utilities

| Utility | Signature | Purpose |
|---------|-----------|---------|
| `embeddingToBlob` | `(vec: number[]) => Buffer` | `Float32Array` → `Buffer` |
| `blobToEmbedding` | `(blob: Buffer) => number[]` | inverse |
| `cosineDistance` | `(a: number[], b: number[]) => number` | dot product / magnitude |
| `rrf` | `(lists: {id,score}[][], k=60) => {id,score}[]` | Reciprocal Rank Fusion |

---

## Existing Utilities to Reuse

- `MemoryStore` interface in `src/types.ts` — unchanged, implemented by `SqliteMemoryStore`
- `ConcurrentUpdateError`, `MemoryNotFoundError` in `src/errors.ts` — unchanged
- `computeDecayFactor`, `parseDecayHalfLife` in `src/memory-store.ts` — export and reuse in sqlite-store.ts
- `importanceMultiplier` in `src/memory-store.ts` — export and reuse
- `HardcopyMemoryStore` in `src/hardcopy-store.ts` — unchanged, decorates any `MemoryStore`
- `MockEmbedder` in `tests/mocks.ts` — reuse in all new tests

---

## Node Engine Requirement

`node:sqlite` requires Node ≥ 22.5.0. The `agent-memory-mcp/package.json` `engines` field must be bumped from `>=18.0.0` to `>=22.5.0`.

---

## End-to-End Verification Checklist

1. `npm test` in `agent-memory-mcp/` — all tests pass (existing + new)
2. Real concurrency test: two Node instances writing simultaneously to the same `.db` — no corruption, correct memory count
3. Migration test: create a LanceDB store with data, start new server → `.migrated` sentinel appears, data in SQLite
4. `pmc sync-context` on the repo → entries sync correctly to the SQLite store
5. `pmc enrich --stale-only` → agent searches SQLite, correct results
