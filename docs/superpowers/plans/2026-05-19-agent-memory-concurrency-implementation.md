# Agent Memory Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `agent-memory-mcp` safe for concurrent writers (e.g. Claude Code + OpenCode sharing the same `MEMORY_DB_PATH`) by adding optimistic concurrency control to `update()`, atomic hardcopy writes, and a content-addressed embedding cache to eliminate redundant ONNX inference.

**Architecture:** Add a `version` column to LanceDB schema via idempotent migration. `update()` does a conditional `delete("id=X AND version=N")` and throws `ConcurrentUpdateError` if 0 rows deleted (another writer won). Hardcopy writes use write-temp-then-rename. Embedding cache stores `Float32Array` as binary files keyed by `SHA1(modelName:text)`.

**Tech Stack:** TypeScript ES2022, Vitest, `@lancedb/lancedb`, `@huggingface/transformers`, `node:crypto`, `node:fs/promises`.

**Design spec:** `docs/superpowers/specs/2026-05-19-agent-memory-concurrency-design.md`

---

## Task 1: Schema Migration — Add `version` Column

**Files:**
- Modify: `agent-memory-mcp/src/memory-store.ts`
- Modify: `agent-memory-mcp/tests/integration.test.ts`

- [ ] **Step 1: Write the failing test**

  Add to `tests/integration.test.ts`:

  ```typescript
  test('schema includes version column with default 1', async () => {
    const store = new LanceMemoryStore(tmpDir, embedder);
    await store.initialize();
    const mem = await store.store({ content: 'test', category: 'other', tags: [] });
    expect((mem as any).version).toBe(1);
  });

  test('schema migration adds version=1 to legacy records', async () => {
    // Pre-seed DB without version column, then re-initialize
    // After initialize(), fetched record must have version=1
  });
  ```

  Run `npm test -- integration.test.ts` → fails (no `version` field).

- [ ] **Step 2: Implementation**

  In `memory-store.ts`, locate `migrateSchema()` (around line 80). Add:

  ```typescript
  await this.addColumnIfMissing('version', '1', new arrow.Int32());
  ```

  Reuse the existing `addColumnIfMissing` helper pattern (or create it if the pattern is `try/catch addColumns`). SQL default `'1'` ensures all legacy rows get `version=1`.

  Update the row construction in `store()` and `update()` to include `version: 1` (store) and `version: existing.version + 1` (update — to be fully wired in Task 2).

- [ ] **Step 3: Verify**

  ```bash
  cd agent-memory-mcp
  npm test -- integration.test.ts
  ```
  Both new tests pass. All existing integration tests remain green.

---

## Task 2: Optimistic Locking in `update()`

**Files:**
- Create: `agent-memory-mcp/src/errors.ts`
- Modify: `agent-memory-mcp/src/types.ts`
- Modify: `agent-memory-mcp/src/memory-store.ts`
- Create: `agent-memory-mcp/tests/concurrent-update.test.ts`

- [ ] **Step 1: Write the failing test**

  Create `tests/concurrent-update.test.ts`:

  ```typescript
  import { describe, test, expect } from 'vitest';
  import { LanceMemoryStore } from '../src/memory-store.js';
  import { ConcurrentUpdateError } from '../src/errors.js';
  import { MockEmbedder } from './mocks.js';
  import { mkdtemp, rm } from 'node:fs/promises';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';

  describe('optimistic concurrency', () => {
    test('second concurrent update throws ConcurrentUpdateError', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'concurrent-'));
      try {
        const store = new LanceMemoryStore(dir, new MockEmbedder());
        await store.initialize();
        const mem = await store.store({ content: 'original', category: 'other', tags: [] });

        // Read the same record twice (simulating two clients)
        const v1 = await store.getById(mem.id);
        const v2 = await store.getById(mem.id);

        // First update succeeds
        await store.update(v1!.id, { content: 'updated by client A' });

        // Second update must fail — version is now stale
        await expect(
          store.update(v2!.id, { content: 'updated by client B' })
        ).rejects.toThrow(ConcurrentUpdateError);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test('ConcurrentUpdateError carries id and version info', async () => {
      // Similar setup, verify error.id, error.expectedVersion
    });
  });
  ```

  Run `npm test -- concurrent-update.test.ts` → fails (class not found).

