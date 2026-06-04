# FASE 3a — Global Context (Cross-Project Memory) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cross-project global memory store (`~/.pmc/global.db`) to `agent-memory-mcp` with 4 new MCP tools, and wire PMC's `init` and `refresh-context` to auto-register projects and sync curated metadata + errors.

**Architecture:** `agent-memory-mcp` gets a new `src/global/` module with `ProjectRegistry` (SQLite table `projects`), `ErrorStore` (table `errors` + FTS5 + embeddings, dedup by content_hash), and `SqliteGlobalStore` (orchestrates both). A `GlobalFactory` creates the global store from `PMC_GLOBAL_DB_PATH` (default `~/.pmc/global.db`). Four MCP tools (`register_project`, `sync_project_metadata`, `record_error`, `search_global_errors`) are added to `tools.ts`. On the PMC side, `src/global-sync.mjs` parses `KNOWN-ISSUES-AND-FIXES.md` and returns payloads; `cli/init.mjs` calls `register_project`; `cli/refresh-context.mjs` calls `sync_project_metadata` + auto-promotes errors via `record_error`. All PMC→MCP calls follow the existing pattern in `cli/sync.mjs` using `@modelcontextprotocol/sdk` client.

**Tech Stack:** `node:sqlite` (built-in), `node:crypto` (SHA-256 for content_hash), `node:os` (homedir for default path), vitest (agent-memory tests), `node:test` (PMC tests), TypeScript strict + ES2022 modules, `@modelcontextprotocol/sdk` client (PMC sync calls).

---

## File Map

### `agent-memory-mcp/` — new files

| File | Responsibility |
|------|----------------|
| `src/global/project-registry.ts` | `ProjectRegistry` class: `projects` table schema + upsert/get/list |
| `src/global/error-store.ts` | `ErrorStore` class: `errors` + FTS5 + `error_embeddings` + hybrid search |
| `src/global/global-store.ts` | `GlobalStore` interface + `SqliteGlobalStore` impl (orchestrates both) |
| `src/global/global-factory.ts` | `createGlobalStore()` — opens `~/.pmc/global.db` by default |
| `src/shared/vector-utils.ts` | Extracted from `sqlite-store.ts`: `embeddingToBlob`, `blobToEmbedding`, `cosineDistance`, `rrf`, `escapeFtsQuery` |

### `agent-memory-mcp/` — modified files

| File | Change |
|------|--------|
| `src/sqlite-store.ts` | Import vector utils from `./shared/vector-utils.js` |
| `src/tools.ts` | Add 4 handler functions + register in `registerTools` (accept optional `GlobalStore`) |
| `src/server.ts` | Pass `GlobalStore` to `registerTools` |
| `src/index.ts` | Create global store and pass to `createServer` |

### `agent-memory-mcp/tests/` — new test files

| File | Tests |
|------|-------|
| `tests/global/project-registry.test.ts` | register idempotent, upsert metadata, slug stable |
| `tests/global/error-store.test.ts` | insert + dedup, FTS+cosine+RRF, CASCADE delete, empty search |
| `tests/global/global-store.test.ts` | full interface with MockEmbedder |
| `tests/global/tools-global.test.ts` | 4 new tools via Zod schema + handler |

### `tools/project-memory-context/` — new files

| File | Responsibility |
|------|----------------|
| `src/global-sync.mjs` | Parse `KNOWN-ISSUES-AND-FIXES.md` → `record_error` payloads; `syncProjectToGlobal()` |

### `tools/project-memory-context/` — modified files

| File | Change |
|------|--------|
| `cli/init.mjs` | Call `register_project` via MCP client after installing templates |
| `cli/refresh-context.mjs` | Call `sync_project_metadata` + auto-promote errors after graph rebuild |

---

## Task 1: Extract vector utilities to `src/shared/vector-utils.ts`

`sqlite-store.ts` defines `embeddingToBlob`, `blobToEmbedding`, `cosineDistance`, `rrf`, `escapeFtsQuery` as private module-level functions. The error store will need the same utilities. Extract them to a shared module first.

**Files:**
- Create: `agent-memory-mcp/src/shared/vector-utils.ts`
- Modify: `agent-memory-mcp/src/sqlite-store.ts`

- [ ] **Step 1: Create `src/shared/vector-utils.ts`**

```typescript
// agent-memory-mcp/src/shared/vector-utils.ts

export function embeddingToBlob(vec: number[]): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  const view = new Float32Array(buf.buffer, buf.byteOffset, vec.length);
  view.set(vec);
  return buf;
}

export function blobToEmbedding(blob: Buffer | Uint8Array): number[] {
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const view = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  return Array.from(view);
}

export function cosineDistance(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return magA && magB ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
}

export function rrf(
  lists: Array<Array<{ id: string; score: number }>>,
  k = 60,
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach(({ id }, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

export function escapeFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(t => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}
```

- [ ] **Step 2: Update `src/sqlite-store.ts` to import from shared**

Replace the five function definitions (`embeddingToBlob`, `blobToEmbedding`, `cosineDistance`, `rrf`, `escapeFtsQuery`) with a single import at the top of the imports section:

```typescript
import {
  embeddingToBlob,
  blobToEmbedding,
  cosineDistance,
  rrf,
  escapeFtsQuery,
} from './shared/vector-utils.js';
```

Remove the five function bodies from `sqlite-store.ts` (lines 88–155 in the current file).

- [ ] **Step 3: Build + test**

```bash
cd agent-memory-mcp && npm run build && npm test
```

Expected: clean build, all 138 tests pass.

- [ ] **Step 4: Commit**

```bash
cd agent-memory-mcp
git add src/shared/vector-utils.ts src/sqlite-store.ts
git commit -m "refactor(vector-utils): extract to src/shared/vector-utils.ts — shared by sqlite-store and error-store"
```

---

## Task 2: Create `ProjectRegistry`

**Files:**
- Create: `agent-memory-mcp/src/global/project-registry.ts`
- Create: `agent-memory-mcp/tests/global/project-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// agent-memory-mcp/tests/global/project-registry.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectRegistry } from '../../src/global/project-registry.js';

let tmpDir: string;
let db: DatabaseSync;
let registry: ProjectRegistry;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pmc-project-registry-test-'));
  db = new DatabaseSync(join(tmpDir, 'global.db'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  registry = new ProjectRegistry(db);
  registry.ensureSchema();
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('ProjectRegistry', () => {
  it('computeId returns stable slug for same path', () => {
    const id1 = ProjectRegistry.computeId('/Users/me/projects/foo');
    const id2 = ProjectRegistry.computeId('/Users/me/projects/foo');
    assert.equal(id1, id2);
    assert.match(id1, /^[a-f0-9]{64}$/); // SHA-256 hex
  });

  it('computeId differs for different paths', () => {
    assert.notEqual(
      ProjectRegistry.computeId('/path/a'),
      ProjectRegistry.computeId('/path/b'),
    );
  });

  it('register creates a project record', () => {
    const rec = registry.register({
      name: 'my-project',
      rootPath: '/Users/me/my-project',
      objective: 'Build something great',
    });
    assert.equal(rec.name, 'my-project');
    assert.equal(rec.rootPath, '/Users/me/my-project');
    assert.equal(rec.objective, 'Build something great');
    assert.ok(rec.id.length === 64);
    assert.ok(rec.createdAt);
  });

  it('register is idempotent — second call updates lastSyncedAt, preserves createdAt', async () => {
    registry.register({ name: 'proj', rootPath: '/p' });
    await new Promise(r => setTimeout(r, 10));
    const second = registry.register({ name: 'proj', rootPath: '/p', objective: 'Updated' });
    const all = registry.list();
    assert.equal(all.length, 1);
    assert.equal(second.objective, 'Updated');
  });

  it('updateMetadata upserts fields without touching others', () => {
    const rec = registry.register({ name: 'p', rootPath: '/p', objective: 'Original' });
    registry.updateMetadata(rec.id, { architecture: 'microservices' });
    const got = registry.get(rec.id);
    assert.equal(got?.objective, 'Original');
    assert.equal(got?.architecture, 'microservices');
  });

  it('get returns null for unknown id', () => {
    assert.equal(registry.get('nonexistent'), null);
  });

  it('list returns all registered projects', () => {
    registry.register({ name: 'a', rootPath: '/a' });
    registry.register({ name: 'b', rootPath: '/b' });
    assert.equal(registry.list().length, 2);
  });
});
```

