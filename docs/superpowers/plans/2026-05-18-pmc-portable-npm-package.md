# PMC Portable NPM Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert PMC into two publishable npm packages, `@brain/project-memory-context` and `@brain/agent-memory-mcp`, with a cross-platform CLI and agent-specific adapters while preserving the `/new-project` activation workflow for every supported agent.

**Architecture:** Keep the enrichment, retrieval, project-context, and sync-manifest core intact. Move all OS-specific and agent-specific behavior behind a small portability layer (`src/platform.mjs`), expose a single `pmc` CLI binary, and generate agent integration files from templates so the same package can target opencode, Claude Code, Cursor, or a generic CLI-only setup.

**Tech Stack:** Node.js 18+ ESM, node:test, TypeScript + Vitest for `agent-memory-mcp`, Python `graphifyy`, MCP stdio servers, LanceDB, Hugging Face `@huggingface/transformers`.

---

## File Map

### `agent-memory-mcp/`

- Modify: `agent-memory-mcp/package.json`
- Modify: `agent-memory-mcp/src/server.ts`
- Create: `agent-memory-mcp/src/version.ts`
- Modify: `agent-memory-mcp/README.md`
- Create: `agent-memory-mcp/tests/version.test.ts`

### `tools/project-memory-context/`

- Modify: `tools/project-memory-context/package.json`
- Create: `tools/project-memory-context/bin/pmc.mjs`
- Create: `tools/project-memory-context/src/index.mjs`
- Create: `tools/project-memory-context/src/platform.mjs`
- Create: `tools/project-memory-context/src/command-dispatch.mjs`
- Create: `tools/project-memory-context/src/template-installer.mjs`
- Create: `tools/project-memory-context/cli/bootstrap.mjs`
- Create: `tools/project-memory-context/cli/enrich.mjs`
- Create: `tools/project-memory-context/cli/context.mjs`
- Create: `tools/project-memory-context/cli/init.mjs`
- Create: `tools/project-memory-context/cli/status.mjs`
- Modify: `tools/project-memory-context/cli/new-project.mjs`
- Modify: `tools/project-memory-context/cli/enrich-queue.mjs`
- Modify: `tools/project-memory-context/cli/project-context.mjs`
- Modify: `tools/project-memory-context/cli/sanitize.mjs`
- Modify: `tools/project-memory-context/cli/setup.mjs`
- Modify: `tools/project-memory-context/cli/install-pmc.mjs`
- Modify: `tools/project-memory-context/cli/enrich-batch.mjs`
- Modify: `tools/project-memory-context/cli/batch-enrich.mjs`
- Modify: `tools/project-memory-context/cli/enrich-orchestrator.mjs`
- Modify: `tools/project-memory-context/cli/enrich-sync.mjs`
- Modify: `tools/project-memory-context/src/enrichment-config.mjs`
- Modify: `tools/project-memory-context/src/setup-bootstrap.mjs`
- Modify: `tools/project-memory-context/src/invalidation-matrix.mjs`
- Modify: `tools/project-memory-context/src/plugin-config.mjs`
- Modify: `tools/project-memory-context/plugin/index.mjs`
- Create: `tools/project-memory-context/templates/opencode/commands/new-project.md`
- Create: `tools/project-memory-context/templates/opencode/commands/get-context.md`
- Create: `tools/project-memory-context/templates/opencode/commands/sync-context.md`
- Create: `tools/project-memory-context/templates/opencode/commands/sanitize.md`
- Create: `tools/project-memory-context/templates/opencode/agent/enrich.md`
- Create: `tools/project-memory-context/templates/opencode/autostart-snippet.md`
- Create: `tools/project-memory-context/templates/claude-code/CLAUDE.md.snippet`
- Create: `tools/project-memory-context/templates/cursor/.cursorrules.snippet`
- Create: `tools/project-memory-context/templates/generic/README-SETUP.md`
- Create: `tools/project-memory-context/tests/versioned-package.test.mjs`
- Create: `tools/project-memory-context/tests/platform.test.mjs`
- Create: `tools/project-memory-context/tests/command-dispatch.test.mjs`
- Create: `tools/project-memory-context/tests/init.test.mjs`
- Create: `tools/project-memory-context/tests/status.test.mjs`
- Modify: `tools/project-memory-context/tests/new-project-config.test.mjs`
- Modify: `tools/project-memory-context/tests/setup-bootstrap.test.mjs`
- Modify: `tools/project-memory-context/tests/enrichment-config.test.mjs`
- Modify: `tools/project-memory-context/tests/invalidation-matrix.test.mjs`
- Modify: `tools/project-memory-context/tests/plugin-config.test.mjs`

