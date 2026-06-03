# PMC Query Access V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build CLI query, MCP query tools, and PMC-aware agent guidance on top of the real PMC artifact layout that exists today.

**Architecture:** Introduce a small normalization layer that reads canonical PMC artifacts exactly as current writers persist them: project-context memories from `project-context/materialized/`, semantic summaries from graph node metadata, and graph relationships from either `edges` or `links`. Then rebuild the orchestrator, CLI, MCP server, and agent templates on that normalized view.

**Tech Stack:** Node.js native modules, existing PMC artifact writers/readers, `@modelcontextprotocol/sdk`, zod

---

## File Structure

**Create:**
- `tools/project-memory-context/src/query/load-artifacts.mjs` — canonical PMC artifact loader + schema normalization
- `tools/project-memory-context/tests/query-artifacts.test.mjs` — tests for real artifact layout compatibility
- `tools/project-memory-context/cli/query.mjs` — human CLI entrypoint
- `tools/project-memory-context/mcp/pmc-query-server.mjs` — MCP tool server for project queries
- `tools/project-memory-context/templates/pmc-skill/SKILL.md` — PMC-aware skill guidance

**Modify:**
- `tools/project-memory-context/src/query/orchestrator.mjs` — rebuild on normalized loader, avoid duplicate reads
- `tools/project-memory-context/tests/query.test.mjs` — use realistic fixtures and orchestrator behavior
- `tools/project-memory-context/src/command-dispatch.mjs` — register `query`
- `tools/project-memory-context/src/plugin-config.mjs` — inject query MCP server config
- `tools/project-memory-context/package.json` — add server bin if needed
- `tools/project-memory-context/src/template-installer.mjs` — install PMC-aware skill
- `tools/project-memory-context/templates/claude-code/CLAUDE.md.snippet` — add PMC-first guidance
- `tools/project-memory-context/templates/cursor/.cursorrules.snippet` — add PMC-first guidance
- `tools/project-memory-context/tests/init.test.mjs` — assert new template installation

## Constraints From Review

- Query code must work with `project-context/materialized/*.json`, not just ad-hoc root JSON.
- Enriched summaries must come from `graph.nodes[].metadata.semanticSummary` because current symbol index persistence does not store them.
- Graph traversal must support both `graph.edges` and `graph.links` shapes because nearby PMC code still uses both.
- Tests must model the real persisted shape produced by current PMC writers, not synthetic shortcuts.
- Do not commit unless the user explicitly asks for commits.

---

### Task 1: Normalize PMC Artifact Loading

**Files:**
- Create: `tools/project-memory-context/src/query/load-artifacts.mjs`
- Create: `tools/project-memory-context/tests/query-artifacts.test.mjs`

- [ ] **Step 1: Write failing artifact-shape tests first**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadQueryArtifacts } from '../src/query/load-artifacts.mjs';

async function makeProject() {
  const root = await mkdtemp(join(os.tmpdir(), 'pmc-query-artifacts-'));
  const pmc = join(root, '.planning', 'project-memory-context');
  await mkdir(join(pmc, 'project-context', 'materialized'), { recursive: true });
  await mkdir(join(pmc, 'enrichment'), { recursive: true });
  await mkdir(join(pmc, 'graph'), { recursive: true });
  return { root, pmc };
}