- [ ] **Step 2: Run tests to verify they FAIL**

```bash
cd agent-memory-mcp && npx vitest run tests/global/project-registry.test.ts
```

Expected: FAIL — `ProjectRegistry` not found.

- [ ] **Step 3: Implement `src/global/project-registry.ts`**

```typescript
// agent-memory-mcp/src/global/project-registry.ts
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  objective: string | null;
  stack: string | null;          // JSON string
  architecture: string | null;
  dependencies: string | null;   // JSON string
  minimap: string | null;        // JSON string
  createdAt: string;
  lastSyncedAt: string;
}

export interface ProjectMetadata {
  name: string;
  rootPath: string;
  objective?: string;
  stack?: unknown;
  architecture?: string;
  dependencies?: unknown;
  minimap?: unknown;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  root_path       TEXT NOT NULL,
  objective       TEXT,
  stack           TEXT,
  architecture    TEXT,
  dependencies    TEXT,
  minimap         TEXT,
  created_at      TEXT NOT NULL,
  last_synced_at  TEXT NOT NULL
);
`;

function rowToRecord(row: Record<string, unknown>): ProjectRecord {
  return {
    id: String(row['id']),
    name: String(row['name']),
    rootPath: String(row['root_path']),
    objective: row['objective'] != null ? String(row['objective']) : null,
    stack: row['stack'] != null ? String(row['stack']) : null,
    architecture: row['architecture'] != null ? String(row['architecture']) : null,
    dependencies: row['dependencies'] != null ? String(row['dependencies']) : null,
    minimap: row['minimap'] != null ? String(row['minimap']) : null,
    createdAt: String(row['created_at']),
    lastSyncedAt: String(row['last_synced_at']),
  };
}

export class ProjectRegistry {
  constructor(private readonly db: DatabaseSync) {}

  static computeId(rootPath: string): string {
    // Normalise separators for cross-platform stability
    const normalised = rootPath.replace(/\\/g, '/').toLowerCase();
    return createHash('sha256').update(normalised).digest('hex');
  }

  ensureSchema(): void {
    this.db.exec(SCHEMA);
  }

