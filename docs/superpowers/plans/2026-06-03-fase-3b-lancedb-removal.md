# FASE 3b — LanceDB Total Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove LanceDB from the `agent-memory-mcp` runtime entirely; move one-time migration to a standalone script; clean up package metadata.

**Architecture:** Extract the four decay functions (`computeDecayFactor`, `parseDecayHalfLife`, `importanceMultiplier`, `EVERGREEN_TAGS`) that `sqlite-store.ts` imports from `memory-store.ts` into a new `src/decay.ts`. Then delete `memory-store.ts` + `migrate.ts`, simplify `store-factory.ts`, and move the LanceDB migration path to `scripts/migrate-lance.ts` (devDependency-only). All existing tests that cover `LanceMemoryStore` are removed; the test suite stays green with the SQLite-only runtime.

**Tech Stack:** `node:sqlite` (built-in), `node:crypto` (SHA-256 for `scripts/migrate-lance.ts`), vitest, TypeScript strict, ES2022 modules. `@lancedb/lancedb` moves to `devDependencies` (used only by the offline script).

---

## File Map

| File | Action |
|------|--------|
| `src/decay.ts` | **NEW** — decay helpers extracted from `memory-store.ts` |
| `src/sqlite-store.ts` | **MODIFY** — import decay from `./decay.js` instead of `./memory-store.js` |
| `src/memory-store.ts` | **DELETE** — LanceDB runtime removed |
| `src/migrate.ts` | **DELETE** — migration runtime removed |
| `src/store-factory.ts` | **MODIFY** — remove auto-migration branch; `createStore()` opens SQLite directly |
| `scripts/migrate-lance.ts` | **NEW** — standalone one-time migration script (not compiled to dist/) |
| `package.json` | **MODIFY** — lance→devDeps, description, keywords, add scripts entry for migrate |
| `tsconfig.json` | **MODIFY** — exclude `scripts/` from main build output |
| `tests/migrate.test.ts` | **DELETE** — tests runtime migration which no longer exists |
| `tests/integration.test.ts` | **MODIFY** — remove `LanceMemoryStore` integration block |

---

## Task 1: Extract decay helpers to `src/decay.ts`

`sqlite-store.ts` imports `computeDecayFactor`, `parseDecayHalfLife`, `importanceMultiplier`, `EVERGREEN_TAGS` from `memory-store.ts`. We need to move these before we can delete that file.

**Files:**
- Create: `agent-memory-mcp/src/decay.ts`
- Modify: `agent-memory-mcp/src/sqlite-store.ts`

- [ ] **Step 1: Create `src/decay.ts`**

```typescript
// agent-memory-mcp/src/decay.ts

export const EVERGREEN_TAGS = new Set(['evergreen', 'never-forget']);

/**
 * Parse the MEMORY_DECAY_HALF_LIFE env var into a number of days.
 * Returns 30 (default) if undefined; 0 if explicitly "0" (disables decay).
 */
export function parseDecayHalfLife(value: string | undefined): number {
  if (value === undefined) return 30;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? 30 : Math.max(0, parsed);
}

/**
 * Exponential decay factor based on how old `updatedAt` is.
 * Returns 1.0 if halfLifeDays <= 0 (decay disabled).
 */
export function computeDecayFactor(updatedAt: string, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1.0;
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  const ageDays = Math.max(0, ageMs / 86_400_000);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Multiplier applied to half-life based on memory importance signals.
 * High-importance memories decay more slowly.
 */
export function importanceMultiplier(row: Record<string, unknown>): number {
  const tags: string[] = (() => {
    try {
      const raw = row['tags'];
      return Array.isArray(raw) ? raw : JSON.parse(String(raw ?? '[]'));
    } catch {
      return [];
    }
  })();

  if (tags.some(t => EVERGREEN_TAGS.has(t))) return Infinity;
  if (tags.includes('important') || tags.includes('critical')) return 4;
  if (tags.includes('architecture') || tags.includes('decision')) return 2;
  return 1;
}
```

- [ ] **Step 2: Update `src/sqlite-store.ts` import**

Replace the import at lines 19–23 of `sqlite-store.ts`:

