# /get-context V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pmc context` target-aware so `/get-context` can resolve symbols, files, or free-text structural targets and return compact structural context instead of only refreshing repo-wide project context.

**Architecture:** Keep the existing `src/retrieval/query-engine.mjs` as the structural backend. Add a small target-resolution + rendering layer in `cli/context.mjs` and supporting helpers. Preserve the existing repo-refresh path as a fallback mode while making target-aware retrieval the main UX.

**Tech Stack:** Node.js ESM, existing PMC retrieval engine, node:test, existing CLI wrappers

---

## File Structure

**Create:**
- `tools/project-memory-context/src/retrieval/target-resolver.mjs` — resolves `symbol|file|query` targets from user input
- `tools/project-memory-context/src/retrieval/context-renderer-v1.mjs` — compact text renderer for target-aware context

**Modify:**
- `tools/project-memory-context/cli/context.mjs` — parse target-aware args and dispatch retrieval mode
- `tools/project-memory-context/tests/context-cli.test.mjs` — new CLI-level target-aware tests
- `tools/project-memory-context/tests/query-engine.test.mjs` or equivalent retrieval tests if needed
- `tools/project-memory-context/templates/opencode/commands/get-context.md` — update command contract
- `tools/project-memory-context/templates/claude-code/CLAUDE.md.snippet` — align `/get-context` usage text
- `tools/project-memory-context/templates/cursor/.cursorrules.snippet` — align `/get-context` usage text

---

### Task 1: Add Target Resolver

**Files:**
- Create: `tools/project-memory-context/src/retrieval/target-resolver.mjs`
- Test: `tools/project-memory-context/tests/context-cli.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget } from '../src/retrieval/target-resolver.mjs';

function mockEngine() {
  return {
    findSymbolKeyByName(name) {
      if (name === 'UserService') return ['ts|src/user.ts|class|exported|UserService|0'];
      if (name === 'Session') return [
        'ts|src/a.ts|class|exported|Session|0',
        'ts|src/b.ts|class|exported|Session|0',
      ];
      return [];
    },
    findSymbolKeysByFilePath(filePath) {
      if (filePath === 'src/auth.ts') return ['ts|src/auth.ts|function|exported|login|1'];
      return [];
    },
  };
}

test('resolveTarget auto-detects file targets', () => {
  const result = resolveTarget({ engine: mockEngine(), target: 'src/auth.ts' });
  assert.equal(result.mode, 'file');
  assert.equal(result.value, 'src/auth.ts');
});

test('resolveTarget auto-detects symbol targets', () => {
  const result = resolveTarget({ engine: mockEngine(), target: 'UserService' });
  assert.equal(result.mode, 'symbol');
  assert.equal(result.symbolKeys.length, 1);
});

test('resolveTarget returns ambiguous symbol candidates when needed', () => {
  const result = resolveTarget({ engine: mockEngine(), target: 'Session' });
  assert.equal(result.mode, 'symbol-ambiguous');
  assert.equal(result.symbolKeys.length, 2);
});

test('resolveTarget falls back to query mode', () => {
  const result = resolveTarget({ engine: mockEngine(), target: 'login flow' });
  assert.equal(result.mode, 'query');
  assert.equal(result.value, 'login flow');
});

test('resolveTarget respects explicit override', () => {
  const result = resolveTarget({ engine: mockEngine(), explicitMode: 'query', target: 'UserService' });
  assert.equal(result.mode, 'query');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tools/project-memory-context && node --test tests/context-cli.test.mjs`
Expected: FAIL with module-not-found for `target-resolver.mjs`

- [ ] **Step 3: Write the minimal implementation**