  register(metadata: ProjectMetadata): ProjectRecord {
    const id = ProjectRegistry.computeId(metadata.rootPath);
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO projects (id, name, root_path, objective, stack, architecture, dependencies, minimap, created_at, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name           = excluded.name,
        objective      = COALESCE(excluded.objective, projects.objective),
        stack          = COALESCE(excluded.stack, projects.stack),
        architecture   = COALESCE(excluded.architecture, projects.architecture),
        dependencies   = COALESCE(excluded.dependencies, projects.dependencies),
        minimap        = COALESCE(excluded.minimap, projects.minimap),
        last_synced_at = excluded.last_synced_at
    `).run(
      id,
      metadata.name,
      metadata.rootPath,
      metadata.objective ?? null,
      metadata.stack != null ? JSON.stringify(metadata.stack) : null,
      metadata.architecture ?? null,
      metadata.dependencies != null ? JSON.stringify(metadata.dependencies) : null,
      metadata.minimap != null ? JSON.stringify(metadata.minimap) : null,
      now,
      now,
    );

    return this.get(id)!;
  }

  updateMetadata(id: string, metadata: Partial<Omit<ProjectMetadata, 'name' | 'rootPath'>>): ProjectRecord {
    const now = new Date().toISOString();
    const fields: [string, unknown][] = [];

    if (metadata.objective !== undefined) fields.push(['objective', metadata.objective]);
    if (metadata.stack !== undefined) fields.push(['stack', JSON.stringify(metadata.stack)]);
    if (metadata.architecture !== undefined) fields.push(['architecture', metadata.architecture]);
    if (metadata.dependencies !== undefined) fields.push(['dependencies', JSON.stringify(metadata.dependencies)]);
    if (metadata.minimap !== undefined) fields.push(['minimap', JSON.stringify(metadata.minimap)]);
    fields.push(['last_synced_at', now]);

    const setClause = fields.map(([col]) => `${col} = ?`).join(', ');
    const values = fields.map(([, v]) => v);

    this.db.prepare(`UPDATE projects SET ${setClause} WHERE id = ?`).run(...values, id);
    return this.get(id)!;
  }

  get(id: string): ProjectRecord | null {
    const row = this.db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : null;
  }

  list(): ProjectRecord[] {
    const rows = this.db.prepare(`SELECT * FROM projects ORDER BY last_synced_at DESC`).all() as unknown as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }
}
```

- [ ] **Step 4: Run tests to verify they PASS**

```bash
cd agent-memory-mcp && npx vitest run tests/global/project-registry.test.ts
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
cd agent-memory-mcp
git add src/global/project-registry.ts tests/global/project-registry.test.ts
git commit -m "feat(global): add ProjectRegistry — projects table with stable ID + upsert metadata"
```

---

## Task 3: Create `ErrorStore`

**Files:**
- Create: `agent-memory-mcp/src/global/error-store.ts`
- Create: `agent-memory-mcp/tests/global/error-store.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// agent-memory-mcp/tests/global/error-store.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ErrorStore } from '../../src/global/error-store.js';
import { MockEmbedder } from '../mocks.js';

let tmpDir: string;
let db: DatabaseSync;
let store: ErrorStore;
const PROJECT_ID = 'test-project-id';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pmc-error-store-test-'));
  db = new DatabaseSync(join(tmpDir, 'global.db'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  // errors table has a FK to projects — insert a stub project row first
  db.exec(`CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL,
    objective TEXT, stack TEXT, architecture TEXT, dependencies TEXT, minimap TEXT,
    created_at TEXT NOT NULL, last_synced_at TEXT NOT NULL
  )`);
  db.prepare(`INSERT INTO projects VALUES (?,?,?,NULL,NULL,NULL,NULL,?,?)`)
    .run(PROJECT_ID, 'test', '/test', new Date().toISOString(), new Date().toISOString());
  store = new ErrorStore(db, new MockEmbedder());
  store.ensureSchema();
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('ErrorStore', () => {
  it('computeContentHash is deterministic', () => {
    const h1 = ErrorStore.computeContentHash('TypeError', 'null dereference');
    const h2 = ErrorStore.computeContentHash('TypeError', 'null dereference');
    assert.equal(h1, h2);
    assert.match(h1, /^[a-f0-9]{64}$/);
  });

  it('computeContentHash differs for different inputs', () => {
    assert.notEqual(
      ErrorStore.computeContentHash('TypeError', 'cause A'),
      ErrorStore.computeContentHash('TypeError', 'cause B'),
    );
  });

  it('record inserts an error and returns it', async () => {
    const rec = await store.record({
      projectId: PROJECT_ID,
      message: 'TypeError: cannot read x',
      rootCause: 'null dereference',
      fix: 'add null check before accessing x',
      source: 'manual',
    });
    assert.equal(rec.message, 'TypeError: cannot read x');
    assert.equal(rec.fix, 'add null check before accessing x');
    assert.equal(rec.source, 'manual');
    assert.ok(rec.id);
    assert.ok(rec.contentHash);
  });

  it('record is idempotent by content_hash — upserts on conflict', async () => {
    await store.record({ projectId: PROJECT_ID, message: 'E1', rootCause: 'C1', fix: 'F1', source: 'auto' });
    await store.record({ projectId: PROJECT_ID, message: 'E1', rootCause: 'C1', fix: 'F1 updated', source: 'auto' });
    const all = store.list();
    assert.equal(all.length, 1);
    assert.equal(all[0].fix, 'F1 updated');
  });

  it('different errors in different projects are separate rows', async () => {
    // Insert a second project
    db.prepare(`INSERT INTO projects VALUES (?,?,?,NULL,NULL,NULL,NULL,?,?)`)
      .run('project-2', 'test2', '/test2', new Date().toISOString(), new Date().toISOString());
    await store.record({ projectId: PROJECT_ID, message: 'Same error', rootCause: 'same', fix: 'fix A', source: 'auto' });
    await store.record({ projectId: 'project-2', message: 'Same error', rootCause: 'same', fix: 'fix B', source: 'auto' });
    // Same content_hash but different project_id — should be 2 rows
    assert.equal(store.list().length, 2);
  });

  it('search returns relevant errors by FTS keyword', async () => {
    await store.record({ projectId: PROJECT_ID, message: 'ECONNREFUSED database', rootCause: 'DB not running', fix: 'start the DB service', source: 'auto' });
    await store.record({ projectId: PROJECT_ID, message: 'SyntaxError in parser', rootCause: 'missing semicolon', fix: 'add semicolon', source: 'auto' });
    const results = await store.search('database connection refused');
    assert.ok(results.length >= 1);
    assert.ok(results[0].error.message.includes('ECONNREFUSED'));
  });

  it('search returns empty array on empty store', async () => {
    const results = await store.search('anything');
    assert.deepEqual(results, []);
  });

  it('search with projectId filter only returns errors from that project', async () => {
    db.prepare(`INSERT INTO projects VALUES (?,?,?,NULL,NULL,NULL,NULL,?,?)`)
      .run('other', 'other', '/other', new Date().toISOString(), new Date().toISOString());
    await store.record({ projectId: PROJECT_ID, message: 'error in project A', fix: 'fix A', source: 'auto' });
    await store.record({ projectId: 'other', message: 'error in project B', fix: 'fix B', source: 'auto' });
    const results = await store.search('error', PROJECT_ID);
    assert.ok(results.every(r => r.error.projectId === PROJECT_ID));
  });

  it('list() with no filter returns all errors', async () => {
    await store.record({ projectId: PROJECT_ID, message: 'e1', fix: 'f1', source: 'auto' });
    await store.record({ projectId: PROJECT_ID, message: 'e2', fix: 'f2', source: 'auto' });
    assert.equal(store.list().length, 2);
  });
});
```

- [ ] **Step 2: Run tests to verify FAIL**

```bash
cd agent-memory-mcp && npx vitest run tests/global/error-store.test.ts
```

Expected: FAIL — `ErrorStore` not found.

- [ ] **Step 3: Implement `src/global/error-store.ts`**

```typescript
// agent-memory-mcp/src/global/error-store.ts
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Embedder } from '../types.js';
import {
  embeddingToBlob,
  blobToEmbedding,
  cosineDistance,
  rrf,
  escapeFtsQuery,
} from '../shared/vector-utils.js';

export interface ErrorRecord {
  id: string;
  projectId: string;
  message: string;
  stack: string | null;
  rootCause: string | null;
  fix: string;
  files: string[] | null;
  tags: string[];
  source: 'auto' | 'manual';
  createdAt: string;
  contentHash: string;
}

export interface RecordErrorRequest {
  projectId: string;
  message: string;
  stack?: string;
  rootCause?: string;
  fix: string;
  files?: string[];
  tags?: string[];
  source: 'auto' | 'manual';
}

export interface ErrorSearchResult {
  error: ErrorRecord;
  projectName: string;
  score: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS errors (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  message      TEXT NOT NULL,
  stack        TEXT,
  root_cause   TEXT,
  fix          TEXT NOT NULL,
  files        TEXT,
  tags         TEXT NOT NULL DEFAULT '[]',
  source       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  content_hash TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS errors_content_hash_project
  ON errors(content_hash, project_id);

CREATE TABLE IF NOT EXISTS error_embeddings (
  id        TEXT PRIMARY KEY REFERENCES errors(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS errors_fts USING fts5(
  id UNINDEXED,
  message,
  root_cause,
  fix,
  tags,
  content='errors',
  content_rowid='rowid',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS errors_ai AFTER INSERT ON errors BEGIN
  INSERT INTO errors_fts(rowid, id, message, root_cause, fix, tags)
    VALUES (new.rowid, new.id, new.message, new.root_cause, new.fix, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS errors_ad AFTER DELETE ON errors BEGIN
  INSERT INTO errors_fts(errors_fts, rowid, id, message, root_cause, fix, tags)
    VALUES ('delete', old.rowid, old.id, old.message, old.root_cause, old.fix, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS errors_au AFTER UPDATE ON errors BEGIN
  INSERT INTO errors_fts(errors_fts, rowid, id, message, root_cause, fix, tags)
    VALUES ('delete', old.rowid, old.id, old.message, old.root_cause, old.fix, old.tags);
  INSERT INTO errors_fts(rowid, id, message, root_cause, fix, tags)
    VALUES (new.rowid, new.id, new.message, new.root_cause, new.fix, new.tags);
END;
`;

function rowToRecord(row: Record<string, unknown>): ErrorRecord {
  return {
    id: String(row['id']),
    projectId: String(row['project_id']),
    message: String(row['message']),
    stack: row['stack'] != null ? String(row['stack']) : null,
    rootCause: row['root_cause'] != null ? String(row['root_cause']) : null,
    fix: String(row['fix']),
    files: (() => { try { return JSON.parse(String(row['files'] ?? 'null')); } catch { return null; } })(),
    tags: (() => { try { return JSON.parse(String(row['tags'] ?? '[]')); } catch { return []; } })(),
    source: String(row['source']) as 'auto' | 'manual',
    createdAt: String(row['created_at']),
    contentHash: String(row['content_hash']),
  };
}

export class ErrorStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly embedder: Embedder,
  ) {}

  static computeContentHash(message: string, rootCause: string | null | undefined): string {
    return createHash('sha256')
      .update(message.trim())
      .update('\0')
      .update((rootCause ?? '').trim())
      .digest('hex');
  }

  ensureSchema(): void {
    this.db.exec(SCHEMA);
  }

  async record(req: RecordErrorRequest): Promise<ErrorRecord> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const contentHash = ErrorStore.computeContentHash(req.message, req.rootCause);
    const tags = JSON.stringify(req.tags ?? []);
    const files = req.files ? JSON.stringify(req.files) : null;

    // Compute embedding from: message + root_cause + fix (rich text for similarity)
    const embeddingText = [req.message, req.rootCause, req.fix].filter(Boolean).join('\n');
    const embedding = await this.embedder.embed(embeddingText);