Old:
```typescript
import {
  computeDecayFactor,
  parseDecayHalfLife,
  importanceMultiplier,
  EVERGREEN_TAGS,
} from './memory-store.js';
```

New:
```typescript
import {
  computeDecayFactor,
  parseDecayHalfLife,
  importanceMultiplier,
  EVERGREEN_TAGS,
} from './decay.js';
```

- [ ] **Step 3: Build to confirm no TS errors**

```bash
cd agent-memory-mcp && npm run build
```

Expected: `dist/` rebuilt with no TypeScript errors.

- [ ] **Step 4: Run tests to confirm nothing broke**

```bash
cd agent-memory-mcp && npm test
```

Expected: all 138 tests pass (same count as before).

- [ ] **Step 5: Commit**

```bash
cd agent-memory-mcp
git add src/decay.ts src/sqlite-store.ts
git commit -m "refactor(decay): extract decay helpers to src/decay.ts — prep for LanceDB removal"
```

---

## Task 2: Create standalone migration script

This script encapsulates the entire one-time migration logic. It is **not** compiled to `dist/` — run with `npx tsx`.

**Files:**
- Create: `agent-memory-mcp/scripts/migrate-lance.ts`

- [ ] **Step 1: Create `scripts/migrate-lance.ts`**

```typescript
#!/usr/bin/env npx tsx
/**
 * One-time offline migration: LanceDB → SQLite.
 *
 * Usage:
 *   npx tsx scripts/migrate-lance.ts
 *
 * Reads MEMORY_DB_PATH from env. If a LanceDB directory exists at that
 * path and SQLite does NOT exist at `${path}.db`, migrates all memories
 * and writes a .migrated sentinel. Safe to run multiple times.
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import { SqliteMemoryStore } from '../src/sqlite-store.js';
import { TransformersEmbedder } from '../src/embedder.js';

async function main() {
  const dbPath = process.env.MEMORY_DB_PATH;
  if (!dbPath) {
    console.error('MEMORY_DB_PATH is required');
    process.exit(1);
  }

  const sqlitePath = `${dbPath}.db`;
  const sentinelPath = join(dbPath, '.migrated');

  if (!existsSync(dbPath)) {
    console.log('No LanceDB directory found — nothing to migrate.');
    return;
  }
  if (existsSync(sentinelPath)) {
    console.log('Already migrated (.migrated sentinel found) — skipping.');
    return;
  }
  if (existsSync(sqlitePath)) {
    console.log('SQLite file already exists — skipping migration.');
    return;
  }

  console.log(`Migrating ${dbPath} → ${sqlitePath} ...`);

  const modelName = process.env.EMBEDDING_MODEL ?? 'Xenova/bge-m3';
  const embedder = new TransformersEmbedder(modelName);
  await embedder.initialize();

  // ── Read from LanceDB ──
  const lanceConn = await lancedb.connect(dbPath);
  let lanceTable: lancedb.Table | null = null;
  let allRows: unknown[] = [];

  try {
    lanceTable = await lanceConn.openTable('memories');
    allRows = await lanceTable.query().execute();
  } catch (err) {
    console.error('Could not open LanceDB table "memories":', err);
    process.exit(1);
  }

  console.log(`Found ${allRows.length} memories in LanceDB.`);

  // ── Write to SQLite ──
  const sqlite = new SqliteMemoryStore(sqlitePath, embedder);
  await sqlite.initialize();

  if (allRows.length > 0) {
    const requests = allRows.map((row: any) => ({
      id: String(row.id),
      content: String(row.content),
      category: String(row.category),
      tags: (() => { try { return JSON.parse(String(row.tags ?? '[]')); } catch { return []; } })(),
      created_at: String(row.created_at ?? new Date().toISOString()),
      updated_at: String(row.updated_at ?? new Date().toISOString()),
      access_count: Number(row.access_count ?? 0),
      last_accessed_at: String(row.last_accessed_at ?? new Date().toISOString()),
      version: Number(row.version ?? 1),
    }));

    await sqlite.storeBatch(requests);
    console.log(`Migrated ${requests.length} memories to SQLite.`);
  }

  sqlite.close();

  // ── Write sentinel ──
  await writeFile(sentinelPath, new Date().toISOString(), 'utf8');
  console.log(`Migration complete. Sentinel written to ${sentinelPath}`);
  console.log(`LanceDB data preserved at ${dbPath} (safe to delete manually after verification).`);
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the script runs without crashing (smoke test with missing env var)**

```bash
cd agent-memory-mcp && npx tsx scripts/migrate-lance.ts 2>&1 | head -5
```

Expected: `MEMORY_DB_PATH is required` (exits with code 1 — that's correct, proves the script loads without import errors).

- [ ] **Step 3: Commit**

```bash
cd agent-memory-mcp
git add scripts/migrate-lance.ts
git commit -m "feat(scripts): add standalone migrate-lance.ts for one-time offline LanceDB migration"
```

---

## Task 3: Simplify `store-factory.ts`

Remove the auto-migration branch. `createStore()` simply creates the `SqliteMemoryStore` directly.

**Files:**
- Modify: `agent-memory-mcp/src/store-factory.ts`

- [ ] **Step 1: Write the updated `store-factory.ts`**

```typescript
// agent-memory-mcp/src/store-factory.ts
import { SqliteMemoryStore } from './sqlite-store.js';
import type { Embedder } from './types.js';