test('loads materialized project-context memories from canonical directory', async () => {
  const { root, pmc } = await makeProject();
  try {
    await writeFile(join(pmc, 'project-context', 'materialized', 'stack-runtime.json'), JSON.stringify({
      kind: 'stack-runtime',
      title: 'Stack Runtime',
      summary: 'Next.js app',
      body: 'Uses Next.js App Router.',
      tags: ['project-context', 'nextjs'],
    }, null, 2));
    await writeFile(join(pmc, 'enrichment', 'symbol-index.json'), '{}');
    await writeFile(join(pmc, 'graph', 'graph.json'), JSON.stringify({ nodes: [], edges: [] }, null, 2));

    const data = await loadQueryArtifacts(root);
    assert.equal(data.memories.length, 1);
    assert.match(data.memories[0].path, /project-context[\\/]materialized[\\/]stack-runtime\.json$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('hydrates semantic summaries from graph node metadata when symbol-index lacks them', async () => {
  const { root, pmc } = await makeProject();
  try {
    const symbolKey = 'ts|src/profile.ts|function|exported|buildUserProfile|1';
    await writeFile(join(pmc, 'enrichment', 'symbol-index.json'), JSON.stringify({
      [symbolKey]: { graphNodeId: 'build-node', status: 'enriched' },
    }, null, 2));
    await writeFile(join(pmc, 'graph', 'graph.json'), JSON.stringify({
      nodes: [{
        id: 'build-node',
        metadata: { symbolKey, semanticSummary: 'Builds a user profile view model.' },
      }],
      edges: [],
    }, null, 2));

    const data = await loadQueryArtifacts(root);
    assert.equal(data.symbols[0].semanticSummary, 'Builds a user profile view model.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('normalizes graph relationships from either edges or links', async () => {
  const { root, pmc } = await makeProject();
  try {
    await writeFile(join(pmc, 'enrichment', 'symbol-index.json'), '{}');
    await writeFile(join(pmc, 'graph', 'graph.json'), JSON.stringify({
      nodes: [],
      links: [{ source: 'a', target: 'b', relation: 'calls' }],
    }, null, 2));

    const data = await loadQueryArtifacts(root);
    assert.equal(data.edges.length, 1);
    assert.deepEqual(data.edges[0], { source: 'a', target: 'b', relation: 'calls' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify RED**

Run: `cd tools/project-memory-context && node --test tests/query-artifacts.test.mjs`
Expected: FAIL with missing `load-artifacts.mjs`

- [ ] **Step 3: Implement the minimal loader**

```js
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeSymbolKey(symbolKey) {
  const parts = String(symbolKey ?? '').split('|');
  return {
    symbolKey,
    filePath: parts[1] ?? '',
    name: parts[parts.length - 2] ?? '',
  };
}

export async function loadQueryArtifacts(projectRoot) {
  const pmcRoot = join(projectRoot, '.planning', 'project-memory-context');
  const materializedDir = join(pmcRoot, 'project-context', 'materialized');
  const fallbackDir = join(pmcRoot, 'project-context');
  const symbolIndex = await readJson(join(pmcRoot, 'enrichment', 'symbol-index.json'), {});
  const graph = await readJson(join(pmcRoot, 'graph', 'graph.json'), { nodes: [], edges: [], links: [] });

  const preferredEntries = await readJsonDirectory(materializedDir);
  const memoryDir = preferredEntries.length > 0 ? materializedDir : fallbackDir;
  const memoryEntries = preferredEntries.length > 0 ? preferredEntries : await readJsonDirectory(fallbackDir);

  const memories = [];
  for (const fileName of memoryEntries) {
    const content = await readJson(join(memoryDir, fileName), null);
    if (content) memories.push({ ...content, path: join(memoryDir, fileName) });
  }

  const nodeById = new Map((graph.nodes ?? []).map((node) => [node.id, node]));
  const symbols = Object.entries(symbolIndex).map(([symbolKey, entry]) => {
    const parsed = normalizeSymbolKey(symbolKey);
    const node = entry?.graphNodeId ? nodeById.get(entry.graphNodeId) : null;
    return {
      ...parsed,
      graphNodeId: entry?.graphNodeId ?? null,
      memoryId: entry?.memoryId ?? null,
      status: entry?.status ?? null,
      semanticSummary: entry?.semanticSummary ?? node?.metadata?.semanticSummary ?? '',
    };
  });

  return {
    memories,
    symbols,
    nodes: graph.nodes ?? [],
    edges: graph.edges ?? graph.links ?? [],
  };
}

async function readJsonDirectory(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name).sort();
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run the tests to verify GREEN**

Run: `cd tools/project-memory-context && node --test tests/query-artifacts.test.mjs`
Expected: PASS

- [ ] **Step 5: Skip commit by policy**

No commit. User has not requested commits.

---

### Task 2: Rebuild Orchestrator On Normalized Artifacts

**Files:**
- Modify: `tools/project-memory-context/src/query/orchestrator.mjs`
- Modify: `tools/project-memory-context/tests/query.test.mjs`
- Test: `tools/project-memory-context/tests/query-artifacts.test.mjs`

- [ ] **Step 1: Rewrite failing orchestrator tests to use realistic persisted fixtures**

Update fixtures so they write:
- project memories to `project-context/materialized/*.json`
- summaries through `graph.nodes[].metadata.semanticSummary`
- graph relationships with at least one test using `edges`

Add/adjust tests so they prove:
- `query()` finds a base memory from `materialized/stack-runtime.json`
- `searchSymbols('view model')` works when summary exists only on graph node metadata
- `getDependencies()` works when graph file uses `edges`
- `query()` does not reload artifacts twice for one question (assert through loader injection or a tiny seam if needed)

- [ ] **Step 2: Run the tests to verify RED**

Run: `cd tools/project-memory-context && node --test tests/query.test.mjs`
Expected: FAIL because orchestrator still assumes old direct JSON / duplicated reads

- [ ] **Step 3: Rebuild `orchestrator.mjs` around the loader**

```js
import { loadQueryArtifacts } from './load-artifacts.mjs';

function tokenize(value) {
  return String(value ?? '').toLowerCase().split(/[^a-z0-9]+/i).filter((token) => token.length >= 2);
}

function countMatches(tokens, text) {
  const haystack = String(text ?? '').toLowerCase();
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

export function createQueryOrchestrator({ projectRoot, loadArtifacts = loadQueryArtifacts }) {
  async function load() {
    return loadArtifacts(projectRoot);
  }

  async function searchSymbols(query, fileFilter = '') {
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];
    const data = await load();
    const fileNeedle = String(fileFilter).replace(/\\/g, '/');
    return data.symbols
      .map((symbol) => ({
        ...symbol,
        score: countMatches(tokens, [symbol.name, symbol.filePath, symbol.semanticSummary].join(' ')),
      }))
      .filter((symbol) => symbol.score > 0 && (!fileNeedle || symbol.filePath.replace(/\\/g, '/') === fileNeedle))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  async function query(question) {
    const tokens = tokenize(question);
    if (tokens.length === 0) return { answer: '', sources: [], tokens_saved: 0 };
    const data = await load();

    const memoryMatches = data.memories
      .map((memory) => ({
        ...memory,
        score: countMatches(tokens, [memory.title, memory.summary, memory.body, ...(memory.tags ?? [])].join(' ')),
      }))
      .filter((memory) => memory.score > 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

    const symbolMatches = data.symbols
      .map((symbol) => ({
        ...symbol,
        score: countMatches(tokens, [symbol.name, symbol.filePath, symbol.semanticSummary].join(' ')),
      }))
      .filter((symbol) => symbol.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    const parts = [];
    const sources = [];

    for (const memory of memoryMatches.slice(0, 3)) {
      if (!memory.body) continue;
      parts.push(`${memory.title}: ${memory.body}`);
      sources.push({ type: 'project-context', path: memory.path, title: memory.title });
    }

    for (const symbol of symbolMatches.slice(0, 3)) {
      if (!symbol.semanticSummary) continue;
      parts.push(`Symbol ${symbol.name} (${symbol.filePath}): ${symbol.semanticSummary}`);
      sources.push({ type: 'symbol', symbolKey: symbol.symbolKey, filePath: symbol.filePath, graphNodeId: symbol.graphNodeId });
    }

    const answer = parts.join('\n\n');
    if (!answer) return { answer: '', sources: [], tokens_saved: 0 };
    return { answer, sources, tokens_saved: Math.max(1, Math.ceil(answer.length / 6)) };
  }

  async function related(symbolKey, direction) {
    const data = await load();
    const origin = data.symbols.find((symbol) => symbol.symbolKey === symbolKey || symbol.name === symbolKey);
    if (!origin?.graphNodeId) return [];
    const symbolByNode = new Map(data.symbols.filter((symbol) => symbol.graphNodeId).map((symbol) => [symbol.graphNodeId, symbol]));
    return data.edges
      .map((edge) => direction === 'inbound'
        ? (edge.target === origin.graphNodeId ? symbolByNode.get(edge.source) : null)
        : (edge.source === origin.graphNodeId ? symbolByNode.get(edge.target) : null))
      .filter(Boolean);
  }

  return {
    query,
    searchSymbols,
    getDependents(symbolKey) { return related(symbolKey, 'inbound'); },
    getDependencies(symbolKey) { return related(symbolKey, 'outbound'); },
  };
}
```

- [ ] **Step 4: Run orchestrator tests and broader related tests**

Run: `cd tools/project-memory-context && node --test tests/query*.test.mjs`
Expected: PASS

- [ ] **Step 5: Skip commit by policy**

No commit. User has not requested commits.

---

### Task 3: Add `pmc query` CLI

**Files:**
- Create: `tools/project-memory-context/cli/query.mjs`
- Modify: `tools/project-memory-context/src/command-dispatch.mjs`
- Modify: `tools/project-memory-context/tests/query.test.mjs`

- [ ] **Step 1: Write failing CLI tests first**

Add tests for:
- `resolveCommand(['query'])` resolves to `cli/query.mjs`
- `pmc query --help` prints usage
- querying outside a PMC-enabled project exits with a clear error

- [ ] **Step 2: Run RED**

Run: `cd tools/project-memory-context && node --test tests/query.test.mjs`
Expected: FAIL because `query` command is not registered yet

- [ ] **Step 3: Register and implement CLI**

Add to `src/command-dispatch.mjs`:

```js
['query', 'cli/query.mjs'],
```

Create `cli/query.mjs` with:
- `--help` output
- project-root discovery by walking parent dirs for `.planning/project-memory-context/install.json`
- call to `createQueryOrchestrator({ projectRoot })`
- `--format json` support
- text output with answer, sources, and rough token-saved line

- [ ] **Step 4: Run GREEN**

Run: `cd tools/project-memory-context && node --test tests/query.test.mjs`
Expected: PASS

- [ ] **Step 5: Skip commit by policy**

No commit. User has not requested commits.

---

### Task 4: Add PMC Query MCP Server

**Files:**
- Create: `tools/project-memory-context/mcp/pmc-query-server.mjs`
- Modify: `tools/project-memory-context/src/plugin-config.mjs`
- Modify: `tools/project-memory-context/package.json`
- Modify: `tools/project-memory-context/tests/query.test.mjs`

- [ ] **Step 1: Write failing MCP tests first**

Add tests for:
- `package.json` exposes a `pmc-query-server` bin if that is the chosen launch strategy
- the server declares tools: `pmc_query_project`, `pmc_search_symbols`, `pmc_get_dependents`, `pmc_get_dependencies`

- [ ] **Step 2: Run RED**

Run: `cd tools/project-memory-context && node --test tests/query.test.mjs`
Expected: FAIL because the server/bin does not exist yet

- [ ] **Step 3: Implement the server minimally**

Create `mcp/pmc-query-server.mjs` following `mcp/local-model-server.mjs` patterns:
- `const projectRoot = process.env.PMC_PROJECT_ROOT || process.cwd()`
- instantiate `createQueryOrchestrator({ projectRoot })`
- expose four tools only:
  - `pmc_query_project({ question })`
  - `pmc_search_symbols({ query, file? })`
  - `pmc_get_dependents({ symbol })`
  - `pmc_get_dependencies({ symbol })`
- return text payloads only in v1

Update `package.json` bin block:

```json
"bin": {
  "pmc": "bin/pmc.mjs",
  "pmc-query-server": "mcp/pmc-query-server.mjs"
}
```

Update `src/plugin-config.mjs` to inject:

```js
'pmc-query': {
  type: 'local',
  command: ['pmc-query-server'],
  enabled: true,
  environment: {
    PMC_PROJECT_ROOT: installState.projectRoot,
  },
},
```

- [ ] **Step 4: Run GREEN**

Run: `cd tools/project-memory-context && node --test tests/query.test.mjs`
Expected: PASS

- [ ] **Step 5: Skip commit by policy**

No commit. User has not requested commits.

---

### Task 5: Add PMC-Aware Skill And Agent Snippets

**Files:**
- Create: `tools/project-memory-context/templates/pmc-skill/SKILL.md`
- Modify: `tools/project-memory-context/src/template-installer.mjs`
- Modify: `tools/project-memory-context/templates/claude-code/CLAUDE.md.snippet`
- Modify: `tools/project-memory-context/templates/cursor/.cursorrules.snippet`
- Modify: `tools/project-memory-context/tests/init.test.mjs`

- [ ] **Step 1: Write failing installer/template tests first**

Add tests that verify:
- `templates/pmc-skill/SKILL.md` exists and contains `PMC first, files second`
- `installAgentTemplates({ agent: 'opencode' })` writes `skills/pmc-skill/SKILL.md`
- Claude/Cursor snippets mention PMC-first guidance and MCP tools

- [ ] **Step 2: Run RED**

Run: `cd tools/project-memory-context && node --test tests/init.test.mjs`
Expected: FAIL because the template and installer logic do not exist yet

- [ ] **Step 3: Implement minimal skill + snippet updates**

Create `templates/pmc-skill/SKILL.md` with these required sections:
- token optimization rule: PMC first, files second
- commands overview: `/map-project`, `/get-context`, `/enrich-status`, `/doctor`, `/init-project`, `/sync-context`, `/sanitize`
- MCP tools overview: `pmc_query_project`, `pmc_search_symbols`, `pmc_get_dependents`, `pmc_get_dependencies`
- workflow guidance: query PMC before reading more than 3 files

Update `src/template-installer.mjs` so the OpenCode installer writes:

```js
await writeIfMissingOrForced(
  join(globalDir, 'skills', 'pmc-skill', 'SKILL.md'),
  renderTemplate(await readTemplate(packageRoot, 'pmc-skill/SKILL.md'), placeholders),
  { force: true },
);
```

Append to the Claude/Cursor snippets:
- `Before reading more than 3 files, query PMC first.`
- short list of available PMC tools and `/get-context`

- [ ] **Step 4: Run GREEN**

Run: `cd tools/project-memory-context && node --test tests/init.test.mjs`
Expected: PASS

- [ ] **Step 5: Skip commit by policy**

No commit. User has not requested commits.

---

### Task 6: Final Verification

**Files:**
- Verify only

- [ ] **Step 1: Run the focused PMC test suites**

Run: `cd tools/project-memory-context && node --test tests/query-artifacts.test.mjs tests/query.test.mjs tests/init.test.mjs`
Expected: PASS

- [ ] **Step 2: Run the full package test suite**

Run: `cd tools/project-memory-context && node --test tests/*.test.mjs`
Expected: PASS with no regressions

- [ ] **Step 3: Manual smoke checks**

Run:

```powershell
node cli/query.mjs --help
node cli/query.mjs "what framework does this project use?"
```

Expected:
- help output renders cleanly
- query returns PMC-derived answer or a clean "no relevant context" message

- [ ] **Step 4: Final review pass**

Re-check:
- no remaining assumptions about direct root `project-context/*.json` as canonical shape
- semantic summaries are sourced from real persisted artifacts
- graph helpers accept both `edges` and `links`
- no new command/template regressions

---

## Self-Review

**Spec coverage:**
- query engine still exists, but now on normalized real artifacts
- CLI, MCP server, and skill remain in scope
- review findings are now first-class implementation constraints

**Placeholder scan:**
- No TBD/TODO placeholders left in tasks
- Commands and file paths are explicit

**Type consistency:**
- `createQueryOrchestrator({ projectRoot, loadArtifacts? })` remains the single orchestrator entrypoint
- `loadQueryArtifacts(projectRoot)` is the single normalization seam
- MCP tool names are consistent across Task 4 and Task 5