## Task 1: Publish `@brain/agent-memory-mcp`

**Files:**
- Create: `agent-memory-mcp/src/version.ts`
- Modify: `agent-memory-mcp/src/server.ts`
- Modify: `agent-memory-mcp/package.json`
- Modify: `agent-memory-mcp/README.md`
- Test: `agent-memory-mcp/tests/version.test.ts`

- [ ] **Step 1: Write the failing version metadata test**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PACKAGE_INFO } from '../src/version.js';

const packageJson = JSON.parse(
  readFileSync(join(process.cwd(), 'package.json'), 'utf8')
);

describe('PACKAGE_INFO', () => {
  it('matches package.json package identity while keeping the MCP server name stable', () => {
    expect(PACKAGE_INFO.packageName).toBe(packageJson.name);
    expect(PACKAGE_INFO.version).toBe(packageJson.version);
    expect(PACKAGE_INFO.serverName).toBe('agent-memory');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/version.test.ts`

Expected: FAIL because `src/version.ts` does not exist and `PACKAGE_INFO` is undefined.

- [ ] **Step 3: Implement the minimal metadata export and use it in the server**

`agent-memory-mcp/src/version.ts`

```ts
export const PACKAGE_INFO = {
  packageName: '@brain/agent-memory-mcp',
  serverName: 'agent-memory',
  version: '2.0.0',
};
```

`agent-memory-mcp/src/server.ts`

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MemoryStore } from './types.js';
import { registerTools } from './tools.js';
import { PACKAGE_INFO } from './version.js';

export function createServer(store: MemoryStore): McpServer {
  const server = new McpServer({
    name: PACKAGE_INFO.serverName,
    version: PACKAGE_INFO.version,
  });
  registerTools(server, store);
  return server;
}
```

`agent-memory-mcp/package.json`

```json
{
  "name": "@brain/agent-memory-mcp",
  "version": "2.0.0",
  "description": "MCP server for persistent agent memory backed by LanceDB with Xenova/bge-m3 embeddings.",
  "bin": {
    "agent-memory-mcp": "dist/index.js"
  },
  "publishConfig": {
    "access": "public"
  }
}
```

- [ ] **Step 4: Update the README for the forked package**

Add this install section near the top of `agent-memory-mcp/README.md`:

```md
## Install

```bash
npm install -g @brain/agent-memory-mcp
```

First run downloads `Xenova/bge-m3`, which is large. Keep at least 1 GB free for model cache and the LanceDB store.

Supported platforms: Linux x64/arm64, macOS x64/arm64, Windows x64.
```

- [ ] **Step 5: Run the package tests and build**

Run: `npm test`

Expected: PASS, including `tests/version.test.ts`.

Run: `npm run build`

Expected: PASS, `dist/index.js` updated with the `#!/usr/bin/env node` shebang preserved.

- [ ] **Step 6: Record completion**

Current workspace root is not a git repo. Do not commit here. Mark Task 1 complete in the plan checklist.

## Task 2: Rebrand PMC package and add a single `pmc` CLI entry point

**Files:**
- Modify: `tools/project-memory-context/package.json`
- Create: `tools/project-memory-context/src/index.mjs`
- Create: `tools/project-memory-context/src/command-dispatch.mjs`
- Create: `tools/project-memory-context/bin/pmc.mjs`
- Test: `tools/project-memory-context/tests/versioned-package.test.mjs`
- Test: `tools/project-memory-context/tests/command-dispatch.test.mjs`

- [ ] **Step 1: Write the failing PMC package metadata and dispatch tests**

`tools/project-memory-context/tests/versioned-package.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('package metadata uses the @brain scope and pmc binary', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@brain/project-memory-context');
  assert.equal(pkg.bin.pmc, 'bin/pmc.mjs');
});
```

`tools/project-memory-context/tests/command-dispatch.test.mjs`

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveCommand } from '../src/command-dispatch.mjs';

test('resolveCommand maps bootstrap to cli/bootstrap.mjs', () => {
  const command = resolveCommand(['bootstrap']);
  assert.equal(command.name, 'bootstrap');
  assert.match(command.modulePath, /cli[\\/]bootstrap\.mjs$/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/versioned-package.test.mjs tests/command-dispatch.test.mjs`

Expected: FAIL because the package name is still `opencode-project-memory-context` and `src/command-dispatch.mjs` does not exist.

- [ ] **Step 3: Update package metadata and add the dispatch layer**

`tools/project-memory-context/package.json`

```json
{
  "name": "@brain/project-memory-context",
  "version": "1.0.0",
  "description": "Persistent structured memory for AI coding agents.",
  "type": "module",
  "bin": {
    "pmc": "bin/pmc.mjs",
    "pmc-local-model-mcp": "mcp/local-model-server.mjs"
  },
  "exports": {
    ".": "./src/index.mjs",
    "./platform": "./src/platform.mjs",
    "./retrieval": "./src/retrieval/query-engine.mjs"
  },
  "peerDependencies": {
    "@brain/agent-memory-mcp": ">=2.0.0"
  },
  "peerDependenciesMeta": {
    "@brain/agent-memory-mcp": {
      "optional": true
    }
  }
}
```

`tools/project-memory-context/src/index.mjs`

```js
export { resolveCommand, runCommand } from './command-dispatch.mjs';
export { resolveConfigDirs, resolveGraphify, spawnBackground } from './platform.mjs';
```

`tools/project-memory-context/src/command-dispatch.mjs`

```js
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const COMMANDS = new Map([
  ['init', 'cli/init.mjs'],
  ['bootstrap', 'cli/bootstrap.mjs'],
  ['enrich', 'cli/enrich.mjs'],
  ['sanitize', 'cli/sanitize.mjs'],
  ['context', 'cli/context.mjs'],
  ['status', 'cli/status.mjs'],
]);

export function resolveCommand(argv) {
  const name = argv[0] ?? 'help';
  const relativeModule = COMMANDS.get(name);
  return relativeModule
    ? { name, modulePath: resolve(PACKAGE_ROOT, relativeModule), args: argv.slice(1) }
    : { name: 'help', modulePath: null, args: argv };
}

export async function runCommand(argv) {
  const command = resolveCommand(argv);
  if (!command.modulePath) {
    console.log('Usage: pmc <init|bootstrap|enrich|sanitize|context|status>');
    return;
  }

  const mod = await import(command.modulePath);
  if (typeof mod.main === 'function') {
    await mod.main(command.args);
  }
}
```

`tools/project-memory-context/bin/pmc.mjs`

```js
#!/usr/bin/env node
import { runCommand } from '../src/command-dispatch.mjs';

runCommand(process.argv.slice(2)).catch((error) => {
  console.error('[pmc] FATAL:', error.message);
  process.exit(1);
});
```

- [ ] **Step 4: Run the targeted tests**

Run: `node --test tests/versioned-package.test.mjs tests/command-dispatch.test.mjs`

Expected: PASS.

- [ ] **Step 5: Record completion**

Current workspace root is not a git repo. Do not commit here. Mark Task 2 complete in the plan checklist.

## Task 3: Add the cross-platform utility layer

**Files:**
- Create: `tools/project-memory-context/src/platform.mjs`
- Test: `tools/project-memory-context/tests/platform.test.mjs`

- [ ] **Step 1: Write the failing platform tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isAgentInstructionFile,
  normalizeProjectPath,
  resolveConfigDirs,
} from '../src/platform.mjs';

test('isAgentInstructionFile recognises supported agent rule files', () => {
  assert.equal(isAgentInstructionFile('AGENTS.md'), true);
  assert.equal(isAgentInstructionFile('CLAUDE.md'), true);
  assert.equal(isAgentInstructionFile('.cursorrules'), true);
  assert.equal(isAgentInstructionFile('README.md'), false);
});

test('resolveConfigDirs prefers .pmc and falls back to .opencode', () => {
  const dirs = resolveConfigDirs('C:/repo', {
    exists: (candidate) => candidate.endsWith('.opencode'),
  });
  assert.match(dirs.projectConfig, /\.opencode$/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/platform.test.mjs`

Expected: FAIL because `src/platform.mjs` does not exist.

- [ ] **Step 3: Implement `src/platform.mjs`**

```js
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, normalize } from 'node:path';

const PROJECT_DIR_NAMES = ['.pmc', '.opencode', '.claude', '.cursor'];
const GLOBAL_DIR_CANDIDATES = [
  join(homedir(), '.config', 'pmc'),
  join(homedir(), '.config', 'opencode'),
  join(homedir(), '.claude'),
];
const INSTRUCTION_FILES = new Set(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules', '.windsurfrules']);

export function normalizeProjectPath(filePath) {
  return normalize(filePath).replace(/\\/g, '/');
}

export function isAgentInstructionFile(filePath) {
  return INSTRUCTION_FILES.has(filePath.split('/').at(-1));
}

export function resolveConfigDirs(projectRoot, fsAdapter = { exists: existsSync }) {
  const projectConfig = PROJECT_DIR_NAMES
    .map((name) => join(projectRoot, name))
    .find((candidate) => fsAdapter.exists(candidate)) ?? join(projectRoot, '.pmc');

  const globalConfig = GLOBAL_DIR_CANDIDATES
    .find((candidate) => fsAdapter.exists(candidate)) ?? join(homedir(), '.config', 'pmc');

  return { projectConfig, globalConfig };
}

export function spawnBackground(command, args, cwd) {
  const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
  child.unref();
  return child.pid;
}

export function resolvePythonBin() {
  if (process.platform === 'win32') return 'python';
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return 'python3';
  } catch {
    return 'python';
  }
}

export function resolveGraphify() {
  if (process.env.PMC_GRAPHIFY_PATH) return process.env.PMC_GRAPHIFY_PATH;
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    return execFileSync(finder, ['graphify'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  } catch {
    throw new Error('graphify not found. Install it with `pip install graphifyy` or set PMC_GRAPHIFY_PATH.');
  }
}
```

- [ ] **Step 4: Run the platform tests**

Run: `node --test tests/platform.test.mjs`

Expected: PASS.

- [ ] **Step 5: Record completion**

Current workspace root is not a git repo. Do not commit here. Mark Task 3 complete in the plan checklist.

## Task 4: Refactor config resolution and invalidation to use the portability layer

**Files:**
- Modify: `tools/project-memory-context/src/enrichment-config.mjs`
- Modify: `tools/project-memory-context/src/setup-bootstrap.mjs`
- Modify: `tools/project-memory-context/src/invalidation-matrix.mjs`
- Modify: `tools/project-memory-context/tests/enrichment-config.test.mjs`
- Modify: `tools/project-memory-context/tests/setup-bootstrap.test.mjs`
- Modify: `tools/project-memory-context/tests/invalidation-matrix.test.mjs`

- [ ] **Step 1: Write the failing invalidation/config tests**

Add these assertions:

```js
test('detectInvalidatedProjectContextKinds invalidates technical rules for CLAUDE.md', () => {
  const result = detectInvalidatedProjectContextKinds(['CLAUDE.md']);
  assert.deepEqual(result.sort(), ['project-requirements', 'technical-rules']);
});

test('resolveEnrichmentConfig honours PMC_GLOBAL_CONFIG before ~/.config/opencode', () => {
  const result = resolveEnrichmentConfig({
    projectConfig: null,
    globalConfig: { localModel: { model: 'global-model' } },
    env: { PMC_GLOBAL_CONFIG: '/tmp/pmc.json' },
  });
  assert.equal(result.localModel.model, 'global-model');
});
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `node --test tests/enrichment-config.test.mjs tests/setup-bootstrap.test.mjs tests/invalidation-matrix.test.mjs`

Expected: FAIL because `CLAUDE.md` is not recognised and setup/bootstrap still assumes `.opencode/opencode.json`.

- [ ] **Step 3: Update the source modules to use `platform.mjs`**

`tools/project-memory-context/src/invalidation-matrix.mjs`

```js
import { isAgentInstructionFile } from './platform.mjs';

const PACKAGE_FILES = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'tsconfig.json', 'global.json']);

export function detectInvalidatedProjectContextKinds(changedFiles) {
  const invalidated = new Set();
  for (const file of changedFiles) {
    if (PACKAGE_FILES.has(file) || file.endsWith('.csproj')) {
      invalidated.add('stack-runtime');
      invalidated.add('dependencies-summary');
      invalidated.add('integrations-summary');
    }
    if (file === 'README.md' || isAgentInstructionFile(file)) {
      invalidated.add('technical-rules');
      invalidated.add('project-requirements');
    }
  }
  return [...invalidated];
}
```

`tools/project-memory-context/src/setup-bootstrap.mjs`

```js
import { join } from 'node:path';
import { resolveConfigDirs } from './platform.mjs';

async function ensureAgentConfigRegistration(projectRoot) {
  const { projectConfig } = resolveConfigDirs(projectRoot);
  const configPath = join(projectConfig, 'project-memory-context.json');
  await mkdir(projectConfig, { recursive: true });
  return configPath;
}
```

`tools/project-memory-context/src/enrichment-config.mjs`

```js
export const PMC_ENRICHMENT_CONFIG_FILE = 'project-memory-context.json';

export function readEnvPreferredModes(env) {
  return env.PMC_ENRICHMENT_PREFERRED_MODES
    ? env.PMC_ENRICHMENT_PREFERRED_MODES.split(',').map((mode) => mode.trim()).filter(Boolean)
    : null;
}
```

- [ ] **Step 4: Run the targeted tests**

Run: `node --test tests/enrichment-config.test.mjs tests/setup-bootstrap.test.mjs tests/invalidation-matrix.test.mjs`

Expected: PASS.

- [ ] **Step 5: Record completion**

Current workspace root is not a git repo. Do not commit here. Mark Task 4 complete in the plan checklist.

## Task 5: Replace `new-project.mjs` with a portable `bootstrap.mjs` and keep `/new-project` alive

**Files:**
- Create: `tools/project-memory-context/cli/bootstrap.mjs`
- Modify: `tools/project-memory-context/cli/new-project.mjs`
- Modify: `tools/project-memory-context/tests/new-project-config.test.mjs`
- Modify: `tools/project-memory-context/tests/setup-bootstrap.test.mjs`

- [ ] **Step 1: Write the failing bootstrap wrapper test**

Add this test case to `tools/project-memory-context/tests/new-project-config.test.mjs`:

```js
import { buildBootstrapConfig } from '../cli/bootstrap.mjs';

test('buildBootstrapConfig preserves the three fallback modes', () => {
  const result = buildBootstrapConfig();
  assert.deepEqual(result.preferredModes, ['local-model', 'cloud-api', 'agent-subagent']);
});
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `node --test tests/new-project-config.test.mjs tests/setup-bootstrap.test.mjs`

Expected: FAIL because `cli/bootstrap.mjs` does not exist.

- [ ] **Step 3: Implement the new bootstrap CLI and turn `new-project.mjs` into a compatibility wrapper**

`tools/project-memory-context/cli/bootstrap.mjs`

```js
#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { resolveConfigDirs, resolveGraphify, spawnBackground } from '../src/platform.mjs';
import { PMC_ENRICHMENT_CONFIG_FILE, resolveEnrichmentConfig } from '../src/enrichment-config.mjs';

export function buildBootstrapConfig() {
  return resolveEnrichmentConfig({ projectConfig: {}, globalConfig: {}, env: process.env });
}

export async function runBootstrap(projectRoot, options = {}) {
  const { projectConfig } = resolveConfigDirs(projectRoot);
  await mkdir(projectConfig, { recursive: true });
  await writeFile(resolve(projectConfig, PMC_ENRICHMENT_CONFIG_FILE), `${JSON.stringify(buildBootstrapConfig(), null, 2)}\n`, 'utf8');
  const graphifyExe = resolveGraphify();
  // existing graphify + worklist + project-context pipeline moves here
  if (options.enrich) {
    spawnBackground('node', [resolve(process.cwd(), 'tools/project-memory-context/cli/enrich.mjs'), projectRoot], projectRoot);
  }
}
```

`tools/project-memory-context/cli/new-project.mjs`

```js
#!/usr/bin/env node
export { buildBootstrapConfig as buildDefaultEnrichmentConfig } from './bootstrap.mjs';
export { runBootstrap } from './bootstrap.mjs';

if (import.meta.url === `file://${process.argv[1]}`) {
  const { runBootstrap } = await import('./bootstrap.mjs');
  await runBootstrap(process.argv[2] || process.cwd(), { enrich: process.argv.includes('--enrich') });
}
```

- [ ] **Step 4: Run the targeted tests**

Run: `node --test tests/new-project-config.test.mjs tests/setup-bootstrap.test.mjs`

Expected: PASS, and the wrapper still supports the existing `/new-project` flow.

- [ ] **Step 5: Record completion**

Current workspace root is not a git repo. Do not commit here. Mark Task 5 complete in the plan checklist.

## Task 6: Refactor enrichment and sanitize commands to the portable CLI layout

**Files:**
- Create: `tools/project-memory-context/cli/enrich.mjs`
- Create: `tools/project-memory-context/cli/context.mjs`
- Modify: `tools/project-memory-context/cli/enrich-queue.mjs`
- Modify: `tools/project-memory-context/cli/project-context.mjs`
- Modify: `tools/project-memory-context/cli/sanitize.mjs`
- Modify: `tools/project-memory-context/tests/enrich-queue-driver.test.mjs`
- Modify: `tools/project-memory-context/tests/project-context-cli.test.mjs`

- [ ] **Step 1: Write the failing wrapper tests**

Add these expectations:

```js
test('enrich wrapper exports runEnrichQueue', async () => {
  const mod = await import('../cli/enrich.mjs');
  assert.equal(typeof mod.runEnrichQueue, 'function');
});

test('context wrapper exports runProjectContext', async () => {
  const mod = await import('../cli/context.mjs');
  assert.equal(typeof mod.runProjectContext, 'function');
});
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `node --test tests/enrich-queue-driver.test.mjs tests/project-context-cli.test.mjs`

Expected: FAIL because `cli/enrich.mjs` and `cli/context.mjs` do not exist.

- [ ] **Step 3: Implement the new entry points and update `sanitize.mjs`**

`tools/project-memory-context/cli/enrich.mjs`

```js
#!/usr/bin/env node
export { runQueueSymbolEnrichment, buildQueueSummary, parseQueueConcurrency } from './enrich-queue.mjs';

export async function runEnrichQueue(projectRoot = process.cwd()) {
  const mod = await import('./enrich-queue.mjs');
  return mod.default ? mod.default(projectRoot) : null;
}
```

`tools/project-memory-context/cli/context.mjs`

```js
#!/usr/bin/env node
export async function runProjectContext(projectRoot = process.cwd(), refresh = false) {
  const mod = await import('./project-context.mjs');
  return mod.runProjectContextCli(projectRoot, { refresh });
}
```

Update the background hint in `tools/project-memory-context/cli/sanitize.mjs` to:

```js
import { resolve } from 'node:path';
import { resolveGraphify, spawnBackground } from '../src/platform.mjs';

if (pendingCount > 0) {
  const enrichCli = resolve(process.cwd(), 'tools/project-memory-context/cli/enrich.mjs');
  spawnBackground('node', [enrichCli, PROJECT_ROOT], PROJECT_ROOT);
  log(`Background enrichment launched via ${enrichCli}`);
}
```

- [ ] **Step 4: Run the targeted tests**

Run: `node --test tests/enrich-queue-driver.test.mjs tests/project-context-cli.test.mjs`

Expected: PASS.

- [ ] **Step 5: Record completion**

Current workspace root is not a git repo. Do not commit here. Mark Task 6 complete in the plan checklist.

## Task 7: Implement `pmc init` and agent templates, keeping `/new-project` as the canonical activation command

**Files:**
- Create: `tools/project-memory-context/src/template-installer.mjs`
- Create: `tools/project-memory-context/cli/init.mjs`
- Create: `tools/project-memory-context/templates/opencode/commands/new-project.md`
- Create: `tools/project-memory-context/templates/opencode/commands/get-context.md`
- Create: `tools/project-memory-context/templates/opencode/commands/sync-context.md`
- Create: `tools/project-memory-context/templates/opencode/commands/sanitize.md`
- Create: `tools/project-memory-context/templates/opencode/agent/enrich.md`
- Create: `tools/project-memory-context/templates/opencode/autostart-snippet.md`
- Create: `tools/project-memory-context/templates/claude-code/CLAUDE.md.snippet`
- Create: `tools/project-memory-context/templates/cursor/.cursorrules.snippet`
- Create: `tools/project-memory-context/templates/generic/README-SETUP.md`
- Test: `tools/project-memory-context/tests/init.test.mjs`

- [ ] **Step 1: Write the failing init test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { installAgentTemplates } from '../src/template-installer.mjs';

test('installAgentTemplates writes a /new-project contract for Claude Code', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-init-'));
  await installAgentTemplates({ projectRoot, agent: 'claude-code' });
  const claudeMd = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf8');
  assert.match(claudeMd, /\/new-project/);
  assert.match(claudeMd, /pmc bootstrap/);
});
```

- [ ] **Step 2: Run the targeted test to verify it fails**

Run: `node --test tests/init.test.mjs`

Expected: FAIL because `src/template-installer.mjs` does not exist.

- [ ] **Step 3: Implement template installation and the init command**

`tools/project-memory-context/src/template-installer.mjs`

```js
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function renderTemplate(content, placeholders) {
  return Object.entries(placeholders).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
    content,
  );
}

export async function installAgentTemplates({ projectRoot, agent, packageRoot = join(process.cwd(), 'tools', 'project-memory-context') }) {
  const placeholders = {
    PMC_BIN: 'pmc',
    PROJECT_ROOT: projectRoot,
    AGENT_MEMORY_CMD: 'agent-memory-mcp',
    CONFIG_DIR: '.pmc',
  };
  if (agent === 'claude-code') {
    const source = join(packageRoot, 'templates', 'claude-code', 'CLAUDE.md.snippet');
    const content = renderTemplate(await readFile(source, 'utf8'), placeholders);
    await writeFile(join(projectRoot, 'CLAUDE.md'), content, 'utf8');
    return;
  }
  // implement opencode, cursor, and generic branches here
}
```

`tools/project-memory-context/cli/init.mjs`

```js
#!/usr/bin/env node
import { installAgentTemplates } from '../src/template-installer.mjs';

const agent = process.argv.includes('--agent')
  ? process.argv[process.argv.indexOf('--agent') + 1]
  : 'generic';

await installAgentTemplates({ projectRoot: process.cwd(), agent });
console.error(`[pmc:init] Installed PMC templates for ${agent}`);
```

Create these template snippets with the exact `/new-project` mapping:

`tools/project-memory-context/templates/claude-code/CLAUDE.md.snippet`

```md
# PMC Commands

When the user types `/new-project`, run:

```bash
pmc bootstrap . --all --enrich
```

When the user types `/sync-context`, process `.planning/project-memory-context/enrichment/sync-manifest.json` and upsert it into `agent-memory-mcp`.
```

`tools/project-memory-context/templates/opencode/commands/new-project.md`

```md
Bootstrap PMC in the current repo by running:

```bash
pmc bootstrap . --all --enrich
```
```

- [ ] **Step 4: Run the targeted test**

Run: `node --test tests/init.test.mjs`

Expected: PASS.

- [ ] **Step 5: Record completion**

Current workspace root is not a git repo. Do not commit here. Mark Task 7 complete in the plan checklist.

## Task 8: Add `pmc status`, preserve plugin compatibility, and deprecate legacy entry points

**Files:**
- Create: `tools/project-memory-context/cli/status.mjs`
- Modify: `tools/project-memory-context/src/plugin-config.mjs`
- Modify: `tools/project-memory-context/plugin/index.mjs`
- Modify: `tools/project-memory-context/cli/setup.mjs`
- Modify: `tools/project-memory-context/cli/install-pmc.mjs`
- Modify: `tools/project-memory-context/cli/enrich-batch.mjs`
- Modify: `tools/project-memory-context/cli/batch-enrich.mjs`
- Modify: `tools/project-memory-context/cli/enrich-orchestrator.mjs`
- Modify: `tools/project-memory-context/cli/enrich-sync.mjs`
- Test: `tools/project-memory-context/tests/status.test.mjs`
- Modify: `tools/project-memory-context/tests/plugin-config.test.mjs`

- [ ] **Step 1: Write the failing status and plugin tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildInjectedPmcConfig } from '../src/plugin-config.mjs';
import { summarizeWorklist } from '../cli/status.mjs';

test('summarizeWorklist counts pending, stale, and enriched entries', () => {
  const summary = summarizeWorklist([
    { status: 'pending' },
    { status: 'stale' },
    { status: 'enriched' },
  ]);
  assert.deepEqual(summary, { pending: 2, enriched: 1, errors: 0 });
});

test('buildInjectedPmcConfig points at the public agent-memory binary', () => {
  const injected = buildInjectedPmcConfig({ packageRoot: '/pmc', installState: { memoryDbPath: '/tmp/db', ollamaBaseUrl: 'http://localhost:11434', ollamaModel: 'deepseek-coder-v2:16b-ctx32k' } });
  assert.equal(injected.mcp['pmc-agent-memory'].command[0], 'agent-memory-mcp');
});
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `node --test tests/status.test.mjs tests/plugin-config.test.mjs`

Expected: FAIL because `cli/status.mjs` does not exist and `plugin-config.mjs` still points at `agent-memory-wrapper.mjs`.

- [ ] **Step 3: Implement `cli/status.mjs`, update plugin compatibility, and deprecate wrappers**

`tools/project-memory-context/cli/status.mjs`

```js
#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function summarizeWorklist(worklist) {
  return {
    pending: worklist.filter((entry) => entry.status === 'pending' || entry.status === 'stale').length,
    enriched: worklist.filter((entry) => entry.status === 'enriched' || entry.status === 'already_enriched').length,
    errors: worklist.filter((entry) => entry.status === 'error').length,
  };
}

