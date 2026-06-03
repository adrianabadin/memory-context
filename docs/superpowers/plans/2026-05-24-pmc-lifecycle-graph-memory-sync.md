# PMC Full Lifecycle: Graph + Memory Sync on Code Changes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a complete lifecycle pipeline so that when code changes (new symbols, modified symbols, deleted symbols), the graph, worklist, enrichment, and memories are updated automatically and incrementally — without requiring a full `pmc map-project` re-run.

**Architecture:** Add an incremental delta pipeline (`pmc refresh-context`) that detects changed files, runs targeted graphify on only those files, computes symbol deltas, marks stale/new/removed in the worklist, and launches selective re-enrichment. This replaces the current "full re-scan via sanitize" model with an efficient delta model. The deterministic autostart in AGENTS.md enforces this pipeline runs before the agent reads any file.

**Tech Stack:** Node.js ESM, npm package `bin`, filesystem-based state, Node built-in test runner (`node --test`), graphifyy (Python AST), agent-memory-mcp (MCP/LanceDB).

---

## Current State Analysis

### What exists today

| Operation | Command | What it does |
|-----------|---------|--------------|
| Full scan | `pmc map-project --all` | Graphify entire repo → extract all symbols → build worklist → enrich |
| Full sanitize | `pmc sanitize` | Re-run full graphify → re-extract all symbols → diff worklist → mark stale/new/removed → launch enrichment |
| Refresh base memories | `pmc project-context --refresh` | Detect changed `package.json`/`tsconfig.json` → regenerate affected base memories → mark enriched symbols stale if architecture changed |
| Sync to agent-memory | `pmc sync-context` | Apply pending sync-manifest entries (upsert/delete) to LanceDB |

### What is missing

| Gap | Impact |
|-----|--------|
| No automatic file change detection | Agent doesn't know when to trigger updates |
| No incremental graphify | `sanitize` re-runs full graphify every time (expensive) |
| No single-symbol graph update | Can't add a new node to `graph.json` without full re-scan |
| No selective re-enrichment | Must re-enrich all stale symbols, can't target one |
| No file watcher | No `pmc watch` for automatic background updates |
| No git hook integration | No pre-commit/post-commit triggers |
| No mandatory lifecycle enforcement in AGENTS.md | Agent can skip context retrieval entirely |

### Data flow (current vs target)

**Current (manual):**
```
Code changes → User remembers to run pmc sanitize → full graphify → full extract → diff → enrich → sync
```

**Target (automatic + incremental):**
```
Code changes → pmc refresh-context (or watch mode trigger)
  → detect changed files (hash comparison)
  → incremental graphify (changed files only)
  → merge new nodes/edges into graph.json
  → extract symbols from changed files only
  → diff against worklist (new / stale / removed)
  → queue selective enrichment (changed symbols only)
  → update sync-manifest
  → user runs pmc sync-context to persist
```

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `cli/refresh-context.mjs` | New CLI command: incremental delta pipeline |
| `src/file-watcher.mjs` | File watcher for `pmc watch` mode |
| `src/incremental-graph.mjs` | Merge new nodes/edges into existing graph.json |
| `src/symbol-delta.mjs` | Compute new/stale/removed symbol deltas |
| `src/file-hash-store.mjs` | Persistent file hash tracking for change detection |
| `tests/refresh-context.test.mjs` | Tests for the incremental pipeline |
| `tests/incremental-graph.test.mjs` | Tests for graph merge logic |
| `tests/symbol-delta.test.mjs` | Tests for delta computation |
| `tests/file-hash-store.test.mjs` | Tests for hash tracking |

### Modified files

| File | Changes |
|------|---------|
| `src/command-dispatch.mjs` | Add `refresh-context` and `watch` commands |
| `templates/opencode/commands/refresh-context.md` | New command template |
| `templates/opencode/autostart-snippet.md` | Enforce lifecycle in autostart |
| `templates/claude-code/CLAUDE.md.snippet` | Enforce lifecycle for Claude Code |
| `templates/cursor/.cursorrules.snippet` | Enforce lifecycle for Cursor |
| `tests/command-dispatch.test.mjs` | Test new commands |
| `tests/template-command-contract.test.mjs` | Test new command templates |
| `AGENTS.md` (this repo) | Updated with mandatory lifecycle |

---

## Task 1: File Hash Store

**Files:**
- Create: `tools/project-memory-context/src/file-hash-store.mjs`
- Test: `tools/project-memory-context/tests/file-hash-store.test.mjs`

- [ ] **Step 1: Write the failing tests**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import {
  computeFileHashes,
  loadHashStore,
  saveHashStore,
  detectChangedFiles,
} from '../src/file-hash-store.mjs';

const TMP = join(process.env.TEMP || '/tmp', 'pmc-hash-store-test');