```js
function normalizePath(value) {
  return String(value ?? '').replace(/\\/g, '/');
}

export function resolveTarget({ engine, explicitMode = null, target }) {
  const value = String(target ?? '').trim();
  if (!value) return { mode: 'empty', value: '' };

  if (explicitMode === 'query') return { mode: 'query', value };
  if (explicitMode === 'file') return { mode: 'file', value: normalizePath(value) };
  if (explicitMode === 'symbol') {
    const symbolKeys = engine.findSymbolKeyByName(value);
    return symbolKeys.length === 1
      ? { mode: 'symbol', value, symbolKeys }
      : { mode: 'symbol-ambiguous', value, symbolKeys };
  }

  const normalized = normalizePath(value);
  const fileMatches = engine.findSymbolKeysByFilePath(normalized);
  if (fileMatches.length > 0 || normalized.includes('/')) {
    return { mode: 'file', value: normalized, symbolKeys: fileMatches };
  }

  const symbolKeys = engine.findSymbolKeyByName(value);
  if (symbolKeys.length === 1) return { mode: 'symbol', value, symbolKeys };
  if (symbolKeys.length > 1) return { mode: 'symbol-ambiguous', value, symbolKeys };

  return { mode: 'query', value };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tools/project-memory-context && node --test tests/context-cli.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/project-memory-context/src/retrieval/target-resolver.mjs tools/project-memory-context/tests/context-cli.test.mjs
git commit -m "feat(pmc): add target resolver for context retrieval"
```

---

### Task 2: Add Target-Aware Renderer

**Files:**
- Create: `tools/project-memory-context/src/retrieval/context-renderer-v1.mjs`
- Test: `tools/project-memory-context/tests/context-cli.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTargetContext } from '../src/retrieval/context-renderer-v1.mjs';

test('renderTargetContext renders stable sections', () => {
  const output = renderTargetContext({
    summary: ['UserService orchestrates auth state.'],
    target: { mode: 'symbol', name: 'UserService', filePath: 'src/user.ts' },
    relevant: [{ label: 'AuthClient', filePath: 'src/auth-client.ts' }],
    relations: [{ kind: 'dependencies', items: ['AuthClient'] }],
    nextReads: ['src/user.ts', 'src/auth-client.ts'],
    metadata: { depth: 'extended', focus: 'dependencies' },
  });

  assert.match(output, /Summary/);
  assert.match(output, /Target/);
  assert.match(output, /Relevant/);
  assert.match(output, /Relations/);
  assert.match(output, /Next Reads/);
  assert.match(output, /Metadata/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tools/project-memory-context && node --test tests/context-cli.test.mjs`
Expected: FAIL with module-not-found for `context-renderer-v1.mjs`

- [ ] **Step 3: Write the minimal implementation**

```js
function bullet(lines = []) {
  return lines.map((line) => `- ${line}`).join('\n');
}

export function renderTargetContext({ summary, target, relevant, relations, nextReads, metadata }) {
  const parts = [];
  parts.push('Summary');
  parts.push(bullet(summary));
  parts.push('');
  parts.push('Target');
  parts.push(bullet([
    `mode: ${target.mode}`,
    target.name ? `name: ${target.name}` : `value: ${target.value}`,
    ...(target.filePath ? [`file: ${target.filePath}`] : []),
  ]));
  parts.push('');
  parts.push('Relevant');
  parts.push(bullet(relevant.map((item) => item.filePath ? `${item.label} (${item.filePath})` : item.label)) || '- none');
  parts.push('');
  parts.push('Relations');
  parts.push(bullet(relations.flatMap((group) => group.items.map((item) => `${group.kind}: ${item}`))));
  parts.push('');
  parts.push('Next Reads');
  parts.push(bullet(nextReads));
  parts.push('');
  parts.push('Metadata');
  parts.push(bullet([`depth: ${metadata.depth}`, `focus: ${metadata.focus}`]));
  return parts.join('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tools/project-memory-context && node --test tests/context-cli.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/project-memory-context/src/retrieval/context-renderer-v1.mjs tools/project-memory-context/tests/context-cli.test.mjs
git commit -m "feat(pmc): add target-aware context renderer"
```

---

### Task 3: Make `pmc context` Target-Aware

**Files:**
- Modify: `tools/project-memory-context/cli/context.mjs`
- Test: `tools/project-memory-context/tests/context-cli.test.mjs`

- [ ] **Step 1: Write the failing CLI tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

test('pmc context --help shows target-aware usage', async () => {
  const cli = resolve(process.cwd(), 'cli', 'context.mjs');
  const result = await runCli(cli, ['--help']);
  assert.match(result.stdout, /pmc context <target> \[depth\] \[focus\]/i);
  assert.match(result.stdout, /symbol\|file\|query/i);
});

test('pmc context symbol UserService renders target-aware output', async () => {
  // fixture project with graph, symbol-index, worklist
  // spawn CLI against it
  // assert sections: Summary, Target, Relations
});

