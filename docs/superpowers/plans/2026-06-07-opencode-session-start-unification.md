# OpenCode Session-Start Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace model-driven PMC startup checks in OpenCode with one shared zero-token Node runtime used by both `pmc session-start` and the OpenCode plugin.

**Architecture:** Add a focused runtime module under `tools/project-memory-context/src/` that owns startup state collection, background launch decisions, and snapshot persistence. Keep `tools/project-memory-context/cli/session-start.mjs` as a thin formatter wrapper and make `tools/project-memory-context/plugin/index.mjs` call the shared runtime silently during `config()`.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert/strict`, `node:fs/promises`, `node:path`, `node:url`, existing PMC CLI modules (`status.mjs`, `sync-manifest.mjs`), existing OpenCode plugin API (`config`, `tool.execute.after`).

---

## File Map

### New files

| File | Responsibility |
|------|----------------|
| `tools/project-memory-context/src/session-start-runtime.mjs` | Canonical session-start runtime: status gathering, overview loading, startup launch policy, snapshot persistence |
| `tools/project-memory-context/tests/session-start.test.mjs` | Runtime, CLI formatting, and OpenCode plugin-startup tests for the new shared startup flow |

### Modified files

| File | Change |
|------|--------|
| `tools/project-memory-context/cli/session-start.mjs` | Reduce to argument parsing, formatting, and delegating to the shared runtime |
| `tools/project-memory-context/plugin/index.mjs` | Call the shared runtime during plugin startup instead of only launching enrichment |
| `tools/project-memory-context/templates/opencode/autostart-snippet.md` | Describe actual OpenCode startup behavior and the manual fallback path |
| `tools/project-memory-context/README.md` | Document OpenCode startup runtime, snapshot paths, and detached-node vs PTY behavior |
| `tools/project-memory-context/tests/template-command-contract.test.mjs` | Lock the new OpenCode autostart wording and README startup wording |

### Existing files to re-run as regression checks

| File | Why rerun |
|------|-----------|
| `tools/project-memory-context/tests/opencode-refresh-hook.test.mjs` | Confirms the existing debounce refresh hook still works after plugin startup changes |
| `tools/project-memory-context/tests/plugin-config.test.mjs` | Confirms plugin config injection still works after plugin startup refactor |
| `tools/project-memory-context/tests/init.test.mjs` | Confirms template/install flows still reference `pmc session-start` where expected |

---

## Task 1: Add failing runtime tests, then implement the shared startup runtime

Build the new source-of-truth runtime first. Lock down two behaviors before wiring anything else: startup summaries are assembled from disk state, and enrichment/watchdog launch only when work is pending and the queue is not already running.

**Files:**
- Create: `tools/project-memory-context/tests/session-start.test.mjs`
- Create: `tools/project-memory-context/src/session-start-runtime.mjs`

- [ ] **Step 1: Write the failing runtime tests**

```javascript
// tools/project-memory-context/tests/session-start.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  getSessionStartSnapshotPaths,
  runSessionStartRuntime,
} from '../src/session-start-runtime.mjs';

async function createSessionStartFixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-session-start-'));
  const planningDir = join(projectRoot, '.planning', 'project-memory-context');
  const enrichmentDir = join(planningDir, 'enrichment');
  const materializedDir = join(planningDir, 'project-context', 'materialized');

  await mkdir(enrichmentDir, { recursive: true });
  await mkdir(materializedDir, { recursive: true });

  await writeFile(
    join(materializedDir, 'architecture-current.json'),
    JSON.stringify({ title: 'Architecture', summary: 'Layered pipeline with plugin startup.' }),
  );

  return { projectRoot, enrichmentDir, materializedDir };
}