const worklistPath = join(process.cwd(), '.planning', 'project-memory-context', 'enrichment', 'worklist.json');
const worklist = JSON.parse(await readFile(worklistPath, 'utf8'));
console.log(JSON.stringify(summarizeWorklist(worklist), null, 2));
```

`tools/project-memory-context/src/plugin-config.mjs`

```js
export function buildInjectedPmcConfig({ installState }) {
  return {
    mcp: {
      'pmc-agent-memory': {
        type: 'local',
        command: ['agent-memory-mcp'],
        enabled: true,
        environment: {
          MEMORY_DB_PATH: installState.memoryDbPath,
          EMBEDDING_MODEL: 'Xenova/bge-m3',
          EMBEDDING_DIMENSIONS: '1024',
          EMBEDDING_POOLING: 'cls',
        },
      },
    },
  };
}
```

Each deprecated CLI file should become a thin wrapper like this:

```js
#!/usr/bin/env node
console.error('[pmc] This command is deprecated. Use `pmc enrich` instead.');
process.exit(1);
```

- [ ] **Step 4: Run the targeted tests**

Run: `node --test tests/status.test.mjs tests/plugin-config.test.mjs`

Expected: PASS.

- [ ] **Step 5: Run the full PMC test suite**

Run: `node --test tests/*.test.mjs`

Expected: PASS, including the new platform/init/status/dispatch tests.

- [ ] **Step 6: Record completion**

Current workspace root is not a git repo. Do not commit here. Mark Task 8 complete in the plan checklist.

## Task 9: Final documentation and publish verification

**Files:**
- Modify: `tools/project-memory-context/README.md`
- Modify: `agent-memory-mcp/README.md`

- [ ] **Step 1: Add the publishable install instructions to both READMEs**

`tools/project-memory-context/README.md`

```md
## Install

```bash
npm install -g @brain/project-memory-context @brain/agent-memory-mcp
pip install graphifyy
```

## Quick start

```bash
pmc init --agent opencode
pmc bootstrap . --all --enrich
pmc status .
```
```

- [ ] **Step 2: Run dry-run package publication checks**

Run in `agent-memory-mcp/`: `npm pack --dry-run`

Expected: package tarball lists only `dist/`, `README.md`, `LICENSE`, `package.json`.

Run in `tools/project-memory-context/`: `npm pack --dry-run`

Expected: package tarball lists `bin/`, `src/`, `cli/`, `templates/`, `README.md`, `LICENSE`, `package.json`.

- [ ] **Step 3: Run end-to-end verification commands**

Run in `agent-memory-mcp/`: `npm test; if ($?) { npm run build }`

Expected: PASS.

Run in `tools/project-memory-context/`: `node --test tests/*.test.mjs`

Expected: PASS.

- [ ] **Step 4: Record completion**

Current workspace root is not a git repo. Do not commit here. Mark Task 9 complete in the plan checklist.

## Coverage Check

- Cross-platform process spawning: Task 3, Task 6
- graphify path resolution: Task 3, Task 5
- config dir abstraction (`.pmc`, `.opencode`, `.claude`, `.cursor`): Task 3, Task 4
- `/new-project` preserved across all agents: Task 5, Task 7
- single `pmc` CLI binary: Task 2
- `@brain/agent-memory-mcp` publication: Task 1
- plugin compatibility + deprecated wrappers: Task 8
- package publication validation: Task 9