test('pmc context shows ambiguity for multiple symbol matches', async () => {
  // fixture with duplicate symbol name in two files
  // assert output contains candidate list
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tools/project-memory-context && node --test tests/context-cli.test.mjs`
Expected: FAIL because `cli/context.mjs` only proxies refresh behavior today

- [ ] **Step 3: Write the minimal implementation**

Implement in `cli/context.mjs`:
- parse modes:
  - auto: `pmc context <target> [depth] [focus]`
  - explicit: `pmc context symbol <target> [depth] [focus]`
- load artifacts from `.planning/project-memory-context/graph/graph.json`, `symbol-index.json`, `worklist.json`
- build `createQueryEngine(...)`
- call `resolveTarget(...)`
- dispatch:
  - `querySymbolContext()`
  - `queryFileContext()`
  - `queryImpactScope()`
- render via `renderTargetContext(...)`
- preserve old repo-refresh behavior behind an explicit path:
  - `pmc context . --refresh`

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tools/project-memory-context && node --test tests/context-cli.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/project-memory-context/cli/context.mjs tools/project-memory-context/tests/context-cli.test.mjs
git commit -m "feat(pmc): make pmc context target-aware"
```

---

### Task 4: Update Command Templates And Guidance

**Files:**
- Modify: `tools/project-memory-context/templates/opencode/commands/get-context.md`
- Modify: `tools/project-memory-context/templates/claude-code/CLAUDE.md.snippet`
- Modify: `tools/project-memory-context/templates/cursor/.cursorrules.snippet`
- Test: `tools/project-memory-context/tests/init.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
test('get-context command template mentions target-aware usage', async () => {
  const text = await readFile(join(packageRoot, 'templates', 'opencode', 'commands', 'get-context.md'), 'utf8');
  assert.match(text, /pmc context <target>/i);
  assert.match(text, /symbol\|file\|query/i);
});

test('Claude and Cursor snippets mention target-aware get-context', async () => {
  const claude = await readFile(join(packageRoot, 'templates', 'claude-code', 'CLAUDE.md.snippet'), 'utf8');
  const cursor = await readFile(join(packageRoot, 'templates', 'cursor', '.cursorrules.snippet'), 'utf8');
  assert.match(claude, /\/get-context <target>/);
  assert.match(cursor, /\/get-context <target>/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd tools/project-memory-context && node --test tests/init.test.mjs`
Expected: FAIL because templates currently describe repo refresh wording

- [ ] **Step 3: Write the minimal implementation**

Update:
- `get-context.md` to describe:
  - auto mode
  - explicit `symbol|file|query` overrides
  - `depth` and `focus`
- Claude/Cursor snippets to say:
  - use `/get-context <target>` for structural deep-dive
  - examples: symbol, file, query

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd tools/project-memory-context && node --test tests/init.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/project-memory-context/templates/opencode/commands/get-context.md tools/project-memory-context/templates/claude-code/CLAUDE.md.snippet tools/project-memory-context/templates/cursor/.cursorrules.snippet tools/project-memory-context/tests/init.test.mjs
git commit -m "docs(pmc): update get-context templates for target-aware retrieval"
```

---

### Task 5: Full Verification

**Files:**
- Verify only

- [ ] **Step 1: Run focused context tests**

Run: `cd tools/project-memory-context && node --test tests/context-cli.test.mjs`
Expected: PASS

- [ ] **Step 2: Run package test suite**

Run: `cd tools/project-memory-context && node --test tests/*.test.mjs`
Expected: PASS with no regressions

- [ ] **Step 3: Smoke test target-aware CLI**

Run:

```powershell
node cli/context.mjs --help
node cli/context.mjs UserService compact dependencies
node cli/context.mjs file src/auth.ts extended callers
```

Expected:
- help shows target-aware syntax
- command prints stable sections
- ambiguity or no-match cases are clear and non-crashing

---

## Self-Review

**Spec coverage:**
- auto-resolve + override: Task 1 + Task 3
- balanceado output: Task 2 + Task 3
- templates aligned: Task 4
- verification: Task 5

**Placeholder scan:**
- no TODO/TBD placeholders left
- commands and files are explicit

**Type consistency:**
- `resolveTarget()` returns stable mode objects
- `renderTargetContext()` consumes one normalized shape
- `cli/context.mjs` remains the only CLI entrypoint for `/get-context`
