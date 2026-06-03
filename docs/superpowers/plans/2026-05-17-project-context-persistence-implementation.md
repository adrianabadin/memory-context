# Project Context Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a brownfield-first project-context pipeline that detects repo context, captures declared context, materializes 9 canonical project-context memories, writes local JSON/Markdown artifacts, and keeps current state synchronized for per-project semantic recall.

**Architecture:** Add a new `project-context` subsystem under `tools/project-memory-context/src/` built around three layers: source artifacts (`detected/`, `declared/`), materialized memories (`materialized/` + `markdown/`), and refresh state (`state/`). Keep transforms pure where possible, let CLI orchestrate file IO, and reuse existing artifact helpers and Node-native testing patterns already used in this package.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert/strict`, existing PMC artifact helpers, `graphify` artifacts, local per-project `agent-memory` config.

---

### Task 1: Extend Artifact Directory Support

**Files:**
- Modify: `tools/project-memory-context/src/artifacts.mjs`
- Test: `tools/project-memory-context/tests/artifacts.test.mjs`

- [ ] **Step 1: Write the failing test**

Add assertions to `tools/project-memory-context/tests/artifacts.test.mjs` that `ensureProjectMemoryContextDirs()` returns these new directories:

```js
assert.equal(dirs.projectContext, join(tmpRoot, '.planning', 'project-memory-context', 'project-context'));
assert.equal(dirs.projectContextDetected, join(dirs.projectContext, 'detected'));
assert.equal(dirs.projectContextDeclared, join(dirs.projectContext, 'declared'));
assert.equal(dirs.projectContextMaterialized, join(dirs.projectContext, 'materialized'));
assert.equal(dirs.projectContextMarkdown, join(dirs.projectContext, 'markdown'));
assert.equal(dirs.projectContextState, join(dirs.projectContext, 'state'));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/project-memory-context/tests/artifacts.test.mjs`
Expected: FAIL because the returned `dirs` object does not include the new project-context directories.

- [ ] **Step 3: Write minimal implementation**

Update `tools/project-memory-context/src/artifacts.mjs` so `ensureProjectMemoryContextDirs()` returns and creates:

```js
const projectContext = join(base, 'project-context');
const dirs = {
  base,
  intake: join(base, 'intake'),
  graph: join(base, 'graph'),
  enrichment: join(base, 'enrichment'),
  runs: join(base, 'runs'),
  projectContext,
  projectContextDetected: join(projectContext, 'detected'),
  projectContextDeclared: join(projectContext, 'declared'),
  projectContextMaterialized: join(projectContext, 'materialized'),
  projectContextMarkdown: join(projectContext, 'markdown'),
  projectContextState: join(projectContext, 'state'),
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/project-memory-context/tests/artifacts.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Skip commit in this workspace because it is not a git repository.

### Task 2: Add Project-Context Schema and Stable Keys

**Files:**
- Create: `tools/project-memory-context/src/project-context-schema.mjs`
- Create: `tools/project-memory-context/tests/project-context-schema.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tools/project-memory-context/tests/project-context-schema.test.mjs` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROJECT_CONTEXT_KINDS,
  buildProjectContextMemoryKey,
  createMaterializedProjectContext,
} from '../src/project-context-schema.mjs';

test('buildProjectContextMemoryKey creates stable keys', () => {
  assert.equal(buildProjectContextMemoryKey('stack-runtime'), 'project-context:stack-runtime');
});

test('PROJECT_CONTEXT_KINDS lists all 9 base memories', () => {
  assert.deepEqual(PROJECT_CONTEXT_KINDS, [
    'stack-runtime',
    'dependencies-summary',
    'integrations-summary',
    'architecture-current',
    'architecture-target',
    'structure-summary',
    'technical-rules',
    'project-requirements',
    'known-issues-and-fixes',
  ]);
});