- [ ] **Step 2: Create `errors.ts`**

  ```typescript
  export class ConcurrentUpdateError extends Error {
    constructor(
      public readonly id: string,
      public readonly expectedVersion: number,
      public readonly actualVersion: number | null
    ) {
      super(
        `Concurrent update conflict on memory ${id}: ` +
        `expected version ${expectedVersion}, ` +
        `actual version ${actualVersion ?? 'deleted'}`
      );
      this.name = 'ConcurrentUpdateError';
    }
  }

  export class MemoryNotFoundError extends Error {
    constructor(public readonly id: string) {
      super(`Memory not found: ${id}`);
      this.name = 'MemoryNotFoundError';
    }
  }
  ```

- [ ] **Step 3: Update `types.ts`**

  Add `version?: number` to the `Memory` interface.

- [ ] **Step 4: Rewrite `update()` in `memory-store.ts` (lines 201–230)**

  ```typescript
  async update(id: string, updates: UpdateRequest): Promise<Memory> {
    const existing = await this.fetchById(id);
    if (!existing) throw new MemoryNotFoundError(id);

    const expectedVersion = existing.version ?? 1;
    const needsReEmbed = updates.content !== undefined && updates.content !== existing.content;

    const updatedRow = {
      ...existing,
      ...updates,
      updated_at: new Date().toISOString(),
      version: expectedVersion + 1,
      vector: needsReEmbed
        ? await this.embedder.embed(updates.content!)
        : existing.vector,
    };

    // Conditional delete: only succeeds if version hasn't changed
    await this.table.delete(`id = '${sanitise(id)}' AND version = ${expectedVersion}`);

    // Check if our delete matched anything (LanceDB doesn't return affected rows directly)
    // Re-fetch to verify: if still exists with same version, we lost the race
    const afterDelete = await this.fetchById(id);
    if (afterDelete !== null) {
      // Row still exists — our delete predicate didn't match → concurrent writer won
      throw new ConcurrentUpdateError(id, expectedVersion, afterDelete.version ?? null);
    }

    await this.table.add([updatedRow]);
    return this.rowToMemory(updatedRow);
  }
  ```

  > **Note on LanceDB affected rows:** If `@lancedb/lancedb` v0.26+ exposes affected row count from `delete()`, prefer using that directly instead of the re-fetch check. Check the LanceDB changelog.

- [ ] **Step 5: Verify**

  ```bash
  npm test
  ```
  All tests green including concurrent-update tests and all pre-existing tests.

---

## Task 3: Atomic Hardcopy Writes

**Files:**
- Modify: `agent-memory-mcp/src/hardcopy-store.ts`
- Modify: `agent-memory-mcp/tests/hardcopy.test.ts`

- [ ] **Step 1: Write the failing test**

  Add to `tests/hardcopy.test.ts`:

  ```typescript
  test('no partial file left if process dies between write and rename', async () => {
    // Write to a temp path and verify that after rename the .tmp file is gone
    // and the final file is complete. Also verify no .tmp.* files linger.
    const id = 'test-atomic-id';
    await store.store({ content: 'atomic test', category: 'other', tags: [] });
    const files = await readdir(hardcopyDir);
    const tmpFiles = files.filter(f => f.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);
    expect(files.some(f => f === `${id}.json`)).toBe(true); // or check by content
  });
  ```

  Run `npm test -- hardcopy.test.ts` → passes (no tmp files visible — trivially true with current impl). We need a stronger test that intercepts the write.

  Alternatively, use a spy to verify `rename` is called instead of direct `writeFile` to the final path.