test('runSessionStartRuntime writes latest snapshot files and returns materialized overview', async () => {
  const { projectRoot, enrichmentDir } = await createSessionStartFixture();

  await writeFile(
    join(enrichmentDir, 'sync-manifest.json'),
    JSON.stringify({ entries: [{ id: '1', status: 'pending', action: 'upsert' }] }),
  );

  const result = await runSessionStartRuntime(projectRoot, {
    buildStatusReport: async () => ({
      state: 'idle',
      worklist: { pending: 0, enriched: 12, errors: 0 },
      subagentQueue: { pending: 2 },
    }),
  });

  assert.equal(result.hasPmc, true);
  assert.equal(result.syncPending, 1);
  assert.equal(result.subagentPending, 2);
  assert.deepEqual(result.overview, [
    {
      kind: 'architecture-current',
      title: 'Architecture',
      summary: 'Layered pipeline with plugin startup.',
    },
  ]);

  const snapshotPaths = getSessionStartSnapshotPaths(projectRoot);
  const jsonSnapshot = JSON.parse(await readFile(snapshotPaths.jsonPath, 'utf8'));
  const markdownSnapshot = await readFile(snapshotPaths.markdownPath, 'utf8');

  assert.equal(jsonSnapshot.status.worklist.enriched, 12);
  assert.match(markdownSnapshot, /Layered pipeline with plugin startup\./);
  assert.match(markdownSnapshot, /run `\/sync-context` to persist to agent-memory/i);
});

test('runSessionStartRuntime launches enrichment and watchdog only when pending work is not already running', async () => {
  const { projectRoot } = await createSessionStartFixture();
  const spawns = [];

  const result = await runSessionStartRuntime(projectRoot, {
    buildStatusReport: async () => ({
      state: 'idle',
      worklist: { pending: 3, enriched: 9, errors: 0 },
      subagentQueue: { pending: 0 },
    }),
    spawnBackground: (command, args, options) => {
      spawns.push({ command, args, options });
      return 42;
    },
  });

  assert.equal(result.launch.launchedEnrichment, true);
  assert.equal(result.launch.launchedWatchdog, true);
  assert.equal(result.launch.backend, 'detached-node');
  assert.equal(spawns.length, 2);
  assert.match(spawns[0].args[0].replace(/\\/g, '/'), /enrich-queue\.mjs$/);
  assert.match(spawns[1].args[0].replace(/\\/g, '/'), /enrich-watchdog\.mjs$/);
});
```

- [ ] **Step 2: Run the new runtime test file and confirm it fails because the runtime module does not exist yet**

Run: `node --test tools/project-memory-context/tests/session-start.test.mjs`

Expected: FAIL with an import error for `../src/session-start-runtime.mjs`.

- [ ] **Step 3: Implement the shared runtime module**

```javascript
// tools/project-memory-context/src/session-start-runtime.mjs
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildStatusReport } from '../cli/status.mjs';
import { spawnBackground } from './platform.mjs';
import { readSyncManifest, getPendingEntries } from './sync-manifest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = join(__dirname, '..', 'cli');
const OVERVIEW_KINDS = [
  'architecture-current',
  'module-minimap',
  'structure-summary',
  'stack-runtime',
  'dependencies-summary',
];