    this.db.exec('BEGIN');
    try {
      this.db.prepare(`
        INSERT INTO errors (id, project_id, message, stack, root_cause, fix, files, tags, source, created_at, content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(content_hash, project_id) DO UPDATE SET
          fix        = excluded.fix,
          stack      = COALESCE(excluded.stack, errors.stack),
          files      = COALESCE(excluded.files, errors.files),
          tags       = excluded.tags
      `).run(id, req.projectId, req.message, req.stack ?? null, req.rootCause ?? null,
              req.fix, files, tags, req.source, now, contentHash);

      // Get the actual row id (may be the existing one on conflict)
      const row = this.db.prepare(`SELECT id FROM errors WHERE content_hash = ? AND project_id = ?`)
        .get(contentHash, req.projectId) as { id: string };

      this.db.prepare(`INSERT OR REPLACE INTO error_embeddings (id, embedding) VALUES (?, ?)`)
        .run(row.id, embeddingToBlob(embedding));

      this.db.exec('COMMIT');
      return rowToRecord(
        this.db.prepare(`SELECT * FROM errors WHERE id = ?`).get(row.id) as Record<string, unknown>
      );
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async search(query: string, projectId?: string, limit = 10): Promise<ErrorSearchResult[]> {
    if (!query.trim()) return [];

    // ── FTS keyword search ──
    let ftsResults: Array<{ id: string; score: number }> = [];
    try {
      const escaped = escapeFtsQuery(query);
      type FtsRow = { id: string; fts_score: number };
      const ftsRows = this.db.prepare(`
        SELECT e.id, -bm25(errors_fts) AS fts_score
        FROM errors_fts
        JOIN errors e ON e.id = errors_fts.id
        WHERE errors_fts MATCH ?
        ${projectId ? 'AND e.project_id = ?' : ''}
        ORDER BY bm25(errors_fts)
        LIMIT ?
      `).all(...(projectId ? [escaped, projectId, limit * 3] : [escaped, limit * 3])) as unknown as FtsRow[];
      ftsResults = ftsRows.map(r => ({ id: r.id, score: r.fts_score }));
    } catch {
      // FTS error (e.g. empty table) — continue with semantic only
    }

    // ── Semantic search ──
    const queryVec = await this.embedder.embed(query);
    const embeddingRows = this.db.prepare(`
      SELECT e.id, ee.embedding
      FROM errors e
      JOIN error_embeddings ee ON ee.id = e.id
      ${projectId ? 'WHERE e.project_id = ?' : ''}
    `).all(...(projectId ? [projectId] : [])) as unknown as { id: string; embedding: Buffer }[];

    const semanticResults = embeddingRows
      .map(r => ({ id: r.id, score: cosineDistance(queryVec, blobToEmbedding(r.embedding)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit * 3);

    // ── RRF merge ──
    const merged = rrf([ftsResults, semanticResults]).slice(0, limit);
    if (merged.length === 0) return [];

    // ── Fetch full rows + project names ──
    const ids = merged.map(m => m.id);
    const scoreMap = new Map(merged.map(m => [m.id, m.score]));

    const rows = ids
      .map(id => this.db.prepare(`
        SELECT e.*, p.name AS project_name
        FROM errors e
        JOIN projects p ON p.id = e.project_id
        WHERE e.id = ?
      `).get(id) as Record<string, unknown> | undefined)
      .filter(Boolean) as Record<string, unknown>[];

    return rows.map(row => ({
      error: rowToRecord(row),
      projectName: String(row['project_name']),
      score: scoreMap.get(String(row['id'])) ?? 0,
    }));
  }

  list(projectId?: string, limit = 100): ErrorRecord[] {
    const rows = projectId
      ? this.db.prepare(`SELECT * FROM errors WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`).all(projectId, limit)
      : this.db.prepare(`SELECT * FROM errors ORDER BY created_at DESC LIMIT ?`).all(limit);
    return (rows as unknown as Record<string, unknown>[]).map(rowToRecord);
  }
}
```

- [ ] **Step 4: Run tests to verify PASS**

```bash
cd agent-memory-mcp && npx vitest run tests/global/error-store.test.ts
```

Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
cd agent-memory-mcp
git add src/global/error-store.ts tests/global/error-store.test.ts
git commit -m "feat(global): add ErrorStore — errors table with FTS5 + embeddings + RRF hybrid search + dedup"
```

---

## Task 4: Create `SqliteGlobalStore` + `GlobalFactory`

**Files:**
- Create: `agent-memory-mcp/src/global/global-store.ts`
- Create: `agent-memory-mcp/src/global/global-factory.ts`
- Create: `agent-memory-mcp/tests/global/global-store.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// agent-memory-mcp/tests/global/global-store.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteGlobalStore } from '../../src/global/global-store.js';
import { MockEmbedder } from '../mocks.js';

let tmpDir: string;
let store: SqliteGlobalStore;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pmc-global-store-test-'));
  store = new SqliteGlobalStore(join(tmpDir, 'global.db'), new MockEmbedder());
  await store.initialize();
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('SqliteGlobalStore', () => {
  it('registerProject creates a project record', () => {
    const rec = store.registerProject({ name: 'proj', rootPath: '/tmp/proj' });
    assert.equal(rec.name, 'proj');
    assert.equal(rec.rootPath, '/tmp/proj');
  });

  it('registerProject is idempotent', () => {
    store.registerProject({ name: 'proj', rootPath: '/tmp/proj' });
    store.registerProject({ name: 'proj', rootPath: '/tmp/proj', objective: 'Updated' });
    // Only one entry in projects table
    const rec = store.registerProject({ name: 'proj', rootPath: '/tmp/proj' });
    assert.equal(rec.objective, 'Updated');
  });

  it('syncMetadata updates project fields', () => {
    const rec = store.registerProject({ name: 'proj', rootPath: '/tmp/proj' });
    store.syncMetadata(rec.id, { architecture: 'monolith', objective: 'Build X' });
    const { id } = rec;
    // Confirm by recording an error (proves store is functional)
    const err = store.recordError({
      projectId: id,
      message: 'test',
      fix: 'fix',
      source: 'auto',
    });
    return err.then(e => assert.equal(e.projectId, id));
  });

  it('recordError stores an error', async () => {
    const proj = store.registerProject({ name: 'p', rootPath: '/p' });
    const err = await store.recordError({
      projectId: proj.id,
      message: 'ReferenceError: x is not defined',
      rootCause: 'missing import',
      fix: 'add import statement at top of file',
      source: 'manual',
    });
    assert.equal(err.message, 'ReferenceError: x is not defined');
    assert.equal(err.source, 'manual');
  });

  it('searchErrors returns relevant results', async () => {
    const proj = store.registerProject({ name: 'p', rootPath: '/p' });
    await store.recordError({
      projectId: proj.id,
      message: 'ENOENT: file not found',
      rootCause: 'path is wrong',
      fix: 'use absolute path instead of relative',
      source: 'auto',
    });
    const results = await store.searchErrors('file not found path');
    assert.ok(results.length >= 1);
    assert.equal(results[0].error.message, 'ENOENT: file not found');
  });

  it('searchErrors returns empty array when store is empty', async () => {
    const results = await store.searchErrors('anything');
    assert.deepEqual(results, []);
  });

  it('close() does not throw', () => {
    assert.doesNotThrow(() => store.close());
  });
});
```

- [ ] **Step 2: Run tests to verify FAIL**

```bash
cd agent-memory-mcp && npx vitest run tests/global/global-store.test.ts
```

Expected: FAIL — `SqliteGlobalStore` not found.

- [ ] **Step 3: Implement `src/global/global-store.ts`**

```typescript
// agent-memory-mcp/src/global/global-store.ts
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Embedder } from '../types.js';
import { ProjectRegistry, type ProjectRecord, type ProjectMetadata } from './project-registry.js';
import { ErrorStore, type ErrorRecord, type RecordErrorRequest, type ErrorSearchResult } from './error-store.js';

export type { ProjectRecord, ProjectMetadata, ErrorRecord, RecordErrorRequest, ErrorSearchResult };

export interface GlobalStore {
  registerProject(metadata: ProjectMetadata): ProjectRecord;
  syncMetadata(projectId: string, metadata: Partial<Omit<ProjectMetadata, 'name' | 'rootPath'>>): ProjectRecord;
  recordError(req: RecordErrorRequest): Promise<ErrorRecord>;
  searchErrors(query: string, projectId?: string, limit?: number): Promise<ErrorSearchResult[]>;
  close(): void;
}

export class SqliteGlobalStore implements GlobalStore {
  private db!: DatabaseSync;
  private registry!: ProjectRegistry;
  private errors!: ErrorStore;

  constructor(
    private readonly dbPath: string,
    private readonly embedder: Embedder,
  ) {}

  async initialize(): Promise<void> {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;');
    this.registry = new ProjectRegistry(this.db);
    this.registry.ensureSchema();
    this.errors = new ErrorStore(this.db, this.embedder);
    this.errors.ensureSchema();
  }

  registerProject(metadata: ProjectMetadata): ProjectRecord {
    return this.registry.register(metadata);
  }

  syncMetadata(
    projectId: string,
    metadata: Partial<Omit<ProjectMetadata, 'name' | 'rootPath'>>,
  ): ProjectRecord {
    return this.registry.updateMetadata(projectId, metadata);
  }

  async recordError(req: RecordErrorRequest): Promise<ErrorRecord> {
    return this.errors.record(req);
  }

  async searchErrors(query: string, projectId?: string, limit = 10): Promise<ErrorSearchResult[]> {
    return this.errors.search(query, projectId, limit);
  }

  close(): void {
    try { this.db?.close(); } catch { /* ignore */ }
  }
}
```

- [ ] **Step 4: Implement `src/global/global-factory.ts`**

```typescript
// agent-memory-mcp/src/global/global-factory.ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Embedder } from '../types.js';
import { SqliteGlobalStore, type GlobalStore } from './global-store.js';

/**
 * Create and initialize the global context store.
 *
 * Default path: ~/.pmc/global.db
 * Override with: PMC_GLOBAL_DB_PATH env var
 *
 * Errors during initialization are caught and logged — callers receive null
 * if the global store cannot be opened (e.g. permissions, disk full).
 * This ensures the main agent-memory server starts even if the global store fails.
 */
export async function createGlobalStore(embedder: Embedder): Promise<GlobalStore | null> {
  const dbPath = process.env.PMC_GLOBAL_DB_PATH ?? join(homedir(), '.pmc', 'global.db');
  try {
    const store = new SqliteGlobalStore(dbPath, embedder);
    await store.initialize();
    return store;
  } catch (err) {
    console.error('[global-factory] Failed to open global store, global context disabled:', err);
    return null;
  }
}
```

- [ ] **Step 5: Run tests**

```bash
cd agent-memory-mcp && npx vitest run tests/global/global-store.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 6: Commit**

```bash
cd agent-memory-mcp
git add src/global/global-store.ts src/global/global-factory.ts tests/global/global-store.test.ts
git commit -m "feat(global): add SqliteGlobalStore + createGlobalStore factory"
```

---

## Task 5: Add 4 MCP tools to `tools.ts` and wire into `server.ts` + `index.ts`

**Files:**
- Modify: `agent-memory-mcp/src/tools.ts`
- Modify: `agent-memory-mcp/src/server.ts`
- Modify: `agent-memory-mcp/src/index.ts`
- Create: `agent-memory-mcp/tests/global/tools-global.test.ts`

- [ ] **Step 1: Write failing tests for the 4 new tools**

```typescript
// agent-memory-mcp/tests/global/tools-global.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handleRegisterProject,
  handleSyncProjectMetadata,
  handleRecordError,
  handleSearchGlobalErrors,
} from '../../src/tools.js';
import { SqliteGlobalStore } from '../../src/global/global-store.js';
import { MockEmbedder } from '../mocks.js';

let tmpDir: string;
let globalStore: SqliteGlobalStore;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pmc-tools-global-test-'));
  globalStore = new SqliteGlobalStore(join(tmpDir, 'global.db'), new MockEmbedder());
  await globalStore.initialize();
});

afterEach(() => {
  globalStore.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('handleRegisterProject', () => {
  it('returns success with project record', async () => {
    const handler = handleRegisterProject(globalStore);
    const result = await handler({ name: 'my-repo', rootPath: '/home/user/my-repo' });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.name, 'my-repo');
    assert.ok(data.id);
  });

  it('is idempotent — second call returns same project', async () => {
    const handler = handleRegisterProject(globalStore);
    await handler({ name: 'repo', rootPath: '/repo' });
    const result = await handler({ name: 'repo', rootPath: '/repo', objective: 'Do stuff' });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.objective, 'Do stuff');
  });
});

describe('handleSyncProjectMetadata', () => {
  it('updates project metadata', async () => {
    const proj = globalStore.registerProject({ name: 'p', rootPath: '/p' });
    const handler = handleSyncProjectMetadata(globalStore);
    const result = await handler({ projectId: proj.id, architecture: 'monolith' });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.architecture, 'monolith');
  });
});