- [ ] **Step 2: Implementation**

  In `hardcopy-store.ts`, replace the write method:

  ```typescript
  import { writeFile, rename } from 'node:fs/promises';
  import { process } from 'node:process';

  private async writeMemory(memory: Memory): Promise<void> {
    const finalPath = join(this.hardcopyPath, `${memory.id}.json`);
    const tmpPath = `${finalPath}.tmp.${process.pid}`;
    try {
      await writeFile(tmpPath, JSON.stringify(memory, null, 2), 'utf-8');
      await rename(tmpPath, finalPath);
    } catch (err) {
      // Best-effort: clean up tmp on failure, then ignore
      try { await unlink(tmpPath); } catch {}
      console.error(`[hardcopy] Failed to write ${memory.id}:`, err);
    }
  }
  ```

- [ ] **Step 3: Verify**

  ```bash
  npm test -- hardcopy.test.ts
  ```
  Test passes. No `.tmp.*` files visible in the hardcopy directory after normal operation.

---

## Task 4: Content-Addressed Embedding Cache

**Files:**
- Create: `agent-memory-mcp/src/embedding-cache.ts`
- Create: `agent-memory-mcp/tests/embedding-cache.test.ts`
- Modify: `agent-memory-mcp/src/embedder.ts`
- Modify: `agent-memory-mcp/src/index.ts`
- Modify: `agent-memory-mcp/src/types.ts`

- [ ] **Step 1: Write the failing cache unit test**

  Create `tests/embedding-cache.test.ts`:

  ```typescript
  import { describe, test, expect, beforeEach, afterEach } from 'vitest';
  import { EmbeddingCache } from '../src/embedding-cache.js';
  import { mkdtemp, rm } from 'node:fs/promises';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';

  describe('EmbeddingCache', () => {
    let dir: string;
    let cache: EmbeddingCache;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'emb-cache-'));
      cache = new EmbeddingCache(dir, 'test-model');
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    test('returns null on cache miss', async () => {
      expect(await cache.get('unknown text')).toBeNull();
    });

    test('round-trips a Float32Array', async () => {
      const vec = new Float32Array([0.1, 0.2, 0.3]);
      await cache.set('hello world', vec);
      const retrieved = await cache.get('hello world');
      expect(retrieved).not.toBeNull();
      expect(Array.from(retrieved!)).toBeCloseTo(Array.from(vec));
    });

    test('different texts have different cache entries', async () => {
      await cache.set('text A', new Float32Array([1, 0]));
      await cache.set('text B', new Float32Array([0, 1]));
      const a = await cache.get('text A');
      const b = await cache.get('text B');
      expect(Array.from(a!)[0]).toBe(1);
      expect(Array.from(b!)[1]).toBe(1);
    });

    test('creates cache directory automatically', async () => {
      const nestedDir = join(dir, 'deep', 'nested');
      const nestedCache = new EmbeddingCache(nestedDir, 'model');
      await nestedCache.set('x', new Float32Array([1]));
      expect(await nestedCache.get('x')).not.toBeNull();
    });
  });
  ```

  Run `npm test -- embedding-cache.test.ts` → fails (module not found).

- [ ] **Step 2: Implement `embedding-cache.ts`**

  ```typescript
  import { createHash } from 'node:crypto';
  import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
  import { join } from 'node:path';

  export class EmbeddingCache {
    constructor(
      private readonly cacheDir: string,
      private readonly modelName: string
    ) {}

    private key(text: string): string {
      return createHash('sha1')
        .update(this.modelName + ':' + text)
        .digest('hex');
    }

    private filePath(text: string): string {
      return join(this.cacheDir, `${this.key(text)}.bin`);
    }

    async get(text: string): Promise<Float32Array | null> {
      try {
        const buf = await readFile(this.filePath(text));
        return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      } catch {
        return null;
      }
    }

    async set(text: string, vector: Float32Array): Promise<void> {
      await mkdir(this.cacheDir, { recursive: true });
      const finalPath = this.filePath(text);
      const tmpPath = `${finalPath}.tmp`;
      try {
        await writeFile(tmpPath, Buffer.from(vector.buffer));
        await rename(tmpPath, finalPath);
      } catch {
        // Best-effort
      }
    }
  }
  ```

