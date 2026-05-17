# Project Memory Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first executable slice of the project-memory-context workflow: persisted intake artifacts, deterministic symbol extraction for `JS/TS + .NET`, symbol index generation, and workflow docs for Stage A and Stage B.

**Architecture:** Keep the workflow definition in root markdown command files and keep deterministic support logic in small Node ESM utilities under `tools/project-memory-context/`. Persist all run state under `.planning/project-memory-context/`, and treat `agent-memory` + `graphify` as runtime integrations invoked by the workflow rather than embedded directly in the helper scripts.

**Tech Stack:** Markdown command/workflow files, Node.js ESM (`.mjs`), built-in `node:test`, filesystem JSON artifacts.

---

### Task 1: Persisted Artifact Foundation

**Files:**
- Create: `tools/project-memory-context/src/artifacts.mjs`
- Create: `tools/project-memory-context/src/intake-context.mjs`
- Create: `tools/project-memory-context/cli/save-intake-context.mjs`
- Test: `tools/project-memory-context/tests/artifacts.test.mjs`

- [ ] **Step 1: Write the failing artifact tests**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ensureProjectMemoryContextDirs,
  writeJsonArtifact,
  readJsonArtifact,
} from '../src/artifacts.mjs';
import { buildIntakeContext } from '../src/intake-context.mjs';

test('ensureProjectMemoryContextDirs creates expected directory tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-artifacts-'));
  const dirs = await ensureProjectMemoryContextDirs(root);

  assert.equal(dirs.base.endsWith('project-memory-context'), true);
  assert.equal(dirs.intake.endsWith('intake'), true);
  assert.equal(dirs.graph.endsWith('graph'), true);
  assert.equal(dirs.enrichment.endsWith('enrichment'), true);
  assert.equal(dirs.runs.endsWith('runs'), true);
});

test('writeJsonArtifact persists readable JSON payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-json-'));
  const dirs = await ensureProjectMemoryContextDirs(root);
  const file = join(dirs.intake, 'latest-context.json');

  await writeJsonArtifact(file, { project: 'demo', goals: ['map'] });

  const parsed = await readJsonArtifact(file);
  assert.deepEqual(parsed, { project: 'demo', goals: ['map'] });
});

test('buildIntakeContext normalizes project description and goals', () => {
  const intake = buildIntakeContext({
    projectDescription: ' Existing billing platform ',
    mappingGoals: [' architecture ', ' memory context '],
    focusAreas: ['api', 'domain'],
  });

  assert.equal(intake.projectDescription, 'Existing billing platform');
  assert.deepEqual(intake.mappingGoals, ['architecture', 'memory context']);
  assert.deepEqual(intake.focusAreas, ['api', 'domain']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/project-memory-context/tests/artifacts.test.mjs`
Expected: FAIL with module-not-found errors for the new helper files.

- [ ] **Step 3: Write minimal implementation**

```javascript
// artifacts.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function ensureProjectMemoryContextDirs(projectRoot) {
  const base = join(projectRoot, '.planning', 'project-memory-context');
  const dirs = {
    base,
    intake: join(base, 'intake'),
    graph: join(base, 'graph'),
    enrichment: join(base, 'enrichment'),
    runs: join(base, 'runs'),
  };
  await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));
  return dirs;
}