describe('handleRecordError', () => {
  it('stores an error and returns it', async () => {
    const proj = globalStore.registerProject({ name: 'p', rootPath: '/p' });
    const handler = handleRecordError(globalStore);
    const result = await handler({
      projectId: proj.id,
      message: 'TypeError: x is null',
      rootCause: 'null check missing',
      fix: 'add if (x) before access',
      source: 'manual',
    });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.message, 'TypeError: x is null');
  });
});

describe('handleSearchGlobalErrors', () => {
  it('returns empty results for empty store', async () => {
    const handler = handleSearchGlobalErrors(globalStore);
    const result = await handler({ query: 'TypeError' });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.count, 0);
  });

  it('returns results matching the query', async () => {
    const proj = globalStore.registerProject({ name: 'p', rootPath: '/p' });
    await globalStore.recordError({
      projectId: proj.id,
      message: 'ENOENT: file.ts not found',
      fix: 'check path is correct',
      source: 'auto',
    });
    const handler = handleSearchGlobalErrors(globalStore);
    const result = await handler({ query: 'ENOENT file not found' });
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.count >= 1);
  });
});
```

- [ ] **Step 2: Run tests to verify FAIL**

```bash
cd agent-memory-mcp && npx vitest run tests/global/tools-global.test.ts
```

Expected: FAIL — handler functions not exported from `tools.ts`.

- [ ] **Step 3: Add handler functions and update `registerTools` in `src/tools.ts`**

At the bottom of `src/tools.ts`, before `registerTools`, add:

```typescript
// ── Global context tools ───────────────────────────────────────────

import type { GlobalStore } from './global/global-store.js';

export function handleRegisterProject(globalStore: GlobalStore) {
  return async (args: {
    name: string;
    rootPath: string;
    objective?: string;
    stack?: unknown;
    architecture?: string;
  }): Promise<ReturnType<typeof success>> => {
    try {
      const rec = globalStore.registerProject({
        name: args.name,
        rootPath: args.rootPath,
        objective: args.objective,
        stack: args.stack,
        architecture: args.architecture,
      });
      return success(rec);
    } catch (err) {
      return error(`register_project failed: ${String(err)}`);
    }
  };
}

export function handleSyncProjectMetadata(globalStore: GlobalStore) {
  return async (args: {
    projectId: string;
    objective?: string;
    stack?: unknown;
    architecture?: string;
    dependencies?: unknown;
    minimap?: unknown;
  }): Promise<ReturnType<typeof success>> => {
    try {
      const rec = globalStore.syncMetadata(args.projectId, {
        objective: args.objective,
        stack: args.stack,
        architecture: args.architecture,
        dependencies: args.dependencies,
        minimap: args.minimap,
      });
      return success(rec);
    } catch (err) {
      return error(`sync_project_metadata failed: ${String(err)}`);
    }
  };
}