- [ ] **Step 3: Write the failing embedder integration test**

  Add to `tests/tools.test.ts` or a new `tests/embedder-cache.test.ts`:

  ```typescript
  test('embed() only calls ONNX model once for repeated text when cache is set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'emb-'));
    const cache = new EmbeddingCache(dir, 'Xenova/bge-m3');
    const embedder = new TransformersEmbedder('Xenova/bge-m3', 4, 'cls', cache);
    // MockEmbedder variant that counts invocations
    let callCount = 0;
    const spy = vi.spyOn(embedder as any, 'runModel').mockImplementation(async () => {
      callCount++;
      return new Float32Array([1, 2, 3, 4]);
    });
    await embedder.initialize();

    await embedder.embed('same text');
    await embedder.embed('same text');

    expect(callCount).toBe(1); // model called only once
  });
  ```

- [ ] **Step 4: Wire cache into `TransformersEmbedder`**

  Update constructor signature:
  ```typescript
  constructor(
    modelName: string = DEFAULT_MODEL,
    dimensions?: number,
    pooling?: string,
    private readonly cache?: EmbeddingCache   // NEW optional param
  )
  ```

  Update `embed()`:
  ```typescript
  async embed(text: string): Promise<number[]> {
    if (this.cache) {
      const cached = await this.cache.get(text);
      if (cached) return Array.from(cached);
    }
    const result = await this.runModel(text);
    if (this.cache) {
      await this.cache.set(text, new Float32Array(result));
    }
    return result;
  }
  ```

  Extract existing ONNX call into private `runModel(text)` for testability.

  Update `embedBatch()`: per-text cache lookup, batch only the misses, then fill cache for each result.

- [ ] **Step 5: Wire in `index.ts`**

  ```typescript
  const cachePath = process.env.EMBEDDING_CACHE_PATH;
  const cache = cachePath ? new EmbeddingCache(cachePath, modelName) : undefined;
  const embedder = new TransformersEmbedder(modelName, dimensions, pooling, cache);
  ```

- [ ] **Step 6: Verify**

  ```bash
  npm test
  npm run build
  ```
  All tests green. Build succeeds with no TypeScript errors.

---

## Task 5: Documentation

**Files:**
- Modify: `agent-memory-mcp/CLAUDE.md`
- Modify: `agent-memory-mcp/README.md`

- [ ] **Step 1: Update CLAUDE.md env var table**

  Add row:
  ```
  | `EMBEDDING_CACHE_PATH` | No | — | Directory for binary embedding cache. Speeds up repeated runs significantly. |
  ```

- [ ] **Step 2: Add README sections**

  Add **Concurrent Access** section:
  > Multiple MCP clients can safely point to the same `MEMORY_DB_PATH`. `update()` uses optimistic concurrency control — if two clients update the same memory simultaneously, one succeeds and the other receives a `ConcurrentUpdateError`. Clients should handle this by re-reading the current state and retrying.

  Add **Embedding Cache** section:
  > Set `EMBEDDING_CACHE_PATH` to a persistent directory to skip ONNX inference for previously-seen text. Recommended for development and CI. Cache is invalidated automatically when `EMBEDDING_MODEL` changes.

---

## End-to-End Verification

```bash
cd agent-memory-mcp

# Full test suite
npm test

# TypeScript compilation
npm run build

# Smoke: concurrent clients
# Terminal 1:
MEMORY_DB_PATH=/tmp/shared-db EMBEDDING_CACHE_PATH=/tmp/emb-cache npm start
# Terminal 2 (same command):
MEMORY_DB_PATH=/tmp/shared-db EMBEDDING_CACHE_PATH=/tmp/emb-cache npm start
# Via MCP client: store a memory on T1, update on T1 and T2 simultaneously
# → one succeeds, other receives ConcurrentUpdateError in JSON response
```
