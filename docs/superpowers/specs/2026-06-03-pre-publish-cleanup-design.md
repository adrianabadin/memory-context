# Pre-Publish Cleanup Design

**Date:** 2026-06-03
**Status:** Approved
**Scope:** Both `tools/project-memory-context/` and `agent-memory-mcp/` (submodule)

---

## Why

The project has accumulated working notes, deprecated wrappers, incorrect metadata, and stale documentation during the rapid development of FASE 0–2.2. Before the next `npm publish` cycle, these need to be cleaned up to present a professional package, avoid confusing contributors, and reduce package size.

---

## Expected Outcome

- `repository.url` in both `package.json` files points to the correct GitHub repos
- Working notes moved from repo root to `docs/archive/` for historical preservation
- 4 deprecated CLI wrappers removed from code and excluded from npm package
- `agent-memory-mcp/CLAUDE.md` accurately documents SQLite as the primary backend
- `.gitignore` covers SQLite WAL files, build artifacts, and orphan directories
- All existing tests continue passing (542 PMC + 138 agent-memory)

---

## Task 1: Fix `repository.url` in both `package.json`

### PMC CLI (`tools/project-memory-context/package.json`)

```diff
  "repository": {
    "type": "git",
-   "url": "git+https://github.com/adamrdrew/agent-memory-mcp.git",
+   "url": "git+https://github.com/adrianabadin/memory-context.git",
    "directory": "tools/project-memory-context"
  },
- "author": "Adam Drew",
+ "author": "Adrian Abadin",
```

### Agent Memory MCP (`agent-memory-mcp/package.json`)

```diff
  "repository": {
    "type": "git",
-   "url": "git+https://github.com/adamrdrew/agent-memory-mcp.git"
+   "url": "git+https://github.com/adrianabadin/agent-memory-mcp.git"
  },
- "author": "Adam Drew",
+ "author": "Adrian Abadin",
```

**Verification:** `npm pack --dry-run` in both directories succeeds.

---

## Task 2: Archive working notes from repo root

Move these files to `docs/archive/`:

| File | Description |
|------|-------------|
| `criticas.md` | Code review notes (pre-publish) |
| `plancriticas.md` | Resolution plan for criticas |
| `problemas.md` | Problem tracking notes |
| `session-ses_1cd2.md` | Session artifact |
| `map-codebase workflow.md` | Workflow notes |
| `map-codebase.md` | Codebase mapping notes |
| `project-memory-context workflow.md` | PMC workflow notes |
| `project-memory-context.md` | PMC overview notes |
| `gsd-codebase-mapper.md` | GSD mapper notes |

**Method:** `git mv` each file to `docs/archive/` to preserve git history.

**Not moved:** `documentation.md` (active reference doc), `CLAUDE.md` / `AGENTS.md` (agent config files), `opencode.jsonc` (active config).

---

## Task 3: Remove deprecated CLI wrappers

Remove these 4 files from `tools/project-memory-context/cli/`:

| File | Current behavior |
|------|-----------------|
| `enrich-sync.mjs` | Prints deprecation warning, delegates to `pmc enrich` |
| `enrich-orchestrator.mjs` | Prints deprecation warning, delegates to `pmc enrich` |
| `batch-enrich.mjs` | Prints deprecation warning, delegates to `pmc enrich` |
| `enrich-batch.mjs` | Prints deprecation warning, delegates to `pmc enrich` |

**Pre-check:** Verify no other file imports or references these wrappers (beyond `command-dispatch.mjs` if it has entries for them).

**Post-check:** If `command-dispatch.mjs` routes to any of these, update it to either remove the route or point directly to `enrich.mjs`.

**Note on `files` array:** The `package.json` `files` field includes `"cli/"` as a directory glob, which automatically includes all files under `cli/`. Deleting the 4 wrapper `.mjs` files is sufficient — no change to the `files` array is needed.

**Verification:** `npm test` still passes (542 tests). Any test asserting deprecation-warning behavior for these 4 wrappers will need to be removed since the wrappers no longer exist.

---

## Task 4: Update `agent-memory-mcp/CLAUDE.md`

The current `CLAUDE.md` in the submodule documents LanceDB as the storage backend. It needs to reflect the SQLite migration completed in FASE 2.2.

Key changes:
- **Project Overview:** "backed by SQLite (WAL mode) with hybrid FTS5 BM25 + cosine vector search" instead of "backed by LanceDB"
- **Environment Variables:** Add `EMBEDDING_CACHE_PATH` description, note that `MEMORY_DB_PATH` now points to a SQLite `.db` file
- **Architecture:** Update composition chain to show `SqliteMemoryStore` as default, `LanceMemoryStore` as legacy/migration source
- **Key interfaces:** Add `version` field to `Memory` interface, mention OCC
- **LanceMemoryStore section:** Rename to "Storage Backends", document both SQLite (primary) and LanceDB (legacy, auto-migrated)
- **Testing:** Add `sqlite-store.test.ts`, `migrate.test.ts`, `concurrent-update.test.ts`, `embedding-cache.test.ts`, `version.test.ts` to the test file listing
- **`description` field in `package.json`:** Update from "backed by LanceDB" to "backed by SQLite"

---

## Task 5: Create/update `.gitignore`

Create a root `.gitignore` (currently missing) covering:

```gitignore
# Node
node_modules/

# SQLite WAL files (generated at runtime)
*.db-shm
*.db-wal

# Build artifacts
graphify-out/

# Playwright MCP state
.playwright-mcp/

# Orphan directory (created by bug in --refresh flag parsing)
--refresh/

# NPM pack artifacts
*.tgz

# PMC enrichment runtime state (not source)
.planning/project-memory-context/memory-db/
.planning/project-memory-context/memory-db.db
.planning/project-memory-context/memory-db.db-shm
.planning/project-memory-context/memory-db.db-wal
.planning/project-memory-context/embedding-cache/

# graphify intermediate files
.graphify_*.json
```

**Note:** The `--refresh/` directory at repo root is an orphan created by a bug where `pmc get-context --refresh` was parsed as a path. It should be deleted (`rm -rf`) and then gitignored.

---

## Verification Checklist

1. `npm test` in `tools/project-memory-context/` — 542 tests pass (or adjusted count after removing wrapper test)
2. `npm test` in `agent-memory-mcp/` — 138 tests pass
3. `npm pack --dry-run` in both directories — no deprecated wrappers in package listing
4. `git status` — clean working tree (no untracked noise)
5. No file in repo imports any of the 4 removed wrappers