/**
 * Create a SqliteMemoryStore for the given base path.
 *
 * Path convention:
 *   MEMORY_DB_PATH = /some/path/agent-memory
 *   SQLite file    = /some/path/agent-memory.db
 *
 * For one-time migration from LanceDB, run:
 *   npx tsx scripts/migrate-lance.ts
 */
export async function createStore(
  dbPath: string,
  embedder: Embedder,
): Promise<SqliteMemoryStore> {
  const sqlitePath = `${dbPath}.db`;
  const store = new SqliteMemoryStore(sqlitePath, embedder);
  await store.initialize();
  return store;
}
```

- [ ] **Step 2: Build to confirm no errors**

```bash
cd agent-memory-mcp && npm run build
```

Expected: clean build.

- [ ] **Step 3: Run tests**

```bash
cd agent-memory-mcp && npm test
```

Expected: all tests pass (migrate.test.ts still exists but the `createStore` simplification may cause failures there — that's fine, we'll delete that test file in Task 5).

- [ ] **Step 4: Commit**

```bash
cd agent-memory-mcp
git add src/store-factory.ts
git commit -m "refactor(store-factory): remove auto-migration branch — SQLite only"
```

---

## Task 4: Delete `memory-store.ts` and `migrate.ts`

Both files are now unreferenced by the runtime.

**Files:**
- Delete: `agent-memory-mcp/src/memory-store.ts`
- Delete: `agent-memory-mcp/src/migrate.ts`

- [ ] **Step 1: Confirm nothing in `src/` imports these files**

```bash
cd agent-memory-mcp && grep -r "memory-store\|migrate" src/ --include="*.ts"
```

Expected output: **nothing** (both files are now unreferenced from `src/`).

- [ ] **Step 2: Delete the files**

```bash
cd agent-memory-mcp
rm src/memory-store.ts src/migrate.ts
```

- [ ] **Step 3: Build to confirm clean**

```bash
cd agent-memory-mcp && npm run build
```

Expected: clean build, no references to deleted files.

- [ ] **Step 4: Commit**

```bash
cd agent-memory-mcp
git add -A src/memory-store.ts src/migrate.ts
git commit -m "feat(lancedb-removal): delete LanceMemoryStore + migrate.ts from runtime"
```

---

## Task 5: Remove LanceDB tests and update integration test

**Files:**
- Delete: `agent-memory-mcp/tests/migrate.test.ts`
- Modify: `agent-memory-mcp/tests/integration.test.ts`

- [ ] **Step 1: Delete `tests/migrate.test.ts`**

```bash
cd agent-memory-mcp && rm tests/migrate.test.ts
```

- [ ] **Step 2: Read `tests/integration.test.ts` to identify the LanceMemoryStore block**

Open `tests/integration.test.ts` and find the `describe('LanceMemoryStore integration', ...)` block. Remove it entirely — keep only the `SqliteMemoryStore integration` describe block (if one exists) or the temporal-decay integration tests.

```bash
cd agent-memory-mcp && grep -n "LanceMemoryStore\|lancedb\|LanceDb" tests/integration.test.ts
```

Use the line numbers to identify the full `describe` block and remove it from the file.

- [ ] **Step 3: Run the full test suite**

```bash
cd agent-memory-mcp && npm test
```

Expected: all remaining tests pass. The count will be lower (migrate.test.ts had 7 tests, integration had a LanceMemoryStore block with ~30 tests — only the non-Lance tests remain). Confirm `0 failed`.

- [ ] **Step 4: Commit**

```bash
cd agent-memory-mcp
git add -A tests/migrate.test.ts tests/integration.test.ts
git commit -m "test: remove LanceDB test files (migrate.test.ts, integration LanceMemoryStore block)"
```

---

## Task 6: Update `package.json` and `tsconfig.json`

Move `@lancedb/lancedb` to `devDependencies`, clean up metadata, exclude `scripts/` from the main build.

**Files:**
- Modify: `agent-memory-mcp/package.json`
- Modify: `agent-memory-mcp/tsconfig.json`

- [ ] **Step 1: Update `package.json`**

Make these changes:
1. Move `"@lancedb/lancedb": "^0.26.2"` from `dependencies` to `devDependencies`
2. Update `"description"`: change to `"MCP server for agent memory backed by SQLite (WAL mode) with hybrid FTS5 BM25 + cosine vector search"`
3. Update `"keywords"`: remove `"lancedb"`, keep `["mcp", "memory", "sqlite", "embeddings", "vector-search", "bm25", "agent"]`
4. Add to `scripts`: `"migrate": "tsx scripts/migrate-lance.ts"`

- [ ] **Step 2: Update `tsconfig.json` to exclude `scripts/` from main build**

Open `tsconfig.json`. Add an `"exclude"` array (or extend it if it exists) to exclude the scripts dir:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "scripts"]
}
```