test('createMaterializedProjectContext fills required fields', () => {
  const result = createMaterializedProjectContext({
    kind: 'technical-rules',
    title: 'Technical rules',
    summary: 'Follow existing structure and conventions.',
    body: '- Prefer focused edits.\n- Keep files in existing module boundaries.',
    tags: ['project-context', 'rules', 'project:demo'],
    sourceFiles: ['README.md'],
    graphRefs: [],
    sourceMode: 'merged',
    confidence: 'high',
    detectedSources: ['detected-rules.json'],
    declaredSources: ['technical-rules.json'],
    updatedAt: '2026-05-17T00:00:00.000Z',
  });

  assert.equal(result.memory_key, 'project-context:technical-rules');
  assert.equal(result.kind, 'technical-rules');
  assert.equal(result.source_mode, 'merged');
  assert.equal(result.confidence, 'high');
  assert.match(result.content_hash, /^[a-f0-9]{64}$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/project-memory-context/tests/project-context-schema.test.mjs`
Expected: FAIL with module not found.

- [ ] **Step 3: Write minimal implementation**

Create `tools/project-memory-context/src/project-context-schema.mjs` exporting:

```js
import { createHash } from 'node:crypto';

export const PROJECT_CONTEXT_KINDS = [
  'stack-runtime',
  'dependencies-summary',
  'integrations-summary',
  'architecture-current',
  'architecture-target',
  'structure-summary',
  'technical-rules',
  'project-requirements',
  'known-issues-and-fixes',
];

export function buildProjectContextMemoryKey(kind) {
  if (!PROJECT_CONTEXT_KINDS.includes(kind)) {
    throw new Error(`Unknown project context kind: ${kind}`);
  }
  return `project-context:${kind}`;
}

export function hashProjectContextContent(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function createMaterializedProjectContext({
  kind,
  title,
  summary,
  body,
  tags,
  sourceFiles,
  graphRefs,
  sourceMode,
  confidence,
  detectedSources = [],
  declaredSources = [],
  updatedAt,
}) {
  const contentShape = { title, summary, body, tags, sourceFiles, graphRefs, sourceMode, confidence, detectedSources, declaredSources };
  return {
    memory_key: buildProjectContextMemoryKey(kind),
    title,
    kind,
    source_mode: sourceMode,
    summary,
    body,
    tags,
    source_files: sourceFiles,
    graph_refs: graphRefs,
    detected_sources: detectedSources,
    declared_sources: declaredSources,
    confidence,
    content_hash: hashProjectContextContent(contentShape),
    updated_at: updatedAt,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/project-memory-context/tests/project-context-schema.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Skip commit in this workspace because it is not a git repository.

### Task 3: Add Refresh State Utilities

**Files:**
- Create: `tools/project-memory-context/src/refresh-state.mjs`
- Create: `tools/project-memory-context/tests/refresh-state.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tools/project-memory-context/tests/refresh-state.test.mjs` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEmptyRefreshState,
  updateRefreshStateEntry,
  shouldRefreshProjectContext,
} from '../src/refresh-state.mjs';

test('createEmptyRefreshState returns empty tracked files and memories', () => {
  assert.deepEqual(createEmptyRefreshState(), {
    trackedFiles: {},
    memoryHashes: {},
    updatedAt: null,
  });
});

test('updateRefreshStateEntry stores file hash', () => {
  const state = updateRefreshStateEntry(createEmptyRefreshState(), 'package.json', 'abc');
  assert.equal(state.trackedFiles['package.json'], 'abc');
});

test('shouldRefreshProjectContext returns true when hash changes', () => {
  const state = updateRefreshStateEntry(createEmptyRefreshState(), 'package.json', 'abc');
  assert.equal(shouldRefreshProjectContext(state, 'package.json', 'xyz'), true);
  assert.equal(shouldRefreshProjectContext(state, 'package.json', 'abc'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/project-memory-context/tests/refresh-state.test.mjs`
Expected: FAIL with module not found.

- [ ] **Step 3: Write minimal implementation**

Create `tools/project-memory-context/src/refresh-state.mjs` with:

```js
export function createEmptyRefreshState() {
  return {
    trackedFiles: {},
    memoryHashes: {},
    updatedAt: null,
  };
}

export function updateRefreshStateEntry(state, filePath, hash) {
  return {
    ...state,
    trackedFiles: {
      ...state.trackedFiles,
      [filePath]: hash,
    },
  };
}

export function shouldRefreshProjectContext(state, filePath, nextHash) {
  return state.trackedFiles[filePath] !== nextHash;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/project-memory-context/tests/refresh-state.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Skip commit in this workspace because it is not a git repository.

### Task 4: Implement Detected Stack, Dependency, and Integration Extraction

**Files:**
- Create: `tools/project-memory-context/src/extractors/stack-extractor.mjs`
- Create: `tools/project-memory-context/tests/stack-extractor.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tools/project-memory-context/tests/stack-extractor.test.mjs` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectStackContext } from '../src/extractors/stack-extractor.mjs';

test('detectStackContext reads package.json and tsconfig.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-stack-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'demo',
    packageManager: 'npm@10.8.0',
    dependencies: { react: '^19.0.0', next: '^15.0.0', zod: '^3.24.0' },
    devDependencies: { typescript: '^5.0.0', vitest: '^2.0.0' },
  }), 'utf8');
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022' } }), 'utf8');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'db.ts'), "import { createClient } from '@supabase/supabase-js';\n", 'utf8');

  const result = await detectStackContext(root);

  assert.equal(result.languages.includes('typescript'), true);
  assert.equal(result.packageManagers[0], 'npm@10.8.0');
  assert.equal(result.frameworks.includes('next'), true);
  assert.equal(result.dependenciesSummary.critical.includes('react'), true);
  assert.equal(result.integrations.detectedServices.includes('supabase'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/project-memory-context/tests/stack-extractor.test.mjs`
Expected: FAIL with module not found.

- [ ] **Step 3: Write minimal implementation**

Create `tools/project-memory-context/src/extractors/stack-extractor.mjs` that:

```js
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function detectServicesFromSrc(projectRoot) {
  const detected = new Set();
  try {
    const entries = await readdir(join(projectRoot, 'src'), { recursive: true });
    for (const entry of entries) {
      if (typeof entry !== 'string') continue;
      if (!entry.endsWith('.js') && !entry.endsWith('.mjs') && !entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
      const content = await readFile(join(projectRoot, 'src', entry), 'utf8');
      if (content.includes('@supabase/supabase-js')) detected.add('supabase');
      if (content.includes('stripe')) detected.add('stripe');
      if (content.includes('aws-sdk') || content.includes('@aws-sdk/')) detected.add('aws');
    }
  } catch {}
  return [...detected].sort();
}

export async function detectStackContext(projectRoot) {
  const packageJson = await readJson(join(projectRoot, 'package.json'));
  const tsconfig = await readJson(join(projectRoot, 'tsconfig.json'));
  const deps = packageJson?.dependencies ?? {};
  const devDeps = packageJson?.devDependencies ?? {};
  const allDeps = { ...deps, ...devDeps };
  return {
    languages: tsconfig ? ['typescript'] : [],
    runtimes: ['node'],
    frameworks: ['next', 'react'].filter((name) => name in allDeps),
    packageManagers: packageJson?.packageManager ? [packageJson.packageManager] : [],
    buildTools: ['typescript'].filter((name) => name in allDeps),
    dependenciesSummary: {
      critical: Object.keys(deps).filter((name) => ['react', 'next', 'zod'].includes(name)),
      testing: Object.keys(devDeps).filter((name) => ['vitest', 'jest'].includes(name)),
    },
    integrations: {
      detectedServices: await detectServicesFromSrc(projectRoot),
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/project-memory-context/tests/stack-extractor.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Skip commit in this workspace because it is not a git repository.

### Task 5: Implement Detected Structure Extraction

**Files:**
- Create: `tools/project-memory-context/src/extractors/structure-extractor.mjs`
- Create: `tools/project-memory-context/tests/structure-extractor.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tools/project-memory-context/tests/structure-extractor.test.mjs` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectStructureContext } from '../src/extractors/structure-extractor.mjs';

test('detectStructureContext captures root directories and key subtrees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-structure-'));
  await mkdir(join(root, 'src', 'services'), { recursive: true });
  await mkdir(join(root, 'src', 'components'), { recursive: true });
  await mkdir(join(root, 'tests'), { recursive: true });
  await writeFile(join(root, 'src', 'main.ts'), 'export {}\n', 'utf8');

  const result = await detectStructureContext(root);

  assert.deepEqual(result.rootDirectories.sort(), ['src', 'tests']);
  assert.equal(result.entryPoints.includes('src/main.ts'), true);
  assert.equal(result.keySubtrees.includes('src/services'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/project-memory-context/tests/structure-extractor.test.mjs`
Expected: FAIL with module not found.

- [ ] **Step 3: Write minimal implementation**

Create `tools/project-memory-context/src/extractors/structure-extractor.mjs` with:

```js
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

async function listDirectories(dir, root, depth = 0, maxDepth = 2, acc = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.planning') continue;
    const full = join(dir, entry.name);
    const rel = relative(root, full).replace(/\\/g, '/');
    acc.push({ rel, depth });
    if (depth < maxDepth - 1) {
      await listDirectories(full, root, depth + 1, maxDepth, acc);
    }
  }
  return acc;
}

export async function detectStructureContext(projectRoot) {
  const dirs = await listDirectories(projectRoot, projectRoot);
  const rootDirectories = dirs.filter((item) => item.depth === 0).map((item) => item.rel);
  const keySubtrees = dirs.filter((item) => item.depth > 0).map((item) => item.rel);
  const entryPoints = [];
  for (const rel of ['src/main.ts', 'src/index.ts', 'src/app.ts', 'src/server.ts']) {
    try {
      await readdir(join(projectRoot, rel, '..'));
      entryPoints.push(rel);
    } catch {}
  }
  return { rootDirectories, keySubtrees, entryPoints };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/project-memory-context/tests/structure-extractor.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Skip commit in this workspace because it is not a git repository.

### Task 6: Implement Detected Architecture and Rules Extraction

**Files:**
- Create: `tools/project-memory-context/src/extractors/architecture-extractor.mjs`
- Create: `tools/project-memory-context/src/extractors/rules-extractor.mjs`
- Create: `tools/project-memory-context/tests/architecture-extractor.test.mjs`
- Create: `tools/project-memory-context/tests/rules-extractor.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `tools/project-memory-context/tests/architecture-extractor.test.mjs` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { detectArchitectureContext } from '../src/extractors/architecture-extractor.mjs';

test('detectArchitectureContext extracts node paths from graph', async () => {
  const graph = {
    nodes: [
      { id: '1', label: 'src/main.ts' },
      { id: '2', label: 'src/services/user.ts' },
    ],
    edges: [],
  };

  const result = await detectArchitectureContext({ graph });

  assert.deepEqual(result.entryPoints, ['src/main.ts']);
  assert.equal(result.graphRefs.includes('node:src/services/user.ts'), true);
});
```

Create `tools/project-memory-context/tests/rules-extractor.test.mjs` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { detectRulesContext } from '../src/extractors/rules-extractor.mjs';

test('detectRulesContext extracts rules from readme text', async () => {
  const result = await detectRulesContext({
    readmeText: 'Use pnpm. Avoid editing generated files. Keep domain logic in src/domain.',
  });

  assert.equal(result.rules.includes('Use pnpm.'), true);
  assert.equal(result.rules.includes('Avoid editing generated files.'), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tools/project-memory-context/tests/architecture-extractor.test.mjs tools/project-memory-context/tests/rules-extractor.test.mjs`
Expected: FAIL with missing modules.

- [ ] **Step 3: Write minimal implementations**

Create `tools/project-memory-context/src/extractors/architecture-extractor.mjs`:

```js
export async function detectArchitectureContext({ graph }) {
  const labels = (graph?.nodes ?? []).map((node) => String(node.label ?? node.id ?? ''));
  return {
    pattern: 'detected-structure',
    entryPoints: labels.filter((label) => /(?:^|\/)main\.[cm]?[jt]sx?$|(?:^|\/)app\.[cm]?[jt]sx?$/.test(label)),
    graphRefs: labels.map((label) => `node:${label}`),
  };
}
```

Create `tools/project-memory-context/src/extractors/rules-extractor.mjs`:

```js
export async function detectRulesContext({ readmeText = '' }) {
  const rules = [];
  for (const sentence of readmeText.split(/(?<=[.!?])\s+/)) {
    if (/^use\s/i.test(sentence) || /^avoid\s/i.test(sentence) || /^keep\s/i.test(sentence)) {
      rules.push(sentence.trim());
    }
  }
  return { rules };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tools/project-memory-context/tests/architecture-extractor.test.mjs tools/project-memory-context/tests/rules-extractor.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Skip commit in this workspace because it is not a git repository.

### Task 7: Implement Declared Context Templates and Guided Intake Defaults

**Files:**
- Create: `tools/project-memory-context/src/declared-intake.mjs`
- Create: `tools/project-memory-context/tests/declared-intake.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tools/project-memory-context/tests/declared-intake.test.mjs` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDeclaredProjectContextTemplates } from '../src/declared-intake.mjs';

test('createDeclaredProjectContextTemplates returns all declared files', () => {
  const result = createDeclaredProjectContextTemplates({
    architectureTarget: 'Layered architecture.',
    technicalRules: ['Keep services pure.'],
    projectRequirements: ['System tracks sessions.'],
    knownIssuesAndFixes: [],
  });

  assert.equal(result['architecture-target.json'].title, 'Target project architecture');
  assert.deepEqual(result['technical-rules.json'].rules, ['Keep services pure.']);
  assert.deepEqual(result['project-requirements.json'].requirements, ['System tracks sessions.']);
  assert.deepEqual(result['known-issues-and-fixes.json'].items, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/project-memory-context/tests/declared-intake.test.mjs`
Expected: FAIL with missing module.

- [ ] **Step 3: Write minimal implementation**

Create `tools/project-memory-context/src/declared-intake.mjs` with:

```js
export function createDeclaredProjectContextTemplates({
  architectureTarget = '',
  technicalRules = [],
  projectRequirements = [],
  knownIssuesAndFixes = [],
} = {}) {
  return {
    'architecture-target.json': {
      title: 'Target project architecture',
      architecture: architectureTarget,
    },
    'technical-rules.json': {
      title: 'Technical rules',
      rules: technicalRules,
    },
    'project-requirements.json': {
      title: 'Project requirements',
      requirements: projectRequirements,
    },
    'known-issues-and-fixes.json': {
      title: 'Known issues and fixes',
      items: knownIssuesAndFixes,
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/project-memory-context/tests/declared-intake.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Skip commit in this workspace because it is not a git repository.

### Task 8: Implement Materialization of the 9 Base Memories

**Files:**
- Create: `tools/project-memory-context/src/materializer.mjs`
- Create: `tools/project-memory-context/tests/materializer.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tools/project-memory-context/tests/materializer.test.mjs` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { materializeProjectContextMemories } from '../src/materializer.mjs';

test('materializeProjectContextMemories creates 9 materialized memories', () => {
  const result = materializeProjectContextMemories({
    projectSlug: 'demo',
    detected: {
      stack: { languages: ['typescript'], runtimes: ['node'], frameworks: ['next'], packageManagers: ['npm@10'], buildTools: ['typescript'], dependenciesSummary: { critical: ['next'] }, integrations: { detectedServices: ['supabase'] } },
      structure: { rootDirectories: ['src'], keySubtrees: ['src/services'], entryPoints: ['src/main.ts'] },
      architecture: { pattern: 'detected-structure', entryPoints: ['src/main.ts'], graphRefs: ['node:src/main.ts'] },
      rules: { rules: ['Use pnpm.'] },
    },
    declared: {
      architectureTarget: { architecture: 'Layered architecture.' },
      technicalRules: { rules: ['Keep services pure.'] },
      projectRequirements: { requirements: ['Track sessions.'] },
      knownIssuesAndFixes: { items: [{ symptom: 'Build fails', workaround: 'Reinstall deps.' }] },
    },
    updatedAt: '2026-05-17T00:00:00.000Z',
  });

  assert.equal(result.length, 9);
  assert.equal(result.find((item) => item.kind === 'stack-runtime').tags.includes('project:demo'), true);
  assert.equal(result.find((item) => item.kind === 'architecture-target').body.includes('Layered architecture.'), true);
  assert.equal(result.find((item) => item.kind === 'known-issues-and-fixes').body.includes('Build fails'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/project-memory-context/tests/materializer.test.mjs`
Expected: FAIL with missing module.

- [ ] **Step 3: Write minimal implementation**

Create `tools/project-memory-context/src/materializer.mjs` that imports `createMaterializedProjectContext` and returns one memory per kind with compact bodies:

```js
import { createMaterializedProjectContext } from './project-context-schema.mjs';

function formatList(label, values) {
  return values?.length ? `- ${label}: ${values.join(', ')}` : `- ${label}: Not detected`;
}

export function materializeProjectContextMemories({ projectSlug, detected, declared, updatedAt }) {
  const commonTags = ['project-context', `project:${projectSlug}`];

  return [
    createMaterializedProjectContext({
      kind: 'stack-runtime',
      title: 'Project stack and runtime',
      summary: `Languages: ${detected.stack.languages.join(', ')}. Frameworks: ${detected.stack.frameworks.join(', ')}.`,
      body: [
        formatList('Languages', detected.stack.languages),
        formatList('Runtimes', detected.stack.runtimes),
        formatList('Frameworks', detected.stack.frameworks),
        formatList('Package managers', detected.stack.packageManagers),
      ].join('\n'),
      tags: [...commonTags, 'stack'],
      sourceFiles: ['package.json', 'tsconfig.json'],
      graphRefs: [],
      sourceMode: 'detected',
      confidence: 'high',
      updatedAt,
    }),
    createMaterializedProjectContext({
      kind: 'dependencies-summary',
      title: 'Dependency summary',
      summary: `Critical dependencies: ${(detected.stack.dependenciesSummary.critical ?? []).join(', ') || 'none'}.`,
      body: [formatList('Critical', detected.stack.dependenciesSummary.critical), formatList('Testing', detected.stack.dependenciesSummary.testing)].join('\n'),
      tags: [...commonTags, 'dependencies'],
      sourceFiles: ['package.json'],
      graphRefs: [],
      sourceMode: 'detected',
      confidence: 'high',
      updatedAt,
    }),
    createMaterializedProjectContext({
      kind: 'integrations-summary',
      title: 'Integration summary',
      summary: `Detected services: ${(detected.stack.integrations.detectedServices ?? []).join(', ') || 'none'}.`,
      body: formatList('Services', detected.stack.integrations.detectedServices),
      tags: [...commonTags, 'integrations'],
      sourceFiles: ['src'],
      graphRefs: [],
      sourceMode: 'detected',
      confidence: 'medium',
      updatedAt,
    }),
    createMaterializedProjectContext({
      kind: 'architecture-current',
      title: 'Current architecture',
      summary: `Pattern: ${detected.architecture.pattern}. Entry points: ${(detected.architecture.entryPoints ?? []).join(', ') || 'none'}.`,
      body: [
        `- Pattern: ${detected.architecture.pattern}`,
        formatList('Entry points', detected.architecture.entryPoints),
      ].join('\n'),
      tags: [...commonTags, 'architecture', 'current-state'],
      sourceFiles: detected.architecture.entryPoints,
      graphRefs: detected.architecture.graphRefs,
      sourceMode: 'detected',
      confidence: 'medium',
      updatedAt,
    }),
    createMaterializedProjectContext({
      kind: 'architecture-target',
      title: 'Target architecture',
      summary: declared.architectureTarget.architecture || 'No target architecture declared.',
      body: declared.architectureTarget.architecture || 'No target architecture declared.',
      tags: [...commonTags, 'architecture', 'target-state'],
      sourceFiles: ['.planning/project-memory-context/project-context/declared/architecture-target.json'],
      graphRefs: [],
      sourceMode: 'declared',
      confidence: 'high',
      updatedAt,
    }),
    createMaterializedProjectContext({
      kind: 'structure-summary',
      title: 'Project structure summary',
      summary: `Root directories: ${(detected.structure.rootDirectories ?? []).join(', ') || 'none'}.`,
      body: [formatList('Root directories', detected.structure.rootDirectories), formatList('Key subtrees', detected.structure.keySubtrees), formatList('Entry points', detected.structure.entryPoints)].join('\n'),
      tags: [...commonTags, 'structure'],
      sourceFiles: detected.structure.entryPoints,
      graphRefs: [],
      sourceMode: 'detected',
      confidence: 'high',
      updatedAt,
    }),
    createMaterializedProjectContext({
      kind: 'technical-rules',
      title: 'Technical rules',
      summary: (declared.technicalRules.rules ?? detected.rules.rules ?? []).slice(0, 2).join(' '),
      body: [...(declared.technicalRules.rules ?? []), ...(detected.rules.rules ?? [])].map((line) => `- ${line}`).join('\n'),
      tags: [...commonTags, 'rules'],
      sourceFiles: ['README.md'],
      graphRefs: [],
      sourceMode: 'merged',
      confidence: 'medium',
      updatedAt,
    }),
    createMaterializedProjectContext({
      kind: 'project-requirements',
      title: 'Project requirements',
      summary: (declared.projectRequirements.requirements ?? []).slice(0, 2).join(' '),
      body: (declared.projectRequirements.requirements ?? []).map((line) => `- ${line}`).join('\n') || '- No declared requirements.',
      tags: [...commonTags, 'requirements'],
      sourceFiles: ['.planning/project-memory-context/project-context/declared/project-requirements.json'],
      graphRefs: [],
      sourceMode: 'declared',
      confidence: 'high',
      updatedAt,
    }),
    createMaterializedProjectContext({
      kind: 'known-issues-and-fixes',
      title: 'Known issues and fixes',
      summary: `${(declared.knownIssuesAndFixes.items ?? []).length} known issues recorded.`,
      body: (declared.knownIssuesAndFixes.items ?? []).map((item) => `- Symptom: ${item.symptom}; Workaround: ${item.workaround}`).join('\n') || '- No known issues recorded.',
      tags: [...commonTags, 'issues'],
      sourceFiles: ['.planning/project-memory-context/project-context/declared/known-issues-and-fixes.json'],
      graphRefs: [],
      sourceMode: 'declared',
      confidence: 'high',
      updatedAt,
    }),
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/project-memory-context/tests/materializer.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Skip commit in this workspace because it is not a git repository.

### Task 9: Render Materialized Memories to Markdown

**Files:**
- Create: `tools/project-memory-context/src/markdown-renderer.mjs`
- Create: `tools/project-memory-context/tests/markdown-renderer.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tools/project-memory-context/tests/markdown-renderer.test.mjs` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderProjectContextMarkdown } from '../src/markdown-renderer.mjs';

test('renderProjectContextMarkdown renders title, summary, body, and sources', () => {
  const markdown = renderProjectContextMarkdown({
    title: 'Technical rules',
    kind: 'technical-rules',
    summary: 'Follow existing module boundaries.',
    body: '- Keep files focused.\n- Avoid generated files.',
    source_files: ['README.md'],
    graph_refs: ['node:src/main.ts'],
    updated_at: '2026-05-17T00:00:00.000Z',
  });

  assert.match(markdown, /^# Technical rules/m);
  assert.match(markdown, /## Summary/);
  assert.match(markdown, /README.md/);
  assert.match(markdown, /node:src\/main.ts/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/project-memory-context/tests/markdown-renderer.test.mjs`
Expected: FAIL with missing module.

- [ ] **Step 3: Write minimal implementation**

Create `tools/project-memory-context/src/markdown-renderer.mjs` with:

```js
export function renderProjectContextMarkdown(memory) {
  const sourceFiles = (memory.source_files ?? []).map((file) => `- \`${file}\``).join('\n') || '- None';
  const graphRefs = (memory.graph_refs ?? []).map((ref) => `- \`${ref}\``).join('\n') || '- None';
  return [
    `# ${memory.title}`,
    '',
    `**Kind:** ${memory.kind}`,
    `**Updated:** ${memory.updated_at}`,
    '',
    '## Summary',
    '',
    memory.summary,
    '',
    '## Body',
    '',
    memory.body,
    '',
    '## Source Files',
    '',
    sourceFiles,
    '',
    '## Graph References',
    '',
    graphRefs,
    '',
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/project-memory-context/tests/markdown-renderer.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Skip commit in this workspace because it is not a git repository.

### Task 10: Add Invalidation Matrix and Change Detection

**Files:**
- Create: `tools/project-memory-context/src/invalidation-matrix.mjs`
- Create: `tools/project-memory-context/src/change-detector.mjs`
- Create: `tools/project-memory-context/tests/invalidation-matrix.test.mjs`
- Create: `tools/project-memory-context/tests/change-detector.test.mjs`

- [ ] **Step 1: Write the failing tests**

Create `tools/project-memory-context/tests/invalidation-matrix.test.mjs` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { detectInvalidatedProjectContextKinds } from '../src/invalidation-matrix.mjs';

test('package.json invalidates stack and dependency memories', () => {
  const result = detectInvalidatedProjectContextKinds(['package.json']);
  assert.deepEqual(result.sort(), ['dependencies-summary', 'integrations-summary', 'stack-runtime']);
});

test('declared technical rules file invalidates rules memory', () => {
  const result = detectInvalidatedProjectContextKinds(['.planning/project-memory-context/project-context/declared/technical-rules.json']);
  assert.equal(result.includes('technical-rules'), true);
});
```

Create `tools/project-memory-context/tests/change-detector.test.mjs` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { detectChangedFilesFromHashes } from '../src/change-detector.mjs';

test('detectChangedFilesFromHashes returns changed and new files', () => {
  const result = detectChangedFilesFromHashes(
    { 'package.json': 'abc', 'README.md': 'old' },
    { 'package.json': 'abc', 'README.md': 'new', 'tsconfig.json': 'zzz' },
  );

  assert.deepEqual(result.sort(), ['README.md', 'tsconfig.json']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tools/project-memory-context/tests/invalidation-matrix.test.mjs tools/project-memory-context/tests/change-detector.test.mjs`
Expected: FAIL with missing modules.

- [ ] **Step 3: Write minimal implementations**

Create `tools/project-memory-context/src/invalidation-matrix.mjs`:

```js
const PACKAGE_FILES = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'tsconfig.json', 'global.json']);

export function detectInvalidatedProjectContextKinds(changedFiles) {
  const invalidated = new Set();
  for (const file of changedFiles) {
    if (PACKAGE_FILES.has(file) || file.endsWith('.csproj')) {
      invalidated.add('stack-runtime');
      invalidated.add('dependencies-summary');
      invalidated.add('integrations-summary');
    }
    if (file.startsWith('.planning/project-memory-context/project-context/declared/technical-rules')) {
      invalidated.add('technical-rules');
    }
    if (file.startsWith('.planning/project-memory-context/project-context/declared/project-requirements')) {
      invalidated.add('project-requirements');
    }
    if (file.startsWith('.planning/project-memory-context/project-context/declared/known-issues-and-fixes')) {
      invalidated.add('known-issues-and-fixes');
    }
    if (file.startsWith('.planning/project-memory-context/project-context/declared/architecture-target')) {
      invalidated.add('architecture-target');
    }
    if (file === 'README.md' || file.endsWith('AGENTS.md')) {
      invalidated.add('technical-rules');
      invalidated.add('project-requirements');
    }
  }
  return [...invalidated];
}
```

Create `tools/project-memory-context/src/change-detector.mjs`:

```js
export function detectChangedFilesFromHashes(previousHashes, nextHashes) {
  const changed = [];
  const files = new Set([...Object.keys(previousHashes), ...Object.keys(nextHashes)]);
  for (const file of files) {
    if (previousHashes[file] !== nextHashes[file]) {
      changed.push(file);
    }
  }
  return changed;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tools/project-memory-context/tests/invalidation-matrix.test.mjs tools/project-memory-context/tests/change-detector.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Skip commit in this workspace because it is not a git repository.

### Task 11: Add Main Project-Context CLI Orchestrator

**Files:**
- Create: `tools/project-memory-context/cli/project-context.mjs`
- Create: `tools/project-memory-context/tests/project-context-cli.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tools/project-memory-context/tests/project-context-cli.test.mjs` with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('project-context CLI bootstrap writes materialized json and markdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-context-cli-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', packageManager: 'npm@10', dependencies: { next: '^15.0.0' }, devDependencies: { typescript: '^5.0.0' } }), 'utf8');
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022' } }), 'utf8');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'main.ts'), 'export {}\n', 'utf8');
  await writeFile(join(root, 'README.md'), 'Use pnpm. Keep domain logic in src/domain.\n', 'utf8');

  const result = spawnSync(process.execPath, ['tools/project-memory-context/cli/project-context.mjs', root], {
    cwd: 'C:/Users/aabad/Documents/CODE/ia/memory-context',
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  const json = JSON.parse(await readFile(join(root, '.planning', 'project-memory-context', 'project-context', 'materialized', 'stack-runtime.json'), 'utf8'));
  const markdown = await readFile(join(root, '.planning', 'project-memory-context', 'project-context', 'markdown', 'STACK-RUNTIME.md'), 'utf8');

  assert.equal(json.kind, 'stack-runtime');
  assert.match(markdown, /^# Project stack and runtime/m);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/project-memory-context/tests/project-context-cli.test.mjs`
Expected: FAIL with missing CLI file.

- [ ] **Step 3: Write minimal implementation**

Create `tools/project-memory-context/cli/project-context.mjs` that:

```js
#!/usr/bin/env node
import { basename, join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

import { ensureProjectMemoryContextDirs, writeJsonArtifact } from '../src/artifacts.mjs';
import { detectStackContext } from '../src/extractors/stack-extractor.mjs';
import { detectStructureContext } from '../src/extractors/structure-extractor.mjs';
import { detectArchitectureContext } from '../src/extractors/architecture-extractor.mjs';
import { detectRulesContext } from '../src/extractors/rules-extractor.mjs';
import { createDeclaredProjectContextTemplates } from '../src/declared-intake.mjs';
import { materializeProjectContextMemories } from '../src/materializer.mjs';
import { renderProjectContextMarkdown } from '../src/markdown-renderer.mjs';

function log(message) {
  console.error(`[project-context] ${message}`);
}

async function readText(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

async function main() {
  const projectRoot = resolve(process.argv[2] ?? process.cwd());
  const dirs = await ensureProjectMemoryContextDirs(projectRoot);
  const updatedAt = new Date().toISOString();
  const stack = await detectStackContext(projectRoot);
  const structure = await detectStructureContext(projectRoot);
  const architecture = await detectArchitectureContext({ graph: { nodes: structure.entryPoints.map((entry) => ({ label: entry })), edges: [] } });
  const rules = await detectRulesContext({ readmeText: await readText(join(projectRoot, 'README.md')) });

  const detected = { stack, structure, architecture, rules };
  const declared = {
    architectureTarget: { architecture: '' },
    technicalRules: { rules: [] },
    projectRequirements: { requirements: [] },
    knownIssuesAndFixes: { items: [] },
  };
  const templates = createDeclaredProjectContextTemplates();

  for (const [fileName, payload] of Object.entries(templates)) {
    await writeJsonArtifact(join(dirs.projectContextDeclared, fileName), payload);
  }

  const memories = materializeProjectContextMemories({
    projectSlug: basename(projectRoot).toLowerCase(),
    detected,
    declared,
    updatedAt,
  });

  for (const memory of memories) {
    const jsonName = `${memory.kind}.json`;
    const markdownName = `${memory.kind.toUpperCase()}.md`;
    await writeJsonArtifact(join(dirs.projectContextMaterialized, jsonName), memory);
    const markdown = renderProjectContextMarkdown(memory);
    await writeJsonArtifact(join(dirs.projectContextState, 'last-run.json'), { updatedAt, count: memories.length });
    await import('node:fs/promises').then(({ writeFile }) => writeFile(join(dirs.projectContextMarkdown, markdownName), markdown, 'utf8'));
  }

  log(`Wrote ${memories.length} project-context memories.`);
}

main().catch((error) => {
  console.error('[project-context] FATAL:', error.message);
  process.exit(1);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/project-memory-context/tests/project-context-cli.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Skip commit in this workspace because it is not a git repository.

### Task 12: Integrate Project-Context Bootstrap into `new-project`

**Files:**
- Modify: `tools/project-memory-context/cli/new-project.mjs`
- Test: `tools/project-memory-context/tests/setup-bootstrap.test.mjs`

- [ ] **Step 1: Write the failing test**

Add a test in `tools/project-memory-context/tests/setup-bootstrap.test.mjs` that verifies `new-project.mjs` writes `.planning/project-memory-context/project-context/materialized/stack-runtime.json` when run against a temp repo containing `package.json`, `tsconfig.json`, and `README.md`.

The critical assertion should be:

```js
assert.equal(existsSync(join(projectRoot, '.planning', 'project-memory-context', 'project-context', 'materialized', 'stack-runtime.json')), true);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/project-memory-context/tests/setup-bootstrap.test.mjs`
Expected: FAIL because `new-project.mjs` does not trigger project-context generation.

- [ ] **Step 3: Write minimal implementation**

Modify `tools/project-memory-context/cli/new-project.mjs` to run the new CLI after writing install state:

```js
log('Generating project context artifacts...');
const projectContextScript = resolve(PMC_CLI_ROOT, 'project-context.mjs');
const contextResult = spawnSync('node', [projectContextScript, targetDir], {
  cwd: targetDir,
  stdio: 'inherit',
  env: { ...process.env },
});
if (contextResult.status !== 0) {
  log(`WARNING: project-context generation failed with code ${contextResult.status}`);
}
```

Also update `syncToolsToTarget()` to copy `project-context.mjs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/project-memory-context/tests/setup-bootstrap.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Skip commit in this workspace because it is not a git repository.

### Task 13: Add Refresh Mode to Project-Context CLI

**Files:**
- Modify: `tools/project-memory-context/cli/project-context.mjs`
- Modify: `tools/project-memory-context/src/change-detector.mjs`
- Modify: `tools/project-memory-context/src/invalidation-matrix.mjs`
- Create: `tools/project-memory-context/tests/project-context-refresh.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tools/project-memory-context/tests/project-context-refresh.test.mjs` with a scenario that:

1. bootstraps a temp project
2. edits `README.md`
3. reruns `project-context.mjs --refresh <root>`
4. asserts `technical-rules.json` changes while `stack-runtime.json` keeps the same `content_hash`

Use these assertions:

```js
assert.notEqual(refreshedRules.content_hash, initialRules.content_hash);
assert.equal(refreshedStack.content_hash, initialStack.content_hash);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/project-memory-context/tests/project-context-refresh.test.mjs`
Expected: FAIL because refresh mode does not exist.

- [ ] **Step 3: Write minimal implementation**

Extend `project-context.mjs` with manual arg parsing:

```js
const args = process.argv.slice(2);
const refreshMode = args.includes('--refresh');
const targetArg = args.find((arg) => !arg.startsWith('--'));
```

Then in refresh mode:

- read prior materialized JSON files if present
- compute next hashes for tracked files (`package.json`, `tsconfig.json`, `README.md`, declared files)
- call `detectChangedFilesFromHashes()`
- call `detectInvalidatedProjectContextKinds()`
- only rewrite invalidated memories
- preserve unchanged memory files
- write updated `content-hashes.json`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/project-memory-context/tests/project-context-refresh.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Skip commit in this workspace because it is not a git repository.

### Task 14: Add Local Agent-Memory Sync Manifest

**Files:**
- Modify: `tools/project-memory-context/cli/project-context.mjs`
- Create: `tools/project-memory-context/tests/project-context-sync-manifest.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tools/project-memory-context/tests/project-context-sync-manifest.test.mjs` that asserts the CLI writes:

` .planning/project-memory-context/project-context/state/agent-memory-sync.json`

with one entry per materialized memory containing:

```js
assert.equal(sync.entries.length, 9);
assert.equal(sync.entries[0].memory_key.startsWith('project-context:'), true);
assert.equal(sync.entries[0].category, 'architecture');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tools/project-memory-context/tests/project-context-sync-manifest.test.mjs`
Expected: FAIL because the sync manifest is not written.

- [ ] **Step 3: Write minimal implementation**

In `project-context.mjs`, after materialization, write:

```js
await writeJsonArtifact(join(dirs.projectContextState, 'agent-memory-sync.json'), {
  updatedAt,
  entries: memories.map((memory) => ({
    memory_key: memory.memory_key,
    title: memory.title,
    category: 'architecture',
    tags: memory.tags,
    content: `# ${memory.title}\n\n${memory.summary}\n\n${memory.body}`,
  })),
});
```

This keeps local canonical output and the future agent-memory upsert payload in one place.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tools/project-memory-context/tests/project-context-sync-manifest.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

Skip commit in this workspace because it is not a git repository.

### Task 15: End-to-End Verification

**Files:**
- Modify: `tools/project-memory-context/tests/setup-bootstrap.test.mjs`
- Modify: `tools/project-memory-context/tests/project-context-cli.test.mjs`
- Modify: `tools/project-memory-context/tests/project-context-refresh.test.mjs`

- [ ] **Step 1: Add end-to-end assertions**

Extend tests so the full bootstrap verifies all of these:

```js
assert.equal(existsSync(join(root, '.planning', 'project-memory-context', 'project-context', 'detected')), true);
assert.equal(existsSync(join(root, '.planning', 'project-memory-context', 'project-context', 'declared')), true);
assert.equal(existsSync(join(root, '.planning', 'project-memory-context', 'project-context', 'materialized')), true);
assert.equal(existsSync(join(root, '.planning', 'project-memory-context', 'project-context', 'markdown')), true);
assert.equal(existsSync(join(root, '.planning', 'project-memory-context', 'project-context', 'state', 'agent-memory-sync.json')), true);
```

- [ ] **Step 2: Run the targeted project-context test suite**

Run:

```bash
node --test \
  tools/project-memory-context/tests/artifacts.test.mjs \
  tools/project-memory-context/tests/project-context-schema.test.mjs \
  tools/project-memory-context/tests/refresh-state.test.mjs \
  tools/project-memory-context/tests/stack-extractor.test.mjs \
  tools/project-memory-context/tests/structure-extractor.test.mjs \
  tools/project-memory-context/tests/architecture-extractor.test.mjs \
  tools/project-memory-context/tests/rules-extractor.test.mjs \
  tools/project-memory-context/tests/declared-intake.test.mjs \
  tools/project-memory-context/tests/materializer.test.mjs \
  tools/project-memory-context/tests/markdown-renderer.test.mjs \
  tools/project-memory-context/tests/invalidation-matrix.test.mjs \
  tools/project-memory-context/tests/change-detector.test.mjs \
  tools/project-memory-context/tests/project-context-cli.test.mjs \
  tools/project-memory-context/tests/project-context-refresh.test.mjs \
  tools/project-memory-context/tests/project-context-sync-manifest.test.mjs \
  tools/project-memory-context/tests/setup-bootstrap.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Fix minimal failures if any**

If a failing assertion shows path or naming mismatches, fix the implementation rather than weakening the tests.

- [ ] **Step 4: Run the targeted suite again**

Run the same command as Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

Skip commit in this workspace because it is not a git repository.