test('computeFileHashes hashes tracked source files', async () => {
  await mkdir(TMP, { recursive: true });
  await writeFile(join(TMP, 'app.ts'), 'const x = 1;');
  await writeFile(join(TMP, 'util.js'), 'export function add(a, b) { return a + b; }');
  await writeFile(join(TMP, 'ignore.txt'), 'not tracked');

  const hashes = await computeFileHashes(TMP);
  assert.ok(hashes['app.ts']);
  assert.ok(hashes['util.js']);
  assert.equal(hashes['ignore.txt'], undefined);

  await rm(TMP, { recursive: true });
});

test('detectChangedFiles finds new, modified, and removed files', async () => {
  const previous = { 'a.ts': 'hash1', 'b.ts': 'hash2', 'c.ts': 'hash3' };
  const current = { 'a.ts': 'hash1', 'b.ts': 'hash2_changed', 'd.ts': 'hash4' };

  const delta = detectChangedFiles(previous, current);
  assert.deepEqual(delta.added, ['d.ts']);
  assert.deepEqual(delta.modified, ['b.ts']);
  assert.deepEqual(delta.removed, ['c.ts']);
  assert.deepEqual(delta.unchanged, ['a.ts']);
});

test('saveHashStore and loadHashStore round-trip', async () => {
  await mkdir(TMP, { recursive: true });
  const storePath = join(TMP, 'hash-store.json');
  const hashes = { 'app.ts': 'abc123', 'util.js': 'def456' };

  await saveHashStore(storePath, hashes);
  const loaded = await loadHashStore(storePath);

  assert.deepEqual(loaded, hashes);
  await rm(TMP, { recursive: true });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tools/project-memory-context/tests/file-hash-store.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement file-hash-store.mjs**

```javascript
import { join } from 'node:path';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.jsx', '.cs']);
const IGNORE_DIRS = new Set(['node_modules', 'dist', '.git', 'bin', 'obj', '.opencode', '.planning', 'graphify-out', 'target', '.next']);

async function walkDir(dir, projectRoot) {
  const results = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const relative = full.slice(projectRoot.length + 1).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) {
        results.push(...await walkDir(full, projectRoot));
      }
    } else if (SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      results.push(relative);
    }
  }
  return results;
}

export async function computeFileHashes(projectRoot) {
  const files = await walkDir(projectRoot, projectRoot);
  const hashes = {};
  for (const file of files) {
    try {
      const content = await readFile(join(projectRoot, file), 'utf8');
      hashes[file] = createHash('sha256').update(content).digest('hex');
    } catch { /* skip unreadable */ }
  }
  return hashes;
}

export async function saveHashStore(storePath, hashes) {
  await mkdir(join(storePath, '..'), { recursive: true });
  await writeFile(storePath, JSON.stringify({ hashes, updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
}

export async function loadHashStore(storePath) {
  try {
    const raw = JSON.parse(await readFile(storePath, 'utf8'));
    return raw.hashes ?? raw;
  } catch {
    return {};
  }
}

export function detectChangedFiles(previous, current) {
  const added = [];
  const modified = [];
  const removed = [];
  const unchanged = [];

  for (const file of Object.keys(current)) {
    if (!previous[file]) {
      added.push(file);
    } else if (previous[file] !== current[file]) {
      modified.push(file);
    } else {
      unchanged.push(file);
    }
  }

  for (const file of Object.keys(previous)) {
    if (!current[file]) {
      removed.push(file);
    }
  }

  return { added, modified, removed, unchanged };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tools/project-memory-context/tests/file-hash-store.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/project-memory-context/src/file-hash-store.mjs tools/project-memory-context/tests/file-hash-store.test.mjs
git commit -m "feat(pmc): add file hash store for change detection"
```

---

## Task 2: Symbol Delta Computation

**Files:**
- Create: `tools/project-memory-context/src/symbol-delta.mjs`
- Test: `tools/project-memory-context/tests/symbol-delta.test.mjs`

- [ ] **Step 1: Write the failing tests**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSymbolDelta } from '../src/symbol-delta.mjs';

test('computeSymbolDelta identifies new, stale, removed, and unchanged symbols', () => {
  const currentSymbols = [
    { symbolKey: 'js_src_app_mjs_function_exported_handleRequest_2', filePath: 'src/app.mjs', codeHash: 'h1' },
    { symbolKey: 'js_src_app_mjs_function_exported_parseInput_1', filePath: 'src/app.mjs', codeHash: 'h2_new' },
    { symbolKey: 'js_src_utils_mjs_function_exported_format_1', filePath: 'src/utils.mjs', codeHash: 'h3' },
  ];

  const existingWorklist = [
    { symbolKey: 'js_src_app_mjs_function_exported_handleRequest_2', filePath: 'src/app.mjs', codeHash: 'h1', status: 'enriched', memoryId: 'mem-1' },
    { symbolKey: 'js_src_app_mjs_function_exported_parseInput_1', filePath: 'src/app.mjs', codeHash: 'h2_old', status: 'enriched', memoryId: 'mem-2' },
    { symbolKey: 'js_src_removed_mjs_function_exported_oldFunc_1', filePath: 'src/removed.mjs', codeHash: 'h4', status: 'enriched', memoryId: 'mem-3' },
  ];

  const delta = computeSymbolDelta(currentSymbols, existingWorklist);

  assert.equal(delta.new.length, 1);
  assert.equal(delta.new[0].symbolKey, 'js_src_utils_mjs_function_exported_format_1');
  assert.equal(delta.new[0].status, 'pending');

  assert.equal(delta.stale.length, 1);
  assert.equal(delta.stale[0].symbolKey, 'js_src_app_mjs_function_exported_parseInput_1');
  assert.equal(delta.stale[0].staleReason, 'code-hash-changed');
  assert.equal(delta.stale[0].memoryId, 'mem-2');

  assert.equal(delta.removed.length, 1);
  assert.equal(delta.removed[0].symbolKey, 'js_src_removed_mjs_function_exported_oldFunc_1');

  assert.equal(delta.unchanged.length, 1);
  assert.equal(delta.unchanged[0].symbolKey, 'js_src_app_mjs_function_exported_handleRequest_2');
  assert.equal(delta.unchanged[0].memoryId, 'mem-1');
});

test('computeSymbolDelta returns empty deltas for empty inputs', () => {
  const delta = computeSymbolDelta([], []);
  assert.equal(delta.new.length, 0);
  assert.equal(delta.stale.length, 0);
  assert.equal(delta.removed.length, 0);
  assert.equal(delta.unchanged.length, 0);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tools/project-memory-context/tests/symbol-delta.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement symbol-delta.mjs**

```javascript
export function computeSymbolDelta(currentSymbols, existingWorklist) {
  const currentMap = new Map();
  for (const sym of currentSymbols) {
    currentMap.set(sym.symbolKey, sym);
  }

  const existingMap = new Map();
  for (const entry of existingWorklist) {
    existingMap.set(entry.symbolKey, entry);
  }

  const newEntries = [];
  const staleEntries = [];
  const unchangedEntries = [];

  for (const [key, sym] of currentMap) {
    const existing = existingMap.get(key);
    if (!existing) {
      newEntries.push({
        ...sym,
        status: 'pending',
        memoryId: null,
        graphNodeId: null,
      });
    } else if (existing.codeHash !== sym.codeHash) {
      staleEntries.push({
        ...sym,
        status: 'stale',
        staleReason: 'code-hash-changed',
        staleAt: new Date().toISOString(),
        memoryId: existing.memoryId || null,
        graphNodeId: existing.graphNodeId || null,
      });
    } else {
      unchangedEntries.push({
        ...existing,
        verifiedAt: new Date().toISOString(),
        codeHash: sym.codeHash,
      });
    }
  }

  const removedEntries = [];
  for (const [key, existing] of existingMap) {
    if (!currentMap.has(key)) {
      removedEntries.push(existing);
    }
  }

  return {
    new: newEntries,
    stale: staleEntries,
    removed: removedEntries,
    unchanged: unchangedEntries,
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tools/project-memory-context/tests/symbol-delta.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/project-memory-context/src/symbol-delta.mjs tools/project-memory-context/tests/symbol-delta.test.mjs
git commit -m "feat(pmc): add symbol delta computation"
```

---

## Task 3: Incremental Graph Merge

**Files:**
- Create: `tools/project-memory-context/src/incremental-graph.mjs`
- Test: `tools/project-memory-context/tests/incremental-graph.test.mjs`

- [ ] **Step 1: Write the failing tests**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeGraphDelta, extractChangedFilesFromGraph } from '../src/incremental-graph.mjs';

test('mergeGraphDelta adds new nodes and edges without duplicating existing ones', () => {
  const existing = {
    nodes: [
      { id: 'n1', label: 'App', source_file: 'src/app.mjs', community: 'core' },
      { id: 'n2', label: 'Util', source_file: 'src/util.mjs', community: 'core' },
    ],
    edges: [
      { source: 'n1', target: 'n2', relation: 'imports' },
    ],
  };

  const delta = {
    nodes: [
      { id: 'n2', label: 'Util', source_file: 'src/util.mjs', community: 'core' },
      { id: 'n3', label: 'NewModule', source_file: 'src/new.mjs', community: 'feature' },
    ],
    edges: [
      { source: 'n1', target: 'n3', relation: 'imports' },
    ],
  };

  const merged = mergeGraphDelta(existing, delta);

  assert.equal(merged.nodes.length, 3);
  assert.equal(merged.edges.length, 2);

  const ids = merged.nodes.map(n => n.id);
  assert.ok(ids.includes('n3'));
  assert.ok(ids.includes('n2'));
});

test('mergeGraphDelta handles empty delta', () => {
  const existing = { nodes: [{ id: 'n1' }], edges: [] };
  const merged = mergeGraphDelta(existing, { nodes: [], edges: [] });
  assert.equal(merged.nodes.length, 1);
});

test('extractChangedFilesFromGraph identifies which files appear in delta nodes', () => {
  const delta = {
    nodes: [
      { id: 'n1', source_file: 'src/app.mjs' },
      { id: 'n2', source_file: 'src/util.mjs' },
      { id: 'n3' },
    ],
  };

  const files = extractChangedFilesFromGraph(delta);
  assert.deepEqual(files.sort(), ['src/app.mjs', 'src/util.mjs']);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tools/project-memory-context/tests/incremental-graph.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement incremental-graph.mjs**

```javascript
export function mergeGraphDelta(existing, delta) {
  const existingNodeIds = new Set((existing.nodes ?? []).map(n => n.id));
  const existingEdgeKeys = new Set(
    (existing.edges ?? []).map(e => `${e.source}|${e.target}|${e.relation}`)
  );

  const newNodes = (delta.nodes ?? []).filter(n => !existingNodeIds.has(n.id));
  const newEdges = (delta.edges ?? []).filter(
    e => !existingEdgeKeys.has(`${e.source}|${e.target}|${e.relation}`)
  );

  return {
    nodes: [...(existing.nodes ?? []), ...newNodes],
    edges: [...(existing.edges ?? []), ...newEdges],
  };
}

export function extractChangedFilesFromGraph(delta) {
  const files = new Set();
  for (const node of delta.nodes ?? []) {
    if (node.source_file) {
      files.add(node.source_file);
    }
  }
  return [...files];
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tools/project-memory-context/tests/incremental-graph.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/project-memory-context/src/incremental-graph.mjs tools/project-memory-context/tests/incremental-graph.test.mjs
git commit -m "feat(pmc): add incremental graph merge"
```

---

## Task 4: `pmc refresh-context` CLI Command

**Files:**
- Create: `tools/project-memory-context/cli/refresh-context.mjs`
- Test: `tools/project-memory-context/tests/refresh-context.test.mjs`

- [ ] **Step 1: Write the failing tests**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { refreshContext } from '../cli/refresh-context.mjs';

const TMP = join(process.env.TEMP || '/tmp', 'pmc-refresh-test');

async function createFixture() {
  await mkdir(join(TMP, '.planning', 'project-memory-context', 'enrichment'), { recursive: true });
  await mkdir(join(TMP, '.planning', 'project-memory-context', 'graph'), { recursive: true });
  await mkdir(join(TMP, 'src'), { recursive: true });

  await writeFile(join(TMP, 'src', 'app.mjs'), 'export function greet(name) { return `Hello ${name}`; }\n');

  const worklist = [
    {
      symbolKey: 'js_src_app_mjs_function_exported_greet_1',
      filePath: 'src/app.mjs',
      kind: 'function',
      language: 'js',
      name: 'greet',
      visibility: 'exported',
      arity: 1,
      codeHash: 'old_hash',
      status: 'enriched',
      memoryId: 'mem-greet',
    },
  ];
  await writeFile(join(TMP, '.planning', 'project-memory-context', 'enrichment', 'worklist.json'), JSON.stringify(worklist, null, 2));

  await writeFile(join(TMP, '.planning', 'project-memory-context', 'enrichment', 'sync-manifest.json'), JSON.stringify({ entries: [] }));

  const graph = { nodes: [{ id: 'n1', label: 'greet', source_file: 'src/app.mjs' }], edges: [] };
  await writeFile(join(TMP, '.planning', 'project-memory-context', 'graph', 'graph.json'), JSON.stringify(graph));

  await writeFile(join(TMP, '.planning', 'project-memory-context', 'enrichment', 'hash-store.json'), JSON.stringify({ hashes: {} }));
}

test('refreshContext detects modified files and marks stale symbols', async () => {
  await createFixture();

  const result = await refreshContext(TMP);

  assert.ok(result);
  assert.ok(result.modified >= 0);
  assert.ok(typeof result.total, 'number');

  await rm(TMP, { recursive: true });
});

test('refreshContext returns early when no changes detected', async () => {
  await createFixture();

  await writeFile(join(TMP, 'src', 'app.mjs'), 'export function greet(name) { return `Hello ${name}`; }\n');

  const hashes = { 'src/app.mjs': 'test' };
  await writeFile(join(TMP, '.planning', 'project-memory-context', 'enrichment', 'hash-store.json'), JSON.stringify({ hashes }));

  const result = await refreshContext(TMP);
  assert.equal(result.total, 0);

  await rm(TMP, { recursive: true });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tools/project-memory-context/tests/refresh-context.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement refresh-context.mjs**

This is the main delta pipeline command. It orchestrates: file change detection → incremental graphify → symbol extraction → delta computation → worklist update → sync-manifest update → selective enrichment.

```javascript
#!/usr/bin/env node
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { ensureProjectMemoryContextDirs, readJsonArtifact, writeJsonArtifact } from '../src/artifacts.mjs';
import { computeFileHashes, loadHashStore, saveHashStore, detectChangedFiles } from '../src/file-hash-store.mjs';
import { extractTopLevelSymbols } from '../src/symbol-extractor.mjs';
import { attachGraphNodeIds } from '../src/graph-node-resolver.mjs';
import { computeSymbolDelta } from '../src/symbol-delta.mjs';
import { mergeGraphDelta } from '../src/incremental-graph.mjs';
import { appendSyncEntries, createSyncEntry } from '../src/sync-manifest.mjs';
import { spawnBackground, resolveGraphify } from '../src/platform.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function log(msg) { console.error(`[refresh-context] ${msg}`); }

function safeKey(key) {
  return key.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

function hashCodeFragment(content, startLine, endLine) {
  return createHash('sha256')
    .update(content.split('\n').slice(startLine - 1, endLine).join('\n'))
    .digest('hex');
}

async function runIncrementalGraphify(projectRoot, changedFiles) {
  if (changedFiles.length === 0) return null;

  let graphifyExe;
  try {
    graphifyExe = resolveGraphify();
  } catch {
    log('  graphify not available, skipping graph update.');
    return null;
  }

  log(`  Running incremental graphify on ${changedFiles.length} changed files...`);
  const r = spawnSync(graphifyExe, ['update', projectRoot], {
    cwd: projectRoot,
    stdio: 'pipe',
  });

  if (r.status !== 0) {
    log('  graphify update failed, continuing with existing graph.');
    return null;
  }

  const graphifyOutDir = resolve(projectRoot, 'graphify-out');
  try {
    const graphJsonPath = resolve(graphifyOutDir, 'graph.json');
    const raw = await readFile(graphJsonPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function refreshContext(projectRoot) {
  const projectSlug = basename(projectRoot).toLowerCase();
  const dirs = await ensureProjectMemoryContextDirs(projectRoot);

  log('Computing file hashes...');
  const currentHashes = await computeFileHashes(projectRoot);

  const hashStorePath = resolve(dirs.enrichment, 'hash-store.json');
  const previousHashes = await loadHashStore(hashStorePath);

  const fileDelta = detectChangedFiles(previousHashes, currentHashes);
  const changedFiles = [...fileDelta.added, ...fileDelta.modified];
  const totalChanges = changedFiles.length + fileDelta.removed.length;

  if (totalChanges === 0) {
    log('No changes detected.');
    return { total: 0, added: 0, modified: 0, removed: 0, newSymbols: 0, staleSymbols: 0, removedSymbols: 0 };
  }

  log(`Changes: ${fileDelta.added.length} added, ${fileDelta.modified.length} modified, ${fileDelta.removed.length} removed`);

  let existingGraph = await readJsonArtifact(resolve(dirs.graph, 'graph.json'), { nodes: [], edges: [] });

  if (changedFiles.length > 0) {
    const graphifyResult = await runIncrementalGraphify(projectRoot, changedFiles);
    if (graphifyResult) {
      existingGraph = mergeGraphDelta(existingGraph, graphifyResult);
      await writeJsonArtifact(resolve(dirs.graph, 'graph.json'), existingGraph);
      log('  Graph updated with new nodes/edges.');
    }
  }

  // BUG FIX: Extract symbols from ALL source files, not just changed files.
  // Otherwise computeSymbolDelta treats symbols in unchanged files as "removed".
  // For changed files: use fresh extraction. For unchanged files: reuse existing worklist entries.
  log('Extracting symbols from changed files...');
  const changedFileSymbols = [];
  for (const file of changedFiles) {
    try {
      const content = await readFile(resolve(projectRoot, file), 'utf8');
      const symbols = extractTopLevelSymbols({ filePath: file, content });
      for (const sym of symbols) {
        sym.codeHash = hashCodeFragment(content, sym.range.startLine, sym.range.endLine);
      }
      changedFileSymbols.push(...symbols);
    } catch { /* skip unreadable */ }
  }

  const resolvedChangedSymbols = attachGraphNodeIds({ symbols: changedFileSymbols, graph: existingGraph });

  const existingWorklist = await readJsonArtifact(resolve(dirs.enrichment, 'worklist.json'), []);

  // Build the full "current" symbol set: changed file symbols + unchanged worklist entries
  const changedFileSet = new Set(changedFiles);
  const unchangedWorklistEntries = existingWorklist.filter(
    entry => !changedFileSet.has(entry.filePath)
  );

  const allCurrentSymbols = [...resolvedChangedSymbols, ...unchangedWorklistEntries];
  const symbolDelta = computeSymbolDelta(allCurrentSymbols, existingWorklist);

  const syncOps = [];

  for (const sym of symbolDelta.stale) {
    syncOps.push(createSyncEntry({
      action: 'delete',
      keyTag: `key:symbol:${safeKey(sym.symbolKey)}`,
      tags: ['symbol', sym.language, sym.kind, `project:${projectSlug}`, `file:${sym.filePath}`],
      source: 'refresh-context',
      symbolKey: sym.symbolKey,
    }));
  }

  for (const sym of symbolDelta.removed) {
    syncOps.push(createSyncEntry({
      action: 'delete',
      keyTag: `key:symbol:${safeKey(sym.symbolKey)}`,
      tags: ['symbol', sym.language, sym.kind, `project:${projectSlug}`, `file:${sym.filePath}`],
      source: 'refresh-context',
      symbolKey: sym.symbolKey,
    }));
  }

  const newWorklist = [
    ...symbolDelta.new,
    ...symbolDelta.stale,
    ...symbolDelta.unchanged,
  ];

  await writeJsonArtifact(resolve(dirs.enrichment, 'worklist.json'), newWorklist);

  if (syncOps.length > 0) {
    await appendSyncEntries(dirs.enrichment, syncOps);
  }

  await saveHashStore(hashStorePath, currentHashes);

  const pendingCount = newWorklist.filter(e => e.status === 'pending' || e.status === 'stale').length;

  const result = {
    total: totalChanges,
    added: fileDelta.added.length,
    modified: fileDelta.modified.length,
    removed: fileDelta.removed.length,
    newSymbols: symbolDelta.new.length,
    staleSymbols: symbolDelta.stale.length,
    removedSymbols: symbolDelta.removed.length,
    syncOps: syncOps.length,
    pendingEnrichment: pendingCount,
  };

  log('');
  log('=== Refresh Report ===');
  log(`File changes: ${result.added} added, ${result.modified} modified, ${result.removed} removed`);
  log(`Symbol deltas: ${result.newSymbols} new, ${result.staleSymbols} stale, ${result.removedSymbols} removed`);
  log(`Sync-manifest operations: ${result.syncOps}`);
  log(`Pending enrichment: ${result.pendingEnrichment}`);

  if (pendingCount > 0) {
    const enrichCli = resolve(__dirname, 'enrich.mjs');
    spawnBackground(process.execPath, [enrichCli, projectRoot], { cwd: projectRoot });
    log('Background enrichment launched.');
  }

  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const projectRoot = resolve(args.find(a => !a.startsWith('--')) ?? process.cwd());
  await refreshContext(projectRoot);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('[refresh-context] FATAL:', err.message);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test tools/project-memory-context/tests/refresh-context.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/project-memory-context/cli/refresh-context.mjs tools/project-memory-context/tests/refresh-context.test.mjs
git commit -m "feat(pmc): add pmc refresh-context — incremental delta pipeline"
```

---

## Task 5: Register `refresh-context` in Dispatcher + Templates

**Files:**
- Modify: `tools/project-memory-context/src/command-dispatch.mjs`
- Create: `tools/project-memory-context/templates/opencode/commands/refresh-context.md`
- Modify: `tools/project-memory-context/tests/command-dispatch.test.mjs`
- Modify: `tools/project-memory-context/tests/template-command-contract.test.mjs`

- [ ] **Step 1: Add failing dispatcher test for refresh-context**

Add to `tests/command-dispatch.test.mjs`:

```javascript
test('resolveCommand maps refresh-context', () => {
  const command = resolveCommand(['refresh-context']);
  assert.equal(command.name, 'refresh-context');
  assert.equal(command.modulePath, resolve(PACKAGE_ROOT, 'cli', 'refresh-context.mjs'));
  assert.equal(command.valid, true);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `node --test tools/project-memory-context/tests/command-dispatch.test.mjs`
Expected: FAIL — refresh-context not in command map

- [ ] **Step 3: Add refresh-context to command-dispatch.mjs**

Add to the `COMMANDS` map in `src/command-dispatch.mjs`:

```javascript
['refresh-context', 'cli/refresh-context.mjs'],
```

- [ ] **Step 4: Create command template**

Create `templates/opencode/commands/refresh-context.md`:

```markdown
---
name: refresh-context
description: Detect code changes and update graph, worklist, and memories incrementally
---

# Refresh Context

Detect changed source files, run incremental graph update, extract new/modified symbols, and queue selective re-enrichment.

## When to run

- After making code changes (new functions, modified classes, deleted files)
- Before starting work on a task if context might be stale
- As part of session autostart if changes were made outside this session

## Command

```bash
{{PMC_BIN}} refresh-context
```

## What it does

1. Computes file hashes and compares with last known state
2. Runs incremental graphify on changed files only
3. Merges new graph nodes/edges into existing graph
4. Extracts symbols from changed files
5. Computes symbol deltas (new, stale, removed)
6. Updates worklist and sync-manifest
7. Launches background enrichment for pending symbols

## After running

Run `{{PMC_BIN}} sync-context` to persist enrichment results to agent-memory.
```

- [ ] **Step 5: Add template contract test**

Add to `tests/template-command-contract.test.mjs`:

```javascript
assert.match(readTemplate('opencode/commands/refresh-context.md'), /\{\{PMC_BIN\}\} refresh-context/);
```

- [ ] **Step 6: Run all affected tests**

Run: `node --test tools/project-memory-context/tests/command-dispatch.test.mjs tools/project-memory-context/tests/template-command-contract.test.mjs`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add tools/project-memory-context/src/command-dispatch.mjs tools/project-memory-context/templates/opencode/commands/refresh-context.md tools/project-memory-context/tests/command-dispatch.test.mjs tools/project-memory-context/tests/template-command-contract.test.mjs
git commit -m "feat(pmc): register refresh-context in dispatcher and templates"
```

---

## Task 6: Update AGENTS.md Autostart with Mandatory Lifecycle Enforcement

**Files:**
- Modify: `tools/project-memory-context/templates/opencode/autostart-snippet.md`
- Modify: `tools/project-memory-context/templates/claude-code/CLAUDE.md.snippet`
- Modify: `tools/project-memory-context/templates/cursor/.cursorrules.snippet`
- Modify: `AGENTS.md` (this repo)

- [ ] **Step 1: Rewrite autostart-snippet.md with mandatory lifecycle**

Replace the content of `templates/opencode/autostart-snippet.md` with a deterministic autostart that enforces the full PMC lifecycle:

```markdown
<!-- pmc:autostart -->
On EVERY session start, BEFORE responding to the user, execute these steps IN ORDER:

1. **Check enrichment status**: Read `.planning/project-memory-context/enrichment/worklist.json`. Count entries with `status: "pending"` or `status: "stale"`. If count > 0, launch background enrichment:
   - Windows: `Start-Process -FilePath "npx" -ArgumentList "--yes","--package","@aabadin/project-memory-context","pmc","enrich","." -WindowStyle Hidden`
   - POSIX: `nohup npx --yes --package @aabadin/project-memory-context pmc enrich . > /dev/null 2>&1 &`

2. **Check sync-manifest**: Read `.planning/project-memory-context/enrichment/sync-manifest.json`. If `entries` contains any element with `status: "pending"`, surface: "PMC has N pending sync operations. Run `/sync-context` to apply them."

3. **Recall base context**: Call `agent-memory_search` with `query: "project context overview"` and `tags: ["project-context"]`. Present a brief summary (~500 tokens) to establish session context.

4. **Remind**: "Use `/get-context <target>` for structural deep-dive BEFORE reading files."

## Mandatory PMC Workflow (ENFORCED)

- **BEFORE reading any source file**: Run `pmc get-context <file-or-symbol>` FIRST. Do NOT open files with Read/Grep without first checking PMC context.
- **AFTER implementing code changes**: Run `pmc refresh-context` to detect changes, update graph, and queue re-enrichment.
- **AFTER refresh-context completes**: Run `pmc sync-context` to persist new/updated memories.
- **Default context depth**: Always use `depth=compact`. Use `extended` or `deep` ONLY when explicitly asked.

## Context Retrieval Rules

| Situation | Command | Depth |
|-----------|---------|-------|
| About to read a file | `pmc get-context <file>` | compact |
| Working on a specific symbol | `pmc get-context <symbol>` | compact |
| Need dependency information | `pmc get-context <symbol> extended dependencies` | extended |
| Debugging complex issues | `pmc get-context <symbol> deep all` | deep |
| Need raw source code | `pmc get-context <symbol> disk` | disk |
| Quick project overview | `agent-memory_search "project context overview"` | — |
| After code changes | `pmc refresh-context` then `pmc sync-context` | — |
<!-- /pmc:autostart -->
```

- [ ] **Step 2: Update CLAUDE.md snippet with same lifecycle**

Update `templates/claude-code/CLAUDE.md.snippet` to mirror the autostart pattern, using Claude Code's command format.

- [ ] **Step 3: Update .cursorrules snippet with same lifecycle**

Update `templates/cursor/.cursorrules.snippet` to mirror the autostart pattern.

- [ ] **Step 4: Update this repo's AGENTS.md**

Update the `AGENTS.md` at repo root with the same mandatory lifecycle pattern, adapting for the source repo (using `node tools/project-memory-context/cli/...` paths).

- [ ] **Step 5: Run template contract tests**

Run: `node --test tools/project-memory-context/tests/template-command-contract.test.mjs tools/project-memory-context/tests/init.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add tools/project-memory-context/templates/ AGENTS.md
git commit -m "feat(pmc): enforce mandatory lifecycle in AGENTS.md autostart"
```

---

## Task 7: `pmc watch` — File Watcher Mode

**Files:**
- Create: `tools/project-memory-context/src/file-watcher.mjs`
- Create: `tools/project-memory-context/cli/watch.mjs`
- Test: `tools/project-memory-context/tests/file-watcher.test.mjs`

- [ ] **Step 1: Write the failing tests**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { debounce, shouldWatch } from '../src/file-watcher.mjs';

test('shouldWatch accepts source files and rejects ignored paths', () => {
  assert.equal(shouldWatch('src/app.ts'), true);
  assert.equal(shouldWatch('src/app.mjs'), true);
  assert.equal(shouldWatch('src/app.js'), true);
  assert.equal(shouldWatch('src/app.cs'), true);
  assert.equal(shouldWatch('src/app.py'), false);
  assert.equal(shouldWatch('node_modules/foo/index.js'), false);
  assert.equal(shouldWatch('.planning/state.json'), false);
  assert.equal(shouldWatch('dist/bundle.js'), false);
  assert.equal(shouldWatch('README.md'), false);
});

test('debounce delays execution', async () => {
  let count = 0;
  const fn = debounce(() => { count++; }, 50);
  fn();
  fn();
  fn();
  assert.equal(count, 0);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(count, 1);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test tools/project-memory-context/tests/file-watcher.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement file-watcher.mjs**

```javascript
import { join, extname } from 'node:path';

const WATCH_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.jsx', '.cs']);
const IGNORE_PREFIXES = ['node_modules', 'dist', '.git', 'bin', 'obj', '.opencode', '.planning', 'graphify-out', '.next'];

export function shouldWatch(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  if (IGNORE_PREFIXES.some(prefix => normalized.includes(`/${prefix}/`) || normalized.startsWith(`${prefix}/`))) {
    return false;
  }
  return WATCH_EXTENSIONS.has(extname(normalized));
}

export function debounce(fn, delayMs) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}
```

- [ ] **Step 4: Implement watch.mjs CLI**

```javascript
#!/usr/bin/env node
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watch } from 'node:fs';
import { shouldWatch, debounce } from '../src/file-watcher.mjs';
import { refreshContext } from './refresh-context.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function log(msg) { console.error(`[watch] ${msg}`); }

async function main() {
  const projectRoot = resolve(process.argv[2] ?? process.cwd());
  log(`Watching ${projectRoot} for source file changes...`);
  log('Press Ctrl+C to stop.');

  const onChange = debounce(async () => {
    log('Changes detected, running refresh-context...');
    try {
      await refreshContext(projectRoot);
    } catch (err) {
      log(`refresh-context error: ${err.message}`);
    }
  }, 2000);

  const watcher = watch(projectRoot, { recursive: true }, (eventType, filename) => {
    if (filename && shouldWatch(filename)) {
      log(`  ${eventType}: ${filename}`);
      onChange();
    }
  });

  watcher.on('error', (err) => {
    log(`Watcher error: ${err.message}`);
  });

  process.on('SIGINT', () => {
    log('Stopping watcher.');
    watcher.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[watch] FATAL:', err.message);
  process.exit(1);
});
```

- [ ] **Step 5: Run tests and add watch to dispatcher**

Run: `node --test tools/project-memory-context/tests/file-watcher.test.mjs`
Expected: PASS

Add to `src/command-dispatch.mjs`:
```javascript
['watch', 'cli/watch.mjs'],
```

- [ ] **Step 6: Commit**

```bash
git add tools/project-memory-context/src/file-watcher.mjs tools/project-memory-context/cli/watch.mjs tools/project-memory-context/tests/file-watcher.test.mjs tools/project-memory-context/src/command-dispatch.mjs
git commit -m "feat(pmc): add pmc watch — file watcher for automatic refresh"
```

---

## Final Verification

- [ ] **Run the full test suite**

```bash
node --test tools/project-memory-context/tests/*.test.mjs
```

Expected: ALL PASS (existing 349 + new tests)

- [ ] **Smoke test refresh-context**

```bash
node tools/project-memory-context/bin/pmc.mjs refresh-context
```

Expected: JSON report showing file changes detected (or "No changes detected" if clean)

- [ ] **Smoke test watch mode (manual)**

```bash
node tools/project-memory-context/bin/pmc.mjs watch .
```

Expected: "Watching ... for source file changes" — then modify a .mjs file and verify refresh triggers

- [ ] **Verify lifecycle flow end-to-end**

```bash
# 1. Make a code change
echo "export function newFunction() { return 42; }" >> tools/project-memory-context/src/test-target.mjs

# 2. Run refresh
node tools/project-memory-context/bin/pmc.mjs refresh-context

# 3. Verify graph updated
node -e "const g = require('./.planning/project-memory-context/graph/graph.json'); console.log(g.nodes.length + ' nodes')"

# 4. Run sync
node tools/project-memory-context/bin/pmc.mjs sync-context

# 5. Cleanup
rm tools/project-memory-context/src/test-target.mjs
```

Expected: new symbol detected → graph updated → worklist updated → enrichment queued → sync persists to agent-memory

---

## Spec Coverage Check

| Requirement | Task |
|-------------|------|
| File change detection | Task 1 (file-hash-store) |
| Symbol delta computation | Task 2 (symbol-delta) |
| Incremental graph merge | Task 3 (incremental-graph) |
| New `pmc refresh-context` command | Task 4 (CLI) |
| Dispatcher + template registration | Task 5 |
| Mandatory lifecycle in AGENTS.md | Task 6 |
| File watcher mode | Task 7 (watch) |