export function handleRecordError(globalStore: GlobalStore) {
  return async (args: {
    projectId: string;
    message: string;
    stack?: string;
    rootCause?: string;
    fix: string;
    files?: string[];
    tags?: string[];
    source: 'auto' | 'manual';
  }): Promise<ReturnType<typeof success>> => {
    try {
      const rec = await globalStore.recordError({
        projectId: args.projectId,
        message: args.message,
        stack: args.stack,
        rootCause: args.rootCause,
        fix: args.fix,
        files: args.files,
        tags: args.tags,
        source: args.source,
      });
      return success(rec);
    } catch (err) {
      return error(`record_error failed: ${String(err)}`);
    }
  };
}

export function handleSearchGlobalErrors(globalStore: GlobalStore) {
  return async (args: {
    query: string;
    projectId?: string;
    limit?: number;
  }): Promise<ReturnType<typeof success>> => {
    try {
      const results = await globalStore.searchErrors(args.query, args.projectId, args.limit);
      return success({ count: results.length, results });
    } catch (err) {
      return error(`search_global_errors failed: ${String(err)}`);
    }
  };
}
```

Update the `registerTools` signature and function body to accept an optional `GlobalStore`:

```typescript
export function registerTools(server: McpServer, store: MemoryStore, globalStore?: GlobalStore): void {
  // ... existing tools unchanged ...

  // ── Global context tools (only registered if globalStore is provided) ──
  if (globalStore) {
    server.tool(
      'register_project',
      'Register a project in the global context store. Creates a subscription entry. Idempotent — safe to call on every pmc init.',
      {
        name: z.string().describe('Project name (e.g. repo name)'),
        rootPath: z.string().describe('Absolute path to the project root'),
        objective: z.string().optional().describe('One-sentence project objective'),
        stack: z.unknown().optional().describe('Languages/frameworks as JSON object'),
        architecture: z.string().optional().describe('Architecture summary'),
      },
      handleRegisterProject(globalStore),
    );

    server.tool(
      'sync_project_metadata',
      'Update the global context snapshot for a project: objective, architecture, dependencies, minimap. Called by pmc refresh-context.',
      {
        projectId: z.string().describe('Project ID (from register_project)'),
        objective: z.string().optional(),
        stack: z.unknown().optional(),
        architecture: z.string().optional(),
        dependencies: z.unknown().optional().describe('Dependency summary as JSON'),
        minimap: z.unknown().optional().describe('File minimap as JSON'),
      },
      handleSyncProjectMetadata(globalStore),
    );

    server.tool(
      'record_error',
      'Record a debugged error and its solution in the global error database. Deduplicated by (message + root_cause) per project.',
      {
        projectId: z.string().describe('Project ID where this error occurred'),
        message: z.string().describe('Error message or exception text'),
        stack: z.string().optional().describe('Stack trace'),
        rootCause: z.string().optional().describe('Root cause analysis'),
        fix: z.string().describe('Solution that resolved the error'),
        files: z.array(z.string()).optional().describe('Files affected by this error'),
        tags: z.array(z.string()).optional().describe('Tags for categorization'),
        source: z.enum(['auto', 'manual']).describe('auto = promoted from KNOWN-ISSUES-AND-FIXES.md, manual = recorded live'),
      },
      handleRecordError(globalStore),
    );

    server.tool(
      'search_global_errors',
      'Search the global cross-project error database for similar errors and their solutions. Uses hybrid FTS5 BM25 + semantic search.',
      {
        query: z.string().describe('Error description, message text, or symptom to search for'),
        projectId: z.string().optional().describe('Filter results to a specific project ID'),
        limit: z.number().optional().describe('Max results (default 10)'),
      },
      handleSearchGlobalErrors(globalStore),
    );
  }
}
```

- [ ] **Step 4: Update `src/server.ts` to accept optional `GlobalStore`**

```typescript
// agent-memory-mcp/src/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MemoryStore } from './types.js';
import type { GlobalStore } from './global/global-store.js';
import { registerTools } from './tools.js';
import { packageMetadata } from './version.js';

export function createServer(store: MemoryStore, globalStore?: GlobalStore): McpServer {
  const server = new McpServer({
    name: packageMetadata.serverName,
    version: packageMetadata.version,
  });

  registerTools(server, store, globalStore);

  return server;
}
```

- [ ] **Step 5: Update `src/index.ts` to create and pass the global store**

```typescript
#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EmbeddingCache } from './embedding-cache.js';
import { TransformersEmbedder } from './embedder.js';
import { HardcopyMemoryStore } from './hardcopy-store.js';
import { createStore } from './store-factory.js';
import { createGlobalStore } from './global/global-factory.js';
import { createServer } from './server.js';
import type { MemoryStore } from './types.js';