export async function writeJsonArtifact(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readJsonArtifact(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw error;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/project-memory-context/tests/artifacts.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/project-memory-context/src/artifacts.mjs tools/project-memory-context/src/intake-context.mjs tools/project-memory-context/cli/save-intake-context.mjs tools/project-memory-context/tests/artifacts.test.mjs
git commit -m "feat: add project memory context artifacts foundation"
```

### Task 2: Stable Symbol Keys

**Files:**
- Create: `tools/project-memory-context/src/symbol-keys.mjs`
- Test: `tools/project-memory-context/tests/symbol-keys.test.mjs`

- [ ] **Step 1: Write the failing symbol key tests**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSymbolKey } from '../src/symbol-keys.mjs';

test('buildSymbolKey creates stable TypeScript keys', () => {
  const key = buildSymbolKey({
    language: 'ts',
    filePath: 'src/services/user.ts',
    kind: 'function',
    exportScope: 'exported',
    name: 'getUser',
    arity: 2,
  });

  assert.equal(key, 'ts|src/services/user.ts|function|exported|getUser|2');
});

test('buildSymbolKey creates stable C# keys', () => {
  const key = buildSymbolKey({
    language: 'csharp',
    filePath: 'Services/UserService.cs',
    namespace: 'MyApp.Services',
    containerName: 'UserService',
    kind: 'method',
    name: 'GetUserAsync',
    signature: '(Guid,CancellationToken)',
  });

  assert.equal(
    key,
    'csharp|Services/UserService.cs|MyApp.Services|UserService|method|GetUserAsync|(Guid,CancellationToken)',
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/project-memory-context/tests/symbol-keys.test.mjs`
Expected: FAIL with module-not-found errors.

- [ ] **Step 3: Write minimal implementation**

```javascript
export function buildSymbolKey(symbol) {
  if (symbol.language === 'csharp') {
    return [
      'csharp',
      symbol.filePath,
      symbol.namespace ?? 'global',
      symbol.containerName ?? 'none',
      symbol.kind,
      symbol.name,
      symbol.signature ?? '()',
    ].join('|');
  }

  return [
    symbol.language,
    symbol.filePath,
    symbol.kind,
    symbol.exportScope ?? 'local',
    symbol.name,
    String(symbol.arity ?? 0),
  ].join('|');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/project-memory-context/tests/symbol-keys.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/project-memory-context/src/symbol-keys.mjs tools/project-memory-context/tests/symbol-keys.test.mjs
git commit -m "feat: add stable symbol key generation"
```

### Task 3: Minimal Symbol Extraction for JS/TS + C#

**Files:**
- Create: `tools/project-memory-context/src/symbol-extractor.mjs`
- Create: `tools/project-memory-context/cli/build-worklist.mjs`
- Test: `tools/project-memory-context/tests/symbol-extractor.test.mjs`

- [ ] **Step 1: Write the failing extractor tests**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';

import { extractTopLevelSymbols } from '../src/symbol-extractor.mjs';

test('extractTopLevelSymbols finds exported TypeScript contracts and functions', () => {
  const code = `
export interface User {
  id: string;
}

export function getUser(id: string, includePosts: boolean) {
  return { id, includePosts };
}
`;

  const symbols = extractTopLevelSymbols({ filePath: 'src/user.ts', content: code });
  assert.deepEqual(
    symbols.map((symbol) => [symbol.kind, symbol.name, symbol.language]),
    [
      ['interface', 'User', 'ts'],
      ['function', 'getUser', 'ts'],
    ],
  );
});

test('extractTopLevelSymbols finds csharp public types and methods', () => {
  const code = `
namespace MyApp.Services;

public record User(Guid Id);

public class UserService {
  public Task<User> GetUserAsync(Guid id, CancellationToken token) {
    throw new NotImplementedException();
  }
}
`;

  const symbols = extractTopLevelSymbols({ filePath: 'Services/UserService.cs', content: code });
  assert.deepEqual(
    symbols.map((symbol) => [symbol.kind, symbol.name, symbol.language]),
    [
      ['record', 'User', 'csharp'],
      ['class', 'UserService', 'csharp'],
      ['method', 'GetUserAsync', 'csharp'],
    ],
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/project-memory-context/tests/symbol-extractor.test.mjs`
Expected: FAIL with module-not-found errors.

- [ ] **Step 3: Write minimal implementation**

```javascript
export function extractTopLevelSymbols({ filePath, content }) {
  if (filePath.endsWith('.cs')) return extractCSharpSymbols(filePath, content);
  return extractTypeScriptSymbols(filePath, content);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/project-memory-context/tests/symbol-extractor.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/project-memory-context/src/symbol-extractor.mjs tools/project-memory-context/cli/build-worklist.mjs tools/project-memory-context/tests/symbol-extractor.test.mjs
git commit -m "feat: add initial js-ts-and-csharp symbol extraction"
```

### Task 4: Workflow Files and Run Metadata

**Files:**
- Create: `project-memory-context.md`
- Create: `project-memory-context workflow.md`
- Modify: `docs/superpowers/specs/2026-05-15-project-memory-context-design.md`
- Test: `tools/project-memory-context/tests/worklist.test.mjs`

- [ ] **Step 1: Write the failing worklist test**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEnrichmentWorklist } from '../src/symbol-extractor.mjs';

test('buildEnrichmentWorklist marks known symbols as enriched when hashes match', () => {
  const worklist = buildEnrichmentWorklist({
    symbols: [
      {
        symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
        codeHash: 'hash-a',
      },
    ],
    symbolIndex: {
      'ts|src/user.ts|function|exported|getUser|1': {
        memoryId: 'mem_1',
        codeHash: 'hash-a',
      },
    },
  });

  assert.equal(worklist[0].status, 'enriched');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/project-memory-context/tests/worklist.test.mjs`
Expected: FAIL because `buildEnrichmentWorklist` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```javascript
export function buildEnrichmentWorklist({ symbols, symbolIndex }) {
  return symbols.map((symbol) => {
    const prior = symbolIndex[symbol.symbolKey];
    const status = prior && prior.codeHash === symbol.codeHash ? 'enriched' : 'pending';
    return { ...symbol, status, memoryId: prior?.memoryId ?? null };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/project-memory-context/tests/worklist.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add project-memory-context.md "project-memory-context workflow.md" tools/project-memory-context/tests/worklist.test.mjs tools/project-memory-context/src/symbol-extractor.mjs
git commit -m "feat: add resumable project memory context workflow shell"
```