async function readJsonSafe(filePath, readFileImpl = readFile) {
  try {
    return JSON.parse(await readFileImpl(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function getSessionStartSnapshotPaths(projectRoot) {
  const snapshotDir = join(
    projectRoot,
    '.planning',
    'project-memory-context',
    'runs',
    'session-start',
  );

  return {
    dir: snapshotDir,
    jsonPath: join(snapshotDir, 'latest.json'),
    markdownPath: join(snapshotDir, 'latest.md'),
  };
}

export async function loadMaterializedOverview(projectRoot, deps = {}) {
  const readFileImpl = deps.readFile ?? readFile;
  const materializedDir = join(
    projectRoot,
    '.planning',
    'project-memory-context',
    'project-context',
    'materialized',
  );

  const entries = [];
  for (const kind of OVERVIEW_KINDS) {
    const data = await readJsonSafe(join(materializedDir, `${kind}.json`), readFileImpl);
    if (data?.title && data?.summary) {
      entries.push({ kind, title: data.title, summary: data.summary });
    }
  }
  return entries;
}

export async function launchEnrichmentIfNeeded(projectRoot, status, deps = {}) {
  const pending = status.worklist?.pending ?? 0;
  if (pending <= 0 || status.state === 'running') {
    return {
      attempted: false,
      launchedEnrichment: false,
      launchedWatchdog: false,
      backend: 'detached-node',
    };
  }

  const spawnBackgroundImpl = deps.spawnBackground ?? spawnBackground;
  spawnBackgroundImpl(process.execPath, [join(CLI_DIR, 'enrich-queue.mjs'), projectRoot], {
    cwd: projectRoot,
  });
  spawnBackgroundImpl(process.execPath, [join(CLI_DIR, 'enrich-watchdog.mjs'), projectRoot], {
    cwd: projectRoot,
  });

  return {
    attempted: true,
    launchedEnrichment: true,
    launchedWatchdog: true,
    backend: 'detached-node',
  };
}

export function formatSessionStartSnapshotMarkdown(result) {
  const lines = [];
  const worklist = result.status.worklist;

  if (worklist) {
    const details = [];
    if (worklist.pending > 0) details.push(`${worklist.pending} pending`);
    if (worklist.errors > 0) details.push(`${worklist.errors} errors`);
    const suffix = details.length ? ` (${details.join(', ')})` : '';
    lines.push(`# PMC session-start snapshot`);
    lines.push('');
    lines.push(`- Queue state: ${result.status.state}`);
    lines.push(`- Enriched symbols: ${worklist.enriched}${suffix}`);
  }

  if (result.syncPending > 0) {
    lines.push(`- Sync: ${result.syncPending} pending; run \`/sync-context\` to persist to agent-memory.`);
  }

  if (result.subagentPending > 0) {
    lines.push(`- Subagent queue: ${result.subagentPending} pending`);
  }

  if (result.overview.length > 0) {
    lines.push('');
    lines.push('## Project context');
    lines.push('');
    for (const entry of result.overview) {
      lines.push(`- **${entry.title}:** ${entry.summary}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export async function writeSessionStartSnapshot(projectRoot, result, deps = {}) {
  const mkdirImpl = deps.mkdir ?? mkdir;
  const writeFileImpl = deps.writeFile ?? writeFile;
  const snapshotPaths = getSessionStartSnapshotPaths(projectRoot);

  await mkdirImpl(snapshotPaths.dir, { recursive: true });
  await writeFileImpl(snapshotPaths.jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await writeFileImpl(
    snapshotPaths.markdownPath,
    formatSessionStartSnapshotMarkdown(result),
    'utf8',
  );

  return snapshotPaths;
}

export async function runSessionStartRuntime(projectRoot = process.cwd(), deps = {}) {
  const root = resolve(projectRoot);
  const existsImpl = deps.existsSync ?? existsSync;
  const buildStatus = deps.buildStatusReport ?? buildStatusReport;
  const readSync = deps.readSyncManifest ?? readSyncManifest;
  const getPending = deps.getPendingEntries ?? getPendingEntries;
  const pmcDir = join(root, '.planning', 'project-memory-context');

  if (!existsImpl(pmcDir)) {
    return {
      hasPmc: false,
      projectRoot: root,
      status: null,
      launch: {
        attempted: false,
        launchedEnrichment: false,
        launchedWatchdog: false,
        backend: 'detached-node',
      },
      syncPending: 0,
      subagentPending: 0,
      overview: [],
      snapshot: null,
      warnings: [],
    };
  }

  const status = await buildStatus({ projectRoot: root });
  const overview = await loadMaterializedOverview(root, deps);
  const enrichmentDir = join(pmcDir, 'enrichment');

  let syncPending = 0;
  try {
    syncPending = getPending(await readSync(enrichmentDir)).length;
  } catch {
    syncPending = 0;
  }

  const launch = await launchEnrichmentIfNeeded(root, status, deps).catch(() => ({
    attempted: true,
    launchedEnrichment: false,
    launchedWatchdog: false,
    backend: 'detached-node',
  }));

  const result = {
    hasPmc: true,
    projectRoot: root,
    status,
    launch,
    syncPending,
    subagentPending: status.subagentQueue?.pending ?? 0,
    overview,
    snapshot: null,
    warnings: [],
  };

  try {
    const snapshot = await writeSessionStartSnapshot(root, result, deps);
    result.snapshot = snapshot;
  } catch {
    result.warnings.push('session-start snapshot write failed');
  }

  return result;
}
```

- [ ] **Step 4: Re-run the runtime tests and confirm they pass**

Run: `node --test tools/project-memory-context/tests/session-start.test.mjs`

Expected: PASS with 2 passing tests.

- [ ] **Step 5: Commit**

```bash
git add tools/project-memory-context/src/session-start-runtime.mjs tools/project-memory-context/tests/session-start.test.mjs
git commit -m "feat: add shared session-start runtime"
```

---

## Task 2: Refactor `pmc session-start` into a formatter wrapper and test both output modes

Once the runtime exists, move the CLI-specific concerns out of the shared logic. Keep `text` and `claude-code` output behavior stable while adding explicit test seams for stdout and runtime injection.

**Files:**
- Modify: `tools/project-memory-context/cli/session-start.mjs`
- Modify: `tools/project-memory-context/tests/session-start.test.mjs`

- [ ] **Step 1: Add failing CLI output tests to the new test file**

```javascript
// append to tools/project-memory-context/tests/session-start.test.mjs
import { runSessionStart } from '../cli/session-start.mjs';

test('runSessionStart prints text output using the shared runtime result', async () => {
  const writes = [];

  await runSessionStart(['C:/repo'], {
    stdout: { write: (chunk) => writes.push(chunk) },
    runSessionStartRuntime: async () => ({
      hasPmc: true,
      status: {
        state: 'idle',
        worklist: { pending: 2, enriched: 7, errors: 1 },
      },
      launch: {
        attempted: true,
        launchedEnrichment: true,
        launchedWatchdog: true,
        backend: 'detached-node',
      },
      syncPending: 3,
      subagentPending: 1,
      overview: [{ kind: 'architecture-current', title: 'Architecture', summary: 'Plugin startup runtime.' }],
      snapshot: null,
      warnings: [],
    }),
  });

  const output = writes.join('');
  assert.match(output, /\*\*PMC enrichment:\*\* 7 symbols enriched · 2 pending, 1 errors · queue: idle/);
  assert.match(output, /\*\*Launch:\*\* background enrich\/watchdog started via detached-node\./);
  assert.match(output, /\*\*Sync:\*\* 3 pending/);
  assert.match(output, /\*\*Architecture:\*\* Plugin startup runtime\./);
});

test('runSessionStart emits Claude Code hook payload when requested', async () => {
  const writes = [];

  await runSessionStart(['C:/repo', '--format=claude-code'], {
    stdout: { write: (chunk) => writes.push(chunk) },
    runSessionStartRuntime: async () => ({
      hasPmc: true,
      status: { state: 'idle', worklist: { pending: 0, enriched: 4, errors: 0 } },
      launch: { attempted: false, launchedEnrichment: false, launchedWatchdog: false, backend: 'detached-node' },
      syncPending: 0,
      subagentPending: 0,
      overview: [],
      snapshot: null,
      warnings: [],
    }),
  });

  const payload = JSON.parse(writes.join('').trim());
  assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(payload.hookSpecificOutput.additionalContext, /\*\*PMC enrichment:\*\* 4 symbols enriched/);
});
```

- [ ] **Step 2: Run the session-start test file and confirm it fails because the CLI has not been refactored yet**

Run: `node --test tools/project-memory-context/tests/session-start.test.mjs`

Expected: FAIL because `runSessionStart` does not accept runtime/stdout overrides and its output shape no longer matches the new test expectations.

- [ ] **Step 3: Refactor the CLI module to delegate to the shared runtime**

```javascript
#!/usr/bin/env node
// tools/project-memory-context/cli/session-start.mjs
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runSessionStartRuntime } from '../src/session-start-runtime.mjs';

function parseArgs(args) {
  const nonFlags = args.filter((arg) => !arg.startsWith('-'));
  const projectRoot = nonFlags[0] ? resolve(nonFlags[0]) : resolve(process.cwd());
  const formatArg = args.find((arg) => arg.startsWith('--format='));
  const format = formatArg ? formatArg.replace('--format=', '') : 'text';
  return { projectRoot, format };
}

export function formatSessionStartText(result) {
  const parts = [];
  const worklist = result.status?.worklist;

  if (worklist) {
    const details = [];
    if (worklist.pending > 0) details.push(`${worklist.pending} pending`);
    if (worklist.errors > 0) details.push(`${worklist.errors} errors`);
    const detailText = details.length ? ` · ${details.join(', ')}` : '';
    parts.push(`**PMC enrichment:** ${worklist.enriched} symbols enriched${detailText} · queue: ${result.status.state}`);
  } else {
    parts.push('**PMC:** no enrichment data (run `/map-project` to bootstrap)');
  }

  if (result.launch?.launchedEnrichment || result.launch?.launchedWatchdog) {
    parts.push(`**Launch:** background enrich/watchdog started via ${result.launch.backend}.`);
  }

  if (result.syncPending > 0) {
    parts.push(`**Sync:** ${result.syncPending} pending → run \`/sync-context\` to persist to agent-memory.`);
  }

  if (result.subagentPending > 0) {
    parts.push(`**Subagent queue:** ${result.subagentPending} large symbols need LLM enrichment → dispatch the \`enrich\` subagent.`);
  }

  if (result.overview.length > 0) {
    parts.push('');
    parts.push('## Project context');
    for (const entry of result.overview) {
      parts.push(`**${entry.title}:** ${entry.summary}`);
    }
  }

  if (result.warnings.length > 0) {
    parts.push('');
    for (const warning of result.warnings) {
      parts.push(`**Warning:** ${warning}`);
    }
  }

  parts.push('');
  parts.push('> **Workflow:** `pmc get-context <target>` BEFORE reading files · `pmc refresh-context --enrich` after changes.');
  return parts.join('\n');
}

export async function runSessionStart(args = process.argv.slice(2), deps = {}) {
  const { projectRoot, format } = parseArgs(args);
  const runRuntime = deps.runSessionStartRuntime ?? runSessionStartRuntime;
  const stdout = deps.stdout ?? process.stdout;

  const result = await runRuntime(projectRoot, deps);
  if (!result.hasPmc) return 0;

  const text = formatSessionStartText(result);
  if (format === 'claude-code') {
    stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: text,
      },
    }) + '\n');
  } else {
    stdout.write(text + '\n');
  }

  return 0;
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('Usage: pmc session-start [project-dir] [--format=<claude-code|text>]\n');
    return 0;
  }

  return runSessionStart(process.argv.slice(2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main().catch(() => 0);
  if (exitCode !== 0) process.exit(exitCode);
}
```

- [ ] **Step 4: Re-run the session-start tests and confirm the runtime plus CLI suite passes**

Run: `node --test tools/project-memory-context/tests/session-start.test.mjs`

Expected: PASS with 4 passing tests.

- [ ] **Step 5: Commit**

```bash
git add tools/project-memory-context/cli/session-start.mjs tools/project-memory-context/tests/session-start.test.mjs
git commit -m "refactor: share session-start runtime across cli"
```

---

## Task 3: Run the shared startup runtime from the OpenCode plugin and test the new startup path

Wire the plugin startup path to the same runtime used by the CLI. The plugin must remain silent and non-blocking, but it should now do the full deterministic startup work instead of only calling the enrichment launcher.

**Files:**
- Modify: `tools/project-memory-context/plugin/index.mjs`
- Modify: `tools/project-memory-context/tests/session-start.test.mjs`

- [ ] **Step 1: Add a failing plugin-startup integration test**

```javascript
// append to tools/project-memory-context/tests/session-start.test.mjs
import pluginFactory from '../plugin/index.mjs';

test('OpenCode plugin runs the shared session-start runtime during config()', async () => {
  const events = [];

  const plugin = await pluginFactory({
    directory: 'C:/repo',
    __testOverrides: {
      readInstallState: async () => ({ projectRoot: 'C:/repo', memoryDbPath: 'C:/repo/.planning/project-memory-context/memory.db' }),
      createController: () => ({
        rehydrate: async () => { events.push('rehydrate'); },
        onToolExecuteAfter: async () => {},
      }),
      runSessionStartRuntime: async (projectRoot, options) => {
        events.push(`runtime:${projectRoot}:${options.mode}`);
        return { hasPmc: true };
      },
    },
  });

  const cfg = {};
  await plugin.config(cfg);

  assert.equal(cfg.mcp['pmc-agent-memory'].enabled, true);
  assert.deepEqual(events, ['rehydrate', 'runtime:C:/repo:opencode-plugin']);
});
```

- [ ] **Step 2: Run the session-start test file and confirm the new plugin test fails**

Run: `node --test tools/project-memory-context/tests/session-start.test.mjs`

Expected: FAIL because the plugin still calls `launchEnrichmentIfNeeded()` and does not accept a `runSessionStartRuntime` test override.

- [ ] **Step 3: Refactor the plugin to call the shared runtime silently during startup**

```javascript
// tools/project-memory-context/plugin/index.mjs
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildInjectedPmcConfig } from '../src/plugin-config.mjs';
import { createOpencodeRefreshHookController } from '../src/opencode-refresh-hook.mjs';
import { runSessionStartRuntime } from '../src/session-start-runtime.mjs';

async function readInstallState(projectRoot) {
  try {
    return JSON.parse(await readFile(join(projectRoot, '.planning', 'project-memory-context', 'install.json'), 'utf8'));
  } catch {
    return null;
  }
}

export default async ({ directory, __testOverrides } = {}) => {
  const readState = __testOverrides?.readInstallState ?? readInstallState;
  const createController = __testOverrides?.createController ??
    ((projectRoot) => createOpencodeRefreshHookController({ projectRoot }));
  const runStartup = __testOverrides?.runSessionStartRuntime ?? runSessionStartRuntime;

  let controller = null;

  return {
    config: async (cfg) => {
      const installState = await readState(directory);
      if (!installState) return;

      const injected = buildInjectedPmcConfig({ installState });
      cfg.mcp = {
        ...(cfg.mcp ?? {}),
        ...injected.mcp,
      };

      controller = createController(directory, installState);
      await controller.rehydrate();

      try {
        await runStartup(directory, { mode: 'opencode-plugin' });
      } catch {
        // Silent by design: PMC startup must never block OpenCode startup.
      }
    },

    'tool.execute.after': async (input) => {
      if (!controller) return;
      await controller.onToolExecuteAfter(input);
    },
  };
};
```

- [ ] **Step 4: Re-run the startup and plugin tests and confirm they pass**

Run: `node --test tools/project-memory-context/tests/session-start.test.mjs tools/project-memory-context/tests/plugin-config.test.mjs tools/project-memory-context/tests/opencode-refresh-hook.test.mjs`

Expected: PASS; the new plugin-startup test passes and existing refresh-hook/plugin-config tests stay green.

- [ ] **Step 5: Commit**

```bash
git add tools/project-memory-context/plugin/index.mjs tools/project-memory-context/tests/session-start.test.mjs
git commit -m "feat: run session-start runtime from opencode plugin"
```

---

## Task 4: Align OpenCode docs/templates with real startup behavior and lock them with tests

The code path will now be correct; make the user-facing wording correct too. The OpenCode snippet must stop claiming a Claude Code style SessionStart hook, and the README must explain the plugin-driven startup runtime plus snapshot files.

**Files:**
- Modify: `tools/project-memory-context/templates/opencode/autostart-snippet.md`
- Modify: `tools/project-memory-context/README.md`
- Modify: `tools/project-memory-context/tests/template-command-contract.test.mjs`

- [ ] **Step 1: Add failing doc-contract assertions**

```javascript
// update tools/project-memory-context/tests/template-command-contract.test.mjs
test('agent snippets and setup docs do not reference copied local CLI paths', () => {
  const claude = readTemplate('claude-code/CLAUDE.md.snippet');
  const cursor = readTemplate('cursor/.cursorrules.snippet');
  const generic = readTemplate('generic/README-SETUP.md');
  const autostart = readTemplate('opencode/autostart-snippet.md');
  const antigravity = readTemplate('antigravity/autostart-snippet.md');

  // existing assertions unchanged above this point

  assert.match(autostart, /OpenCode plugin/);
  assert.match(autostart, /\{\{PMC_BIN\}\} session-start \./);
  assert.match(autostart, /latest\.(json|md)/);
  assert.doesNotMatch(autostart, /SessionStart hook configured/);
  assert.doesNotMatch(autostart, /additionalContext/);

  assert.match(antigravity, /\{\{PMC_BIN\}\} get-context/);
  assert.match(antigravity, /\{\{PMC_BIN\}\} refresh-context/);
  assert.match(antigravity, /\{\{PMC_BIN\}\} sync-context/);
});

test('README explains OpenCode plugin startup and snapshot paths', () => {
  const readme = readFileSync(join(packageRoot, 'README.md'), 'utf8');

  assert.match(readme, /OpenCode Session Startup/);
  assert.match(readme, /runs\/session-start\/latest\.json/);
  assert.match(readme, /detached Node child processes today, not PTY tools/);
});
```

- [ ] **Step 2: Run the doc-contract tests and confirm they fail against the old wording**

Run: `node --test tools/project-memory-context/tests/template-command-contract.test.mjs`

Expected: FAIL because the OpenCode snippet still talks about a SessionStart hook and `additionalContext`, and the README does not yet document startup snapshot paths.

- [ ] **Step 3: Update the OpenCode snippet and README wording**

````markdown
<!-- tools/project-memory-context/templates/opencode/autostart-snippet.md -->
<!-- pmc:autostart -->
## PMC Session Autostart

When PMC is installed as an OpenCode plugin, session initialization is executed by the plugin in a zero-token Node runtime during startup. The plugin reads PMC disk state, launches background enrichment/watchdog if needed, and writes the latest startup snapshot to `.planning/project-memory-context/runs/session-start/latest.json` and `.planning/project-memory-context/runs/session-start/latest.md`.

**If the PMC plugin is not installed or is disabled**, run this once per session:

```bash
{{PMC_BIN}} session-start .
```

Do not manually recreate startup checks in the chat if the plugin already handled startup.

This command handles everything deterministic in one shot:
- Checks enrichment status; launches background enrich + watchdog if needed
- Reports pending sync operations (run `/sync-context` to apply)
- Loads project context from materialized disk artifacts (no MCP round-trip)
- Reports if LLM subagent drain is needed

**If the session summary reports `subagentQueue.pending > 0`**, dispatch the `enrich` subagent to drain those entries — that is the only step that requires LLM involvement.

## Mandatory PMC Workflow (ENFORCED)

- **BEFORE reading any source file**: Run `{{PMC_BIN}} get-context <file-or-symbol>` FIRST. Do NOT open files with Read/Grep without first checking PMC context.
- **AFTER implementing code changes**: Run `{{PMC_BIN}} refresh-context --enrich` (refreshes graph incrementally, queues and launches enrichment) then `{{PMC_BIN}} sync-context` to persist new memories.
- **Default context depth**: Always use `depth=compact`. Use `extended` or `deep` ONLY when explicitly asked.
- **`map-project --all`** is only needed for full reinstall or ground-up graph rebuild. Day-to-day, `refresh-context` keeps everything current.
<!-- /pmc:autostart -->
````

```markdown
<!-- replace the startup portion of tools/project-memory-context/README.md -->
## OpenCode Session Startup

When PMC is installed as an OpenCode plugin, plugin startup runs the same shared Node runtime that powers `pmc session-start`. This happens outside the model context window and handles the deterministic startup work without spending chat tokens.

What it does:

- reads PMC disk state and materialized project-context summaries
- launches background `enrich-queue` plus `enrich-watchdog` when pending work exists
- writes the latest startup snapshot to `.planning/project-memory-context/runs/session-start/latest.json` and `.planning/project-memory-context/runs/session-start/latest.md`

Notes:

- startup uses detached Node child processes today, not PTY tools
- PTY is still recommended when an agent manually manages long-lived processes later in the session
- if the plugin is disabled, the manual fallback is `pmc session-start .`

---

## OpenCode Auto-Refresh Hook
```

- [ ] **Step 4: Re-run the doc-contract and startup regression tests**

Run: `node --test tools/project-memory-context/tests/template-command-contract.test.mjs tools/project-memory-context/tests/session-start.test.mjs tools/project-memory-context/tests/init.test.mjs`

Expected: PASS; the OpenCode snippet now reflects plugin startup, the README startup section is present, and the startup test suite remains green.

- [ ] **Step 5: Commit**

```bash
git add tools/project-memory-context/templates/opencode/autostart-snippet.md tools/project-memory-context/README.md tools/project-memory-context/tests/template-command-contract.test.mjs
git commit -m "docs: align opencode autostart with plugin startup"
```

---

## Spec Coverage Check

- Shared runtime extraction: Task 1
- CLI wrapper over shared runtime: Task 2
- OpenCode plugin startup uses shared runtime: Task 3
- Persisted latest snapshot files: Task 1
- OpenCode docs/snippet reflect real behavior: Task 4
- Detached-node backend explicitly documented, PTY deferred: Tasks 1 and 4
- Existing refresh hook preserved: Task 3 regression step includes `opencode-refresh-hook.test.mjs`

## Final Regression Command

After all four tasks are complete, run the full targeted suite once more before opening review:

Run: `node --test tools/project-memory-context/tests/session-start.test.mjs tools/project-memory-context/tests/opencode-refresh-hook.test.mjs tools/project-memory-context/tests/plugin-config.test.mjs tools/project-memory-context/tests/template-command-contract.test.mjs tools/project-memory-context/tests/init.test.mjs`

Expected: PASS across all listed test files.