async function main(): Promise<void> {
  const dbPath = process.env.MEMORY_DB_PATH;
  if (!dbPath) {
    console.error('MEMORY_DB_PATH environment variable is required');
    process.exit(1);
  }

  const modelName = process.env.EMBEDDING_MODEL ?? 'Xenova/bge-m3';
  const dimensions = process.env.EMBEDDING_DIMENSIONS ? parseInt(process.env.EMBEDDING_DIMENSIONS, 10) : undefined;
  const pooling = process.env.EMBEDDING_POOLING ?? undefined;
  const cachePath = process.env.EMBEDDING_CACHE_PATH;

  // ── Compose dependencies ──
  const cache = cachePath ? new EmbeddingCache(cachePath, modelName) : undefined;
  const embedder = new TransformersEmbedder(modelName, dimensions, pooling, cache);
  let store: MemoryStore = await createStore(dbPath, embedder);

  if (process.env.ENABLE_HARDCOPY === 'true' && process.env.HARDCOPY_PATH) {
    store = new HardcopyMemoryStore(store, process.env.HARDCOPY_PATH);
    console.error(`[hardcopy] Mirroring mutations to ${process.env.HARDCOPY_PATH}`);
  }

  // ── Global context store (optional — failure does not block startup) ──
  const globalStore = await createGlobalStore(embedder);
  if (globalStore) {
    console.error(`[global] Global context store ready`);
  }

  const server = createServer(store, globalStore ?? undefined);

  // ── Initialise (download model on first run, connect to DB) ──
  await embedder.initialize();

  // ── Start MCP transport ──
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 6: Run tests**

```bash
cd agent-memory-mcp && npx vitest run tests/global/tools-global.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 7: Run full test suite**

```bash
cd agent-memory-mcp && npm test
```

Expected: all tests pass (existing 138 + new global tests).

- [ ] **Step 8: Build**

```bash
cd agent-memory-mcp && npm run build
```

Expected: clean build.

- [ ] **Step 9: Commit**

```bash
cd agent-memory-mcp
git add src/tools.ts src/server.ts src/index.ts tests/global/tools-global.test.ts
git commit -m "feat(global): add 4 MCP tools (register_project, sync_project_metadata, record_error, search_global_errors)"
```

---

## Task 6: Create `src/global-sync.mjs` in PMC — parse KNOWN-ISSUES-AND-FIXES.md

**Files:**
- Create: `tools/project-memory-context/src/global-sync.mjs`
- Create: `tools/project-memory-context/tests/global-sync.test.mjs`

- [ ] **Step 1: Write the failing tests**

```javascript
// tools/project-memory-context/tests/global-sync.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseKnownIssuesMarkdown } from '../src/global-sync.mjs';

describe('parseKnownIssuesMarkdown', () => {
  it('returns empty array for empty summary', () => {
    const md = `# Known issues and fixes
**Kind:** known-issues-and-fixes
**Updated:** 2026-06-03T00:00:00.000Z

## Summary
0 known issues recorded.

## Body
- No known issues recorded.`;
    assert.deepEqual(parseKnownIssuesMarkdown(md), []);
  });

  it('extracts a single issue with message and fix', () => {
    const md = `# Known issues and fixes

## Body

### Issue: ENOENT when loading graph.json
**Root cause:** File is written relative to project root but resolved from CWD.
**Fix:** Use resolve(projectRoot, 'graph.json') instead of relative path.
**Files:** cli/context.mjs
**Tags:** file-system, path`;
    const result = parseKnownIssuesMarkdown(md);
    assert.equal(result.length, 1);
    assert.ok(result[0].message.includes('ENOENT'));
    assert.ok(result[0].fix.includes('resolve(projectRoot'));
    assert.ok(result[0].rootCause?.includes('relative to project root'));
    assert.deepEqual(result[0].files, ['cli/context.mjs']);
    assert.ok(result[0].tags.includes('file-system'));
  });

  it('extracts multiple issues', () => {
    const md = `# Known issues
## Body
### Issue: Error A
**Fix:** Fix A

### Issue: Error B
**Fix:** Fix B`;
    const result = parseKnownIssuesMarkdown(md);
    assert.equal(result.length, 2);
    assert.ok(result[0].message.includes('Error A'));
    assert.ok(result[1].message.includes('Error B'));
  });

  it('handles missing optional fields gracefully', () => {
    const md = `# Known issues
## Body
### Issue: Something broke
**Fix:** Do something`;
    const result = parseKnownIssuesMarkdown(md);
    assert.equal(result.length, 1);
    assert.equal(result[0].rootCause, null);
    assert.deepEqual(result[0].files, []);
    assert.deepEqual(result[0].tags, []);
  });
});
```

- [ ] **Step 2: Run tests to verify FAIL**

```bash
cd tools/project-memory-context && node --test tests/global-sync.test.mjs
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/global-sync.mjs`**

```javascript
// tools/project-memory-context/src/global-sync.mjs

/**
 * Parse KNOWN-ISSUES-AND-FIXES.md into payloads suitable for `record_error`.
 *
 * Expected section format:
 *   ### Issue: <message>
 *   **Root cause:** <text>       (optional)
 *   **Fix:** <text>              (required)
 *   **Files:** file1, file2      (optional)
 *   **Tags:** tag1, tag2         (optional)
 *
 * @param {string} markdown
 * @returns {Array<{message: string, rootCause: string|null, fix: string, files: string[], tags: string[]}>}
 */
export function parseKnownIssuesMarkdown(markdown) {
  const results = [];

  // Extract the Body section
  const bodyMatch = markdown.match(/##\s+Body\s*\n([\s\S]*?)(?=\n##\s|\s*$)/);
  if (!bodyMatch) return results;

  const body = bodyMatch[1];

  // Split into issue blocks by "### Issue:" heading
  const issueBlocks = body.split(/\n(?=###\s+Issue:)/);

  for (const block of issueBlocks) {
    const messageMatch = block.match(/###\s+Issue:\s*(.+)/);
    if (!messageMatch) continue;

    const message = messageMatch[1].trim();

    const fixMatch = block.match(/\*\*Fix:\*\*\s*(.+)/);
    if (!fixMatch) continue;  // fix is required
    const fix = fixMatch[1].trim();

    const rootCauseMatch = block.match(/\*\*Root cause:\*\*\s*(.+)/);
    const rootCause = rootCauseMatch ? rootCauseMatch[1].trim() : null;

    const filesMatch = block.match(/\*\*Files:\*\*\s*(.+)/);
    const files = filesMatch
      ? filesMatch[1].split(',').map(f => f.trim()).filter(Boolean)
      : [];

    const tagsMatch = block.match(/\*\*Tags:\*\*\s*(.+)/);
    const tags = tagsMatch
      ? tagsMatch[1].split(',').map(t => t.trim()).filter(Boolean)
      : [];

    results.push({ message, rootCause, fix, files, tags });
  }

  return results;
}

/**
 * Read KNOWN-ISSUES-AND-FIXES.md from the PMC planning dir and return
 * payloads ready for the `record_error` MCP tool.
 *
 * @param {string} pmcRoot - The .planning/project-memory-context dir
 * @param {string} projectId - The global project ID
 * @returns {Promise<Array>}
 */
export async function buildErrorPayloads(pmcRoot, projectId) {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  const mdPath = join(pmcRoot, 'project-context', 'markdown', 'KNOWN-ISSUES-AND-FIXES.md');
  let markdown;
  try {
    markdown = await readFile(mdPath, 'utf8');
  } catch {
    return []; // File doesn't exist yet — no errors to promote
  }

  const parsed = parseKnownIssuesMarkdown(markdown);
  return parsed.map(item => ({
    projectId,
    message: item.message,
    rootCause: item.rootCause ?? undefined,
    fix: item.fix,
    files: item.files.length > 0 ? item.files : undefined,
    tags: item.tags.length > 0 ? item.tags : undefined,
    source: 'auto',
  }));
}
```

- [ ] **Step 4: Run tests to verify PASS**

```bash
cd tools/project-memory-context && node --test tests/global-sync.test.mjs
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tools/project-memory-context/src/global-sync.mjs tools/project-memory-context/tests/global-sync.test.mjs
git commit -m "feat(pmc): add global-sync.mjs — parse KNOWN-ISSUES-AND-FIXES.md into record_error payloads"
```

---

## Task 7: Wire `cli/init.mjs` — call `register_project`

**Files:**
- Modify: `tools/project-memory-context/cli/init.mjs`

The PMC `init` command installs agent templates. After that, we call `register_project` via the MCP client. We follow the pattern in `cli/sync.mjs` (reads `.mcp.json`, uses `@modelcontextprotocol/sdk` Client + StdioClientTransport).

- [ ] **Step 1: Update `cli/init.mjs`**

Add a `tryRegisterProject` helper after the existing imports and before `main`. Then call it at the end of `main`:

```javascript
// Add after existing imports at the top of init.mjs:
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { basename } from 'node:path';

// ── Global context registration (best-effort, non-fatal) ──

async function tryRegisterProject(projectRoot) {
  const mcpPath = resolve(projectRoot, '.mcp.json');
  let serverConfig;
  try {
    const raw = JSON.parse(await readFile(mcpPath, 'utf8'));
    serverConfig = raw?.mcpServers?.['agent-memory'];
  } catch {
    return; // No .mcp.json — skip global registration silently
  }
  if (!serverConfig) return;

  const client = new Client({ name: 'pmc-init', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: serverConfig.command,
    args: serverConfig.args ?? [],
    env: { ...process.env, ...serverConfig.env },
  });

  try {
    await client.connect(transport);
    await client.callTool({
      name: 'register_project',
      arguments: {
        name: basename(projectRoot),
        rootPath: projectRoot,
      },
    });
    console.error(`[pmc:init] Registered project in global context store`);
  } catch (err) {
    console.error(`[pmc:init] Global context registration skipped: ${err.message}`);
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}
```

In the `main` function, add the call after `installAgentTemplates`:

```javascript
  // After: console.error(`[pmc:init] Installed PMC templates for ${agent}`);
  await tryRegisterProject(projectRoot);
  return 0;
```

- [ ] **Step 2: Run existing PMC tests to confirm no regressions**

```bash
cd tools/project-memory-context && node --test tests/*.test.mjs
```

Expected: all tests pass (init is not directly tested by unit tests but the broader suite should stay green).

- [ ] **Step 3: Commit**

```bash
git add tools/project-memory-context/cli/init.mjs
git commit -m "feat(pmc): wire init.mjs to call register_project on global context store"
```

---

## Task 8: Wire `cli/refresh-context.mjs` — sync metadata + auto-promote errors

**Files:**
- Modify: `tools/project-memory-context/cli/refresh-context.mjs`

- [ ] **Step 1: Add the global sync helpers to `cli/refresh-context.mjs`**

Add after the existing imports block at the top of `refresh-context.mjs`:

```javascript
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildErrorPayloads } from '../src/global-sync.mjs';
import { ProjectRegistry } from '../src/project-registry-client.mjs';
```

Wait — ProjectRegistry lives in `agent-memory-mcp`, not PMC. PMC uses the MCP client to communicate. Instead, PMC only needs to know the project ID (which it derives the same way: SHA-256 of normalized rootPath). Add a small utility directly in `refresh-context.mjs`:

```javascript
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

function computeProjectId(rootPath) {
  const normalised = rootPath.replace(/\\/g, '/').toLowerCase();
  return createHash('sha256').update(normalised).digest('hex');
}
```

Add a `trySyncProjectToGlobal` helper:

```javascript
async function trySyncProjectToGlobal(projectRoot, dirs, options = {}) {
  const mcpPath = resolve(projectRoot, '.mcp.json');
  let serverConfig;
  try {
    const raw = JSON.parse(await readFile(mcpPath, 'utf8'));
    serverConfig = raw?.mcpServers?.['agent-memory'];
  } catch {
    return;
  }
  if (!serverConfig) return;

  const projectId = computeProjectId(projectRoot);
  const projectName = basename(projectRoot);

  // Gather metadata from existing project-context artifacts
  const [architecture, dependencies, minimap] = await Promise.all([
    readJsonArtifact(resolve(dirs.projectContextMarkdown, 'ARCHITECTURE-CURRENT.md'), null)
      .then(txt => typeof txt === 'string' ? txt.slice(0, 2000) : null)
      .catch(() => null),
    readJsonArtifact(resolve(dirs.projectContextDeclared, 'architecture-target.json'), null)
      .catch(() => null),
    readJsonArtifact(resolve(dirs.projectContextMarkdown, 'MODULE-MINIMAP.md'), null)
      .then(txt => typeof txt === 'string' ? { summary: txt.slice(0, 1000) } : null)
      .catch(() => null),
  ]);

  const errorPayloads = await buildErrorPayloads(
    resolve(projectRoot, '.planning', 'project-memory-context'),
    projectId,
  );

  const client = new Client({ name: 'pmc-refresh', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: serverConfig.command,
    args: serverConfig.args ?? [],
    env: { ...process.env, ...serverConfig.env },
  });

  try {
    await client.connect(transport);

    // Ensure project is registered
    await client.callTool({
      name: 'register_project',
      arguments: { name: projectName, rootPath: projectRoot },
    });

    // Sync metadata
    const metadataArgs = { projectId };
    if (architecture) metadataArgs.architecture = String(architecture);
    if (dependencies) metadataArgs.dependencies = dependencies;
    if (minimap) metadataArgs.minimap = minimap;
    await client.callTool({ name: 'sync_project_metadata', arguments: metadataArgs });

    // Auto-promote errors
    for (const payload of errorPayloads) {
      await client.callTool({ name: 'record_error', arguments: payload });
    }

    log(`Global context synced (${errorPayloads.length} errors promoted)`);
  } catch (err) {
    log(`Global context sync skipped (non-fatal): ${err.message}`);
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}
```

At the end of the `refreshContext` function, just before the `return`, add:

```javascript
  // Sync to global context store (non-blocking, errors are swallowed)
  await trySyncProjectToGlobal(projectRoot, dirs).catch(() => {});
```

- [ ] **Step 2: Run all PMC tests**

```bash
cd tools/project-memory-context && node --test tests/*.test.mjs
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add tools/project-memory-context/cli/refresh-context.mjs
git commit -m "feat(pmc): wire refresh-context to sync metadata + auto-promote errors to global context"
```

---

## Task 9: Concurrency test for `global.db`

Two concurrent Node processes write errors to the same `~/.pmc/global.db` path. Verifies WAL serialization.

**Files:**
- Create: `agent-memory-mcp/tests/global/concurrent-global.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// agent-memory-mcp/tests/global/concurrent-global.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteGlobalStore } from '../../src/global/global-store.js';
import { MockEmbedder } from '../mocks.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pmc-concurrent-global-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('concurrent global store writes', () => {
  it('two concurrent stores writing errors produce correct count', async () => {
    const dbPath = join(tmpDir, 'global.db');
    const embedder = new MockEmbedder();

    // Open two independent stores on the same file (simulates two processes)
    const storeA = new SqliteGlobalStore(dbPath, embedder);
    const storeB = new SqliteGlobalStore(dbPath, embedder);
    await storeA.initialize();
    await storeB.initialize();

    // Register the same project from both (idempotent)
    storeA.registerProject({ name: 'proj', rootPath: '/proj' });
    storeB.registerProject({ name: 'proj', rootPath: '/proj' });
    const { id: projectId } = storeA.registerProject({ name: 'proj', rootPath: '/proj' });

    // Fire 10 concurrent writes from each store
    const writes = [
      ...Array.from({ length: 10 }, (_, i) =>
        storeA.recordError({ projectId, message: `Error A${i}`, fix: `Fix A${i}`, source: 'auto' })
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        storeB.recordError({ projectId, message: `Error B${i}`, fix: `Fix B${i}`, source: 'auto' })
      ),
    ];

    await Promise.all(writes);

    // All 20 distinct errors should be in the DB
    const results = await storeA.searchErrors('Error', undefined, 50);
    assert.ok(results.length >= 20, `Expected >= 20 results, got ${results.length}`);

    storeA.close();
    storeB.close();
  });
});
```

- [ ] **Step 2: Run the test**

```bash
cd agent-memory-mcp && npx vitest run tests/global/concurrent-global.test.ts
```

Expected: 1 test passes.

- [ ] **Step 3: Commit**

```bash
cd agent-memory-mcp
git add tests/global/concurrent-global.test.ts
git commit -m "test(global): concurrent global store writes — WAL correctness verification"
```

---

## Task 10: Full test suite + build verification

- [ ] **Step 1: Run full agent-memory-mcp test suite**

```bash
cd agent-memory-mcp && npm test
```

Expected: all tests pass, 0 failed.

- [ ] **Step 2: Run full PMC test suite**

```bash
cd tools/project-memory-context && node --test tests/*.test.mjs
```

Expected: all tests pass.

- [ ] **Step 3: Build agent-memory-mcp**

```bash
cd agent-memory-mcp && npm run build
```

Expected: clean TypeScript build, `dist/` up to date.

- [ ] **Step 4: Final commit (version bump)**

```bash
cd agent-memory-mcp
# Bump patch version in package.json (e.g. 2.0.0 → 2.1.0 for new feature)
npm version minor --no-git-tag-version
git add package.json
git commit -m "chore(release): bump version for FASE 3a Global Context"
```

---

## E2E Manual Verification

After all tasks complete:

```bash
# 1. Start agent-memory-mcp with PMC_GLOBAL_DB_PATH pointing to a temp dir
PMC_GLOBAL_DB_PATH=/tmp/test-global.db MEMORY_DB_PATH=/tmp/test-local.db \
  node dist/index.js &

# 2. Use MCP inspector or call via pmc
pmc init                    # should log "Registered project in global context store"
pmc refresh-context         # should log "Global context synced (N errors promoted)"

# 3. Verify global.db was created
ls -la /tmp/test-global.db

# 4. From a second project dir, call search_global_errors
# (via any MCP client or agent session)
# Expected: returns errors from the first project
```

```bash
# 5. Check global.db contents directly
node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/tmp/test-global.db');
const projects = db.prepare('SELECT id, name, root_path FROM projects').all();
const errors = db.prepare('SELECT id, message, fix, source FROM errors').all();
console.log('Projects:', JSON.stringify(projects, null, 2));
console.log('Errors:', JSON.stringify(errors, null, 2));
db.close();
"
```