- [ ] **Step 3: Build to confirm `dist/` does not include Lance references**

```bash
cd agent-memory-mcp && npm run build && grep -r "lancedb\|LanceMemoryStore" dist/ || echo "CLEAN: no lancedb in dist/"
```

Expected: `CLEAN: no lancedb in dist/`

- [ ] **Step 4: Confirm `@lancedb/lancedb` is still installable (it's in devDeps)**

```bash
cd agent-memory-mcp && npm ls @lancedb/lancedb
```

Expected: listed under devDependencies.

- [ ] **Step 5: Run full test suite one more time**

```bash
cd agent-memory-mcp && npm test
```

Expected: all tests pass, 0 failed.

- [ ] **Step 6: Final verification — no LanceDB in runtime source**

```bash
cd agent-memory-mcp && grep -r "lancedb\|LanceMemoryStore\|LanceDb" src/ --include="*.ts" || echo "CLEAN"
```

Expected: `CLEAN`

- [ ] **Step 7: Commit**

```bash
cd agent-memory-mcp
git add package.json tsconfig.json
git commit -m "chore(lancedb-removal): move @lancedb/lancedb to devDeps, clean metadata, exclude scripts/ from build"
```

---

## Verification Summary

After all tasks:

```bash
# 1. All tests green
cd agent-memory-mcp && npm test
# Expected: X passed (0 failed), no LanceDB tests

# 2. No lancedb in runtime source
grep -r "lancedb\|LanceMemoryStore" src/ --include="*.ts" || echo "CLEAN"
# Expected: CLEAN

# 3. No lancedb in dist/
npm run build && grep -r "lancedb" dist/ || echo "CLEAN dist"
# Expected: CLEAN dist

# 4. store-factory creates SQLite directly
node -e "
const { createStore } = await import('./dist/store-factory.js');
const { MockEmbedder } = await import('./tests/mocks.ts'); // tsx only
console.log(createStore.toString().includes('migrate') ? 'FAIL: migration still present' : 'PASS: no migration');
"

# 5. Offline script available
ls scripts/migrate-lance.ts
# Expected: file exists
```
