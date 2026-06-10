# OpenCode Autostart No Bloqueante — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OpenCode abre inmediatamente; el plugin PMC (auto-cargado desde `.opencode/plugins/`) despacha refresh-context, enrichment y un watcher FS con debounce de 5 min por archivo quieto — todo como procesos Node detached, 0 tokens.

**Architecture:** El plugin solo hace lecturas de disco y spawns detached vía `runSessionStartRuntime`. El watcher es un proceso detached con PID file + heartbeat (identidad por proyecto) que dispara `refreshContext({enrich:true})` in-process cuando hay archivos pendientes quietos ≥5 min. El hook `tool.execute.after` y `opencode-refresh-hook.mjs` se eliminan.

**Tech Stack:** Node ≥22.5.0, ESM `.mjs`, `node:test` + `node:assert/strict`, fixtures con `mkdtemp`. Sin frameworks nuevos.

**Spec:** `docs/superpowers/specs/2026-06-09-opencode-autostart-nonblocking-design.md`

**Working dir para tests:** `tools/project-memory-context/` (correr `node --test tests/<file>.test.mjs` desde ahí).

**Hechos verificados del codebase** (no re-derivar):
- `spawnBackground(command, args, { cwd })` en `src/platform.mjs:74` — `detached: true, stdio: 'ignore', shell: false`, retorna `pid`.
- `cli/refresh-context.mjs` exporta `refreshContext(projectRoot, options)` (línea 98) y como CLI acepta `node cli/refresh-context.mjs <root> --enrich` (parsea `process.argv.slice(2)`, guard de entrypoint en línea 248).
- `cli/enrich-queue.mjs` tiene `loadJson`/`saveJson`, escribe `queue-state.json` con `{ status, pid, startedAt, heartbeatAt, ... }` pero **no tiene guarda de instancia única** en `main()`.
- `src/session-start-runtime.mjs` define `CLI_DIR = join(__dirname, '..', 'cli')` — cuando el paquete está instalado global, eso ES el paquete global (requisito "correr desde paquete global" se cumple por construcción).
- `src/file-watcher.mjs` exporta `shouldWatch(filePath)` (ya ignora `.planning/`, `node_modules`, etc.).
- `installOpencode({ projectRoot, packageRoot, placeholders, globalConfigDir })` en `src/template-installer.mjs:115`.
- `src/plugin-config.mjs` exporta `buildInjectedPmcConfig({ installState })` con claves `pmc-query` y `pmc-agent-memory`.
- `cli/install-pmc.mjs` escribe `install.json` (`{ memoryDbPath, projectRoot, ... }`) ANTES de llamar al installer.
- OpenCode (verificado contra https://opencode.ai/docs/plugins/): auto-carga desde `.opencode/plugins/` (proyecto) y `~/.config/opencode/plugins/` (global); espera named export `async ({ project, client, $, directory, worktree }) => hooks`; el hook `config` NO existe.
- `package.json` exports actuales: `"."`, `"./platform"`, `"./retrieval"`. Bin: `pmc`.
- Dispatch: `['watch', 'cli/watch.mjs']` ya registrado en `src/command-dispatch.mjs`.
- `tests/session-start.test.mjs` importa `pluginFactory from '../plugin/index.mjs'` (default export) — habrá que actualizarlo.

---

### Task 1: `src/watcher-lifecycle.mjs` — PID file + heartbeat + identidad

**Files:**
- Create: `tools/project-memory-context/src/watcher-lifecycle.mjs`
- Test: `tools/project-memory-context/tests/watcher-lifecycle.test.mjs`

- [ ] **Step 1: Write the failing tests**

```javascript
// tools/project-memory-context/tests/watcher-lifecycle.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  WATCH_HEARTBEAT_INTERVAL_MS,
  WATCH_HEARTBEAT_STALE_MS,
  getWatchPidPath,
  isPidAlive,
  isWatcherAlive,
  readWatchPidRecord,
  removeWatchPidFile,
  writeWatchPidRecord,
} from '../src/watcher-lifecycle.mjs';

async function makeTempRoot() {
  return mkdtemp(join(tmpdir(), 'pmc-watch-lifecycle-'));
}

test('getWatchPidPath points inside .planning state dir', async () => {
  const root = await makeTempRoot();
  assert.equal(
    getWatchPidPath(root),
    join(root, '.planning', 'project-memory-context', 'state', 'watch.pid'),
  );
  await rm(root, { recursive: true, force: true });
});

test('writeWatchPidRecord + readWatchPidRecord round-trip', async () => {
  const root = await makeTempRoot();
  const record = {
    pid: 4242,
    projectRoot: resolve(root),
    startedAt: '2026-06-09T10:00:00.000Z',
    lastHeartbeat: '2026-06-09T10:05:00.000Z',
  };
  await writeWatchPidRecord(root, record);
  assert.deepEqual(await readWatchPidRecord(root), record);
  await rm(root, { recursive: true, force: true });
});

test('readWatchPidRecord returns null on missing or corrupt file', async () => {
  const root = await makeTempRoot();
  assert.equal(await readWatchPidRecord(root), null);
  await writeWatchPidRecord(root, { pid: 1, projectRoot: root, startedAt: 'x', lastHeartbeat: 'x' });
  // Corrupt it manually
  const { writeFile } = await import('node:fs/promises');
  await writeFile(getWatchPidPath(root), 'not-json', 'utf8');
  assert.equal(await readWatchPidRecord(root), null);
  await rm(root, { recursive: true, force: true });
});

test('removeWatchPidFile is idempotent', async () => {
  const root = await makeTempRoot();
  await removeWatchPidFile(root); // no file: must not throw
  await writeWatchPidRecord(root, { pid: 1, projectRoot: root, startedAt: 'x', lastHeartbeat: 'x' });
  await removeWatchPidFile(root);
  assert.equal(existsSync(getWatchPidPath(root)), false);
  await rm(root, { recursive: true, force: true });
});

test('isPidAlive: own pid alive, absurd pid dead, garbage input dead', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(999999999), false);
  assert.equal(isPidAlive(null), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(0), false);
});

test('isWatcherAlive: alive only when pid alive AND projectRoot matches AND heartbeat fresh', async () => {
  const root = await makeTempRoot();
  const nowMs = Date.parse('2026-06-09T10:00:00.000Z');
  const fresh = new Date(nowMs - 10_000).toISOString();
  const stale = new Date(nowMs - WATCH_HEARTBEAT_STALE_MS - 1).toISOString();
  const base = { pid: 4242, projectRoot: resolve(root), startedAt: fresh, lastHeartbeat: fresh };
  const aliveDeps = { now: nowMs, isPidAlive: () => true };

  assert.equal(isWatcherAlive(base, root, aliveDeps), true);
  // pid dead
  assert.equal(isWatcherAlive(base, root, { now: nowMs, isPidAlive: () => false }), false);
  // projectRoot mismatch (PID reuse by another project's watcher)
  assert.equal(isWatcherAlive({ ...base, projectRoot: join(root, 'other') }, root, aliveDeps), false);
  // heartbeat stale (hung watcher)
  assert.equal(isWatcherAlive({ ...base, lastHeartbeat: stale }, root, aliveDeps), false);
  // missing record
  assert.equal(isWatcherAlive(null, root, aliveDeps), false);
  // missing heartbeat field
  assert.equal(isWatcherAlive({ ...base, lastHeartbeat: undefined }, root, aliveDeps), false);
  await rm(root, { recursive: true, force: true });
});

test('heartbeat constants: 30s interval, 90s staleness (3x)', () => {
  assert.equal(WATCH_HEARTBEAT_INTERVAL_MS, 30_000);
  assert.equal(WATCH_HEARTBEAT_STALE_MS, 90_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/project-memory-context && node --test tests/watcher-lifecycle.test.mjs`
Expected: FAIL — `Cannot find module '../src/watcher-lifecycle.mjs'`

- [ ] **Step 3: Write the implementation**

```javascript
// tools/project-memory-context/src/watcher-lifecycle.mjs
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const WATCH_HEARTBEAT_INTERVAL_MS = 30_000;
export const WATCH_HEARTBEAT_STALE_MS = WATCH_HEARTBEAT_INTERVAL_MS * 3;

export function getWatchStateDir(projectRoot) {
  return join(projectRoot, '.planning', 'project-memory-context', 'state');
}

export function getWatchPidPath(projectRoot) {
  return join(getWatchStateDir(projectRoot), 'watch.pid');
}

// PID-alive check. EPERM means the process exists but is owned by someone else
// — that still counts as alive.
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export async function readWatchPidRecord(projectRoot, deps = {}) {
  const readFileImpl = deps.readFile ?? readFile;
  try {
    const parsed = JSON.parse(await readFileImpl(getWatchPidPath(projectRoot), 'utf8'));
    if (!Number.isInteger(parsed?.pid)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeWatchPidRecord(projectRoot, record, deps = {}) {
  const mkdirImpl = deps.mkdir ?? mkdir;
  const writeFileImpl = deps.writeFile ?? writeFile;
  const pidPath = getWatchPidPath(projectRoot);
  await mkdirImpl(dirname(pidPath), { recursive: true });
  await writeFileImpl(pidPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export async function removeWatchPidFile(projectRoot, deps = {}) {
  const rmImpl = deps.rm ?? rm;
  await rmImpl(getWatchPidPath(projectRoot), { force: true });
}

// "Alive" requires all three: live PID, matching projectRoot, fresh heartbeat.
// Anything else is stale — covers PID reuse by the OS and hung watchers.
export function isWatcherAlive(record, projectRoot, deps = {}) {
  const nowMs = deps.now ?? Date.now();
  const pidAlive = deps.isPidAlive ?? isPidAlive;

  if (!record) return false;
  if (resolve(String(record.projectRoot ?? '')) !== resolve(projectRoot)) return false;
  if (!pidAlive(record.pid)) return false;

  const heartbeatMs = Date.parse(record.lastHeartbeat ?? '');
  if (!Number.isFinite(heartbeatMs)) return false;
  return nowMs - heartbeatMs <= WATCH_HEARTBEAT_STALE_MS;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/project-memory-context && node --test tests/watcher-lifecycle.test.mjs`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/project-memory-context/src/watcher-lifecycle.mjs tools/project-memory-context/tests/watcher-lifecycle.test.mjs
git commit -m "feat(watch): add PID file lifecycle with heartbeat-based identity"
```

---

### Task 2: `src/watch-debounce.mjs` — mapa de archivos pendientes + quiet partition

**Files:**
- Create: `tools/project-memory-context/src/watch-debounce.mjs`
- Test: `tools/project-memory-context/tests/watch-debounce.test.mjs`

- [ ] **Step 1: Write the failing tests**

```javascript
// tools/project-memory-context/tests/watch-debounce.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  WATCH_QUIET_MS,
  getWatchPendingPath,
  partitionQuiet,
  readWatchPending,
  recordChange,
  writeWatchPending,
} from '../src/watch-debounce.mjs';

test('WATCH_QUIET_MS is 5 minutes', () => {
  assert.equal(WATCH_QUIET_MS, 5 * 60 * 1000);
});

test('recordChange adds and updates timestamps immutably', () => {
  const p1 = recordChange({}, 'src/a.mjs', 1000);
  const p2 = recordChange(p1, 'src/b.mjs', 2000);
  const p3 = recordChange(p2, 'src/a.mjs', 3000);
  assert.deepEqual(p1, { 'src/a.mjs': 1000 });
  assert.deepEqual(p3, { 'src/a.mjs': 3000, 'src/b.mjs': 2000 });
  // immutability
  assert.deepEqual(p2, { 'src/a.mjs': 1000, 'src/b.mjs': 2000 });
});

test('partitionQuiet separates files quiet >= quietMs from hot files', () => {
  const now = 10 * 60 * 1000; // t=10min
  const pending = {
    'src/quiet.mjs': now - WATCH_QUIET_MS,       // exactly 5min quiet → quiet
    'src/older.mjs': now - WATCH_QUIET_MS - 1,   // >5min quiet → quiet
    'src/hot.mjs': now - 1000,                   // 1s ago → hot
  };
  const { quiet, hot } = partitionQuiet(pending, now);
  assert.deepEqual(
    quiet.sort((a, b) => a[0].localeCompare(b[0])),
    [['src/older.mjs', now - WATCH_QUIET_MS - 1], ['src/quiet.mjs', now - WATCH_QUIET_MS]],
  );
  assert.deepEqual(hot, { 'src/hot.mjs': now - 1000 });
});

test('partitionQuiet with empty pending returns empty results', () => {
  const { quiet, hot } = partitionQuiet({}, 12345);
  assert.deepEqual(quiet, []);
  assert.deepEqual(hot, {});
});

test('writeWatchPending + readWatchPending round-trip; read tolerates missing/corrupt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-watch-debounce-'));
  assert.deepEqual(await readWatchPending(root), {});
  await writeWatchPending(root, { 'src/a.mjs': 111 });
  assert.deepEqual(await readWatchPending(root), { 'src/a.mjs': 111 });
  await writeFile(getWatchPendingPath(root), '{broken', 'utf8');
  assert.deepEqual(await readWatchPending(root), {});
  await rm(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/project-memory-context && node --test tests/watch-debounce.test.mjs`
Expected: FAIL — `Cannot find module '../src/watch-debounce.mjs'`

- [ ] **Step 3: Write the implementation**

```javascript
// tools/project-memory-context/src/watch-debounce.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const WATCH_QUIET_MS = 5 * 60 * 1000;

export function getWatchPendingPath(projectRoot) {
  return join(projectRoot, '.planning', 'project-memory-context', 'state', 'watch-pending.json');
}

export function recordChange(pending, filePath, nowMs) {
  return { ...pending, [filePath]: nowMs };
}

// Splits pending into files quiet for >= quietMs (ready to refresh) and files
// still hot (recently touched — kept for the next tick). `quiet` keeps the
// timestamps so the caller can detect re-modification during a refresh run.
export function partitionQuiet(pending, nowMs, quietMs = WATCH_QUIET_MS) {
  const quiet = [];
  const hot = {};
  for (const [filePath, changedAt] of Object.entries(pending)) {
    if (nowMs - changedAt >= quietMs) {
      quiet.push([filePath, changedAt]);
    } else {
      hot[filePath] = changedAt;
    }
  }
  return { quiet, hot };
}

export async function readWatchPending(projectRoot, deps = {}) {
  const readFileImpl = deps.readFile ?? readFile;
  try {
    const parsed = JSON.parse(await readFileImpl(getWatchPendingPath(projectRoot), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    return {};
  }
}

export async function writeWatchPending(projectRoot, pending, deps = {}) {
  const mkdirImpl = deps.mkdir ?? mkdir;
  const writeFileImpl = deps.writeFile ?? writeFile;
  const pendingPath = getWatchPendingPath(projectRoot);
  await mkdirImpl(dirname(pendingPath), { recursive: true });
  await writeFileImpl(pendingPath, `${JSON.stringify(pending, null, 2)}\n`, 'utf8');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/project-memory-context && node --test tests/watch-debounce.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/project-memory-context/src/watch-debounce.mjs tools/project-memory-context/tests/watch-debounce.test.mjs
git commit -m "feat(watch): add per-file quiet-period debounce state"
```

---

### Task 3: Reescribir `cli/watch.mjs` — runtime testeable + flags `--detach/--stop/--status`

**Files:**
- Modify: `tools/project-memory-context/cli/watch.mjs` (reescritura completa)
- Test: `tools/project-memory-context/tests/watch-runtime.test.mjs` (nuevo)

- [ ] **Step 1: Write the failing tests**

```javascript
// tools/project-memory-context/tests/watch-runtime.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { createWatchRuntime } from '../cli/watch.mjs';
import { readWatchPidRecord } from '../src/watcher-lifecycle.mjs';
import { readWatchPending } from '../src/watch-debounce.mjs';

const QUIET = 5 * 60 * 1000;

async function makeRuntime({ nowMs, refreshCalls }) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-watch-runtime-'));
  const clock = { value: nowMs };
  const runtime = createWatchRuntime({
    projectRoot,
    startedAt: new Date(nowMs).toISOString(),
    deps: {
      now: () => clock.value,
      pid: 7777,
      refreshContext: async (root, options) => {
        refreshCalls.push({ root, options });
      },
    },
  });
  return { projectRoot, clock, runtime };
}

test('onFsEvent records watched files and persists pending; ignores unwatched', async () => {
  const refreshCalls = [];
  const { projectRoot, runtime } = await makeRuntime({ nowMs: 1_000_000, refreshCalls });

  await runtime.onFsEvent('src/foo.mjs');
  await runtime.onFsEvent('node_modules/x/y.mjs'); // ignored by shouldWatch
  await runtime.onFsEvent('README.txt');            // not a watched extension
  await runtime.onFsEvent(null);                    // fs.watch can emit null

  assert.deepEqual(runtime.getPending(), { 'src/foo.mjs': 1_000_000 });
  assert.deepEqual(await readWatchPending(projectRoot), { 'src/foo.mjs': 1_000_000 });
  await rm(projectRoot, { recursive: true, force: true });
});

test('tick writes heartbeat to pid record even with nothing pending', async () => {
  const refreshCalls = [];
  const { projectRoot, clock, runtime } = await makeRuntime({ nowMs: 1_000_000, refreshCalls });

  const result = await runtime.tick();
  assert.equal(result.refreshed, false);

  const record = await readWatchPidRecord(projectRoot);
  assert.equal(record.pid, 7777);
  assert.equal(resolve(record.projectRoot), resolve(projectRoot));
  assert.equal(record.lastHeartbeat, new Date(clock.value).toISOString());
  assert.equal(refreshCalls.length, 0);
  await rm(projectRoot, { recursive: true, force: true });
});

test('tick triggers refresh only when a pending file has been quiet >= 5min', async () => {
  const refreshCalls = [];
  const { projectRoot, clock, runtime } = await makeRuntime({ nowMs: 1_000_000, refreshCalls });

  await runtime.onFsEvent('src/foo.mjs'); // changed at t=1,000,000
  clock.value += QUIET - 1;
  assert.equal((await runtime.tick()).refreshed, false); // 1ms early

  clock.value += 1;
  const result = await runtime.tick();
  assert.equal(result.refreshed, true);
  assert.equal(refreshCalls.length, 1);
  assert.deepEqual(refreshCalls[0].options, { enrich: true });
  // quiet file consumed
  assert.deepEqual(runtime.getPending(), {});
  assert.deepEqual(await readWatchPending(projectRoot), {});
  await rm(projectRoot, { recursive: true, force: true });
});

test('hot file does not block quiet file, stays pending for next cycle', async () => {
  const refreshCalls = [];
  const { projectRoot, clock, runtime } = await makeRuntime({ nowMs: 1_000_000, refreshCalls });

  await runtime.onFsEvent('src/quiet.mjs');
  clock.value += QUIET - 30_000;
  await runtime.onFsEvent('src/hot.mjs'); // touched 30s before quiet.mjs matures
  clock.value += 30_000;

  const result = await runtime.tick();
  assert.equal(result.refreshed, true);
  // hot.mjs survives, quiet.mjs consumed
  assert.deepEqual(Object.keys(runtime.getPending()), ['src/hot.mjs']);
  await rm(projectRoot, { recursive: true, force: true });
});

test('file re-modified while refresh runs is NOT consumed', async () => {
  const refreshCalls = [];
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-watch-runtime-'));
  const clock = { value: 1_000_000 };
  let runtimeRef;
  const runtime = createWatchRuntime({
    projectRoot,
    startedAt: new Date(clock.value).toISOString(),
    deps: {
      now: () => clock.value,
      pid: 7777,
      refreshContext: async () => {
        // Simulate a re-modification arriving mid-refresh
        clock.value += 1000;
        await runtimeRef.onFsEvent('src/foo.mjs');
      },
    },
  });
  runtimeRef = runtime;

  await runtime.onFsEvent('src/foo.mjs');
  clock.value += QUIET;
  const result = await runtime.tick();
  assert.equal(result.refreshed, true);
  // foo.mjs was re-touched during refresh → must remain pending with new timestamp
  assert.deepEqual(Object.keys(runtime.getPending()), ['src/foo.mjs']);
  await rm(projectRoot, { recursive: true, force: true });
});

test('tick never overlaps refreshes and refresh errors keep pending intact', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-watch-runtime-'));
  const clock = { value: 1_000_000 };
  let resolveRefresh;
  let calls = 0;
  const runtime = createWatchRuntime({
    projectRoot,
    startedAt: new Date(clock.value).toISOString(),
    deps: {
      now: () => clock.value,
      pid: 7777,
      refreshContext: () => {
        calls += 1;
        return new Promise((res) => { resolveRefresh = res; });
      },
    },
  });

  await runtime.onFsEvent('src/foo.mjs');
  clock.value += QUIET;
  const first = runtime.tick();           // starts refresh, stays in-flight
  const second = await runtime.tick();    // must skip: refresh in progress
  assert.equal(second.refreshed, false);
  assert.equal(calls, 1);
  resolveRefresh();
  await first;

  // Error path: failing refresh leaves pending for retry on next tick
  const refreshCalls = [];
  const failing = createWatchRuntime({
    projectRoot,
    startedAt: new Date(clock.value).toISOString(),
    deps: {
      now: () => clock.value,
      pid: 7777,
      refreshContext: async () => { refreshCalls.push(1); throw new Error('boom'); },
    },
  });
  await failing.onFsEvent('src/bar.mjs');
  clock.value += QUIET;
  const result = await failing.tick();
  assert.equal(result.refreshed, false);
  assert.equal(refreshCalls.length, 1);
  assert.deepEqual(Object.keys(failing.getPending()), ['src/bar.mjs']);
  await rm(projectRoot, { recursive: true, force: true });
});

test('setPending seeds inherited pending from a previous run', async () => {
  const refreshCalls = [];
  const { projectRoot, clock, runtime } = await makeRuntime({ nowMs: 1_000_000, refreshCalls });
  runtime.setPending({ 'src/old.mjs': 1_000_000 - QUIET });
  const result = await runtime.tick();
  assert.equal(result.refreshed, true);
  assert.equal(refreshCalls.length, 1);
  await rm(projectRoot, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/project-memory-context && node --test tests/watch-runtime.test.mjs`
Expected: FAIL — `createWatchRuntime` is not exported. **Nota:** el `watch.mjs` actual ejecuta `main()` al importarse — el primer fallo puede ser que el test se cuelga o arranca un watcher real. La reescritura del Step 3 arregla ambas cosas (entrypoint guard).

- [ ] **Step 3: Rewrite `cli/watch.mjs`**

Contenido completo del archivo (reemplaza todo):

```javascript
// tools/project-memory-context/cli/watch.mjs
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watch } from 'node:fs';

import { shouldWatch } from '../src/file-watcher.mjs';
import { refreshContext } from './refresh-context.mjs';
import { spawnBackground } from '../src/platform.mjs';
import {
  WATCH_HEARTBEAT_INTERVAL_MS,
  isPidAlive,
  isWatcherAlive,
  readWatchPidRecord,
  removeWatchPidFile,
  writeWatchPidRecord,
} from '../src/watcher-lifecycle.mjs';
import {
  WATCH_QUIET_MS,
  partitionQuiet,
  readWatchPending,
  recordChange,
  writeWatchPending,
} from '../src/watch-debounce.mjs';

function log(msg) { console.error(`[watch] ${msg}`); }

export function createWatchRuntime({ projectRoot, startedAt, quietMs = WATCH_QUIET_MS, deps = {} }) {
  const runRefresh = deps.refreshContext ?? refreshContext;
  const now = deps.now ?? Date.now;
  const pid = deps.pid ?? process.pid;

  let pending = {};
  let refreshRunning = false;

  async function persistPending() {
    try {
      await writeWatchPending(projectRoot, pending, deps);
    } catch (err) {
      log(`pending persist failed: ${err.message}`);
    }
  }

  return {
    getPending: () => ({ ...pending }),
    setPending: (value) => { pending = { ...value }; },

    async onFsEvent(filename) {
      if (!filename || !shouldWatch(String(filename))) return;
      pending = recordChange(pending, String(filename).replace(/\\/g, '/'), now());
      await persistPending();
    },

    async tick() {
      // Heartbeat first: proves liveness even when there is nothing to do.
      try {
        await writeWatchPidRecord(projectRoot, {
          pid,
          projectRoot: resolve(projectRoot),
          startedAt,
          lastHeartbeat: new Date(now()).toISOString(),
        }, deps);
      } catch (err) {
        log(`heartbeat write failed: ${err.message}`);
      }

      if (refreshRunning) return { refreshed: false, reason: 'refresh-in-progress' };

      const { quiet } = partitionQuiet(pending, now(), quietMs);
      if (quiet.length === 0) return { refreshed: false, reason: 'no-quiet-files' };

      refreshRunning = true;
      try {
        log(`${quiet.length} quiet file(s) — running refresh-context --enrich...`);
        await runRefresh(projectRoot, { enrich: true });
        // Consume only files NOT re-modified while the refresh was running.
        for (const [filePath, changedAt] of quiet) {
          if (pending[filePath] === changedAt) {
            const { [filePath]: _removed, ...rest } = pending;
            pending = rest;
          }
        }
        await persistPending();
        return { refreshed: true, quietCount: quiet.length };
      } catch (err) {
        log(`refresh-context error: ${err.message}`);
        return { refreshed: false, reason: 'refresh-error' };
      } finally {
        refreshRunning = false;
      }
    },
  };
}

async function statusCommand(projectRoot) {
  const record = await readWatchPidRecord(projectRoot);
  const alive = isWatcherAlive(record, projectRoot);
  const pendingFiles = Object.keys(await readWatchPending(projectRoot)).length;
  console.log(JSON.stringify({
    alive,
    pid: record?.pid ?? null,
    startedAt: record?.startedAt ?? null,
    lastHeartbeat: record?.lastHeartbeat ?? null,
    pendingFiles,
  }, null, 2));
}

async function stopCommand(projectRoot) {
  const record = await readWatchPidRecord(projectRoot);
  if (!record || !isPidAlive(record.pid)) {
    log('No running watcher found.');
    await removeWatchPidFile(projectRoot);
    return;
  }
  try {
    process.kill(record.pid);
    log(`Stopped watcher (pid ${record.pid}).`);
  } catch (err) {
    log(`Failed to stop watcher (pid ${record.pid}): ${err.message}`);
    process.exitCode = 1;
    return;
  }
  await removeWatchPidFile(projectRoot);
}

async function detachCommand(projectRoot) {
  const existing = await readWatchPidRecord(projectRoot);
  if (isWatcherAlive(existing, projectRoot)) {
    log(`Watcher already running (pid ${existing.pid}).`);
    return;
  }
  await removeWatchPidFile(projectRoot);
  spawnBackground(process.execPath, [fileURLToPath(import.meta.url), projectRoot], { cwd: projectRoot });

  // Confirm startup: poll the pid file for up to 5s.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 200));
    const record = await readWatchPidRecord(projectRoot);
    if (record && isPidAlive(record.pid)) {
      log(`Watcher started in background (pid ${record.pid}).`);
      return;
    }
  }
  log('Watcher failed to start within 5s.');
  process.exitCode = 1;
}

async function runForeground(projectRoot) {
  const existing = await readWatchPidRecord(projectRoot);
  if (isWatcherAlive(existing, projectRoot)) {
    log(`Watcher already running (pid ${existing.pid}). Exiting.`);
    return;
  }
  await removeWatchPidFile(projectRoot);

  const startedAt = new Date().toISOString();
  const runtime = createWatchRuntime({ projectRoot, startedAt });
  runtime.setPending(await readWatchPending(projectRoot));

  // First tick writes the pid file immediately and evaluates inherited pending.
  await runtime.tick();

  const watcher = watch(projectRoot, { recursive: true }, (eventType, filename) => {
    runtime.onFsEvent(filename).catch(() => {});
  });
  watcher.on('error', (err) => log(`Watcher error: ${err.message}`));

  const interval = setInterval(() => {
    runtime.tick().catch((err) => log(`tick error: ${err.message}`));
  }, WATCH_HEARTBEAT_INTERVAL_MS);

  const shutdown = () => {
    clearInterval(interval);
    watcher.close();
    removeWatchPidFile(projectRoot).finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log(`Watching ${projectRoot} (quiet period: ${WATCH_QUIET_MS / 60000}min, tick: ${WATCH_HEARTBEAT_INTERVAL_MS / 1000}s).`);
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const projectRoot = resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd());

  if (flags.has('--status')) return statusCommand(projectRoot);
  if (flags.has('--stop')) return stopCommand(projectRoot);
  if (flags.has('--detach')) return detachCommand(projectRoot);
  return runForeground(projectRoot);
}

// Entrypoint guard: importing this module (tests, session-start) must NOT start a watcher.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[watch] FATAL:', err.message);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/project-memory-context && node --test tests/watch-runtime.test.mjs`
Expected: PASS (7 tests)

- [ ] **Step 5: Smoke-test the flags manually**

Run: `cd tools/project-memory-context && node cli/watch.mjs . --status`
Expected: JSON con `"alive": false` (o `true` si quedó un watcher previo).

- [ ] **Step 6: Commit**

```bash
git add tools/project-memory-context/cli/watch.mjs tools/project-memory-context/tests/watch-runtime.test.mjs
git commit -m "feat(watch): rewrite with lifecycle flags and 5min per-file quiet debounce"
```

---

### Task 4: Guarda de instancia única en `cli/enrich-queue.mjs`

**Files:**
- Modify: `tools/project-memory-context/cli/enrich-queue.mjs` (función `main()`, ~línea 504; agregar export nuevo)
- Test: `tools/project-memory-context/tests/enrich-queue-guard.test.mjs` (nuevo)

- [ ] **Step 1: Write the failing test**

```javascript
// tools/project-memory-context/tests/enrich-queue-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { QUEUE_GUARD_STALE_MS, shouldSkipQueueStart } from '../cli/enrich-queue.mjs';

const NOW = Date.parse('2026-06-09T10:00:00.000Z');
const fresh = new Date(NOW - 10_000).toISOString();
const stale = new Date(NOW - QUEUE_GUARD_STALE_MS - 1).toISOString();

function opts(overrides = {}) {
  return { now: NOW, selfPid: 100, isPidAlive: () => true, ...overrides };
}

test('skips start when another live queue is running with fresh heartbeat', () => {
  const state = { status: 'running', pid: 200, heartbeatAt: fresh };
  assert.equal(shouldSkipQueueStart(state, opts()), true);
});

test('does not skip when no state, not running, own pid, dead pid, or stale heartbeat', () => {
  assert.equal(shouldSkipQueueStart(null, opts()), false);
  assert.equal(shouldSkipQueueStart({ status: 'finished', pid: 200, heartbeatAt: fresh }, opts()), false);
  assert.equal(shouldSkipQueueStart({ status: 'running', pid: 100, heartbeatAt: fresh }, opts()), false);
  assert.equal(
    shouldSkipQueueStart({ status: 'running', pid: 200, heartbeatAt: fresh }, opts({ isPidAlive: () => false })),
    false,
  );
  assert.equal(shouldSkipQueueStart({ status: 'running', pid: 200, heartbeatAt: stale }, opts()), false);
  assert.equal(shouldSkipQueueStart({ status: 'running', pid: 200 }, opts()), false); // missing heartbeat
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/project-memory-context && node --test tests/enrich-queue-guard.test.mjs`
Expected: FAIL — `shouldSkipQueueStart` no exportado.

- [ ] **Step 3: Implement the guard**

En `cli/enrich-queue.mjs`, agregar import arriba (junto a los demás imports):

```javascript
import { isPidAlive } from '../src/watcher-lifecycle.mjs';
```

Agregar cerca de `buildQueueState` (después de los process handlers, antes de `main()`):

```javascript
// Conservative staleness window: an enrichment heartbeat older than this means
// the previous queue is presumed dead and a new one may start.
export const QUEUE_GUARD_STALE_MS = 5 * 60 * 1000;

export function shouldSkipQueueStart(queueState, { now = Date.now(), selfPid = process.pid, isPidAlive: pidAlive = isPidAlive } = {}) {
  if (!queueState || queueState.status !== 'running') return false;
  if (queueState.pid === selfPid) return false;
  if (!pidAlive(queueState.pid)) return false;
  const heartbeatMs = Date.parse(queueState.heartbeatAt ?? '');
  if (!Number.isFinite(heartbeatMs)) return false;
  return now - heartbeatMs <= QUEUE_GUARD_STALE_MS;
}
```

Dentro de `main()`: la línea `const queueStateFile = resolve(enrichmentDir, 'queue-state.json');` (~531) y `_queueStateFile = queueStateFile;` se mueven arriba, inmediatamente después de `const symbolIndexFile = resolve(enrichmentDir, 'symbol-index.json');`, y a continuación se agrega:

```javascript
  let existingQueueState = null;
  try { existingQueueState = await loadJson(queueStateFile); } catch {}
  if (shouldSkipQueueStart(existingQueueState)) {
    console.error(`[queue] Another enrichment queue is already running (pid ${existingQueueState.pid}); exiting.`);
    return;
  }
```

(Eliminar la declaración duplicada original de `queueStateFile`/`_queueStateFile` más abajo.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/project-memory-context && node --test tests/enrich-queue-guard.test.mjs tests/enrich-queue-driver.test.mjs tests/enrich-queue-routing.test.mjs`
Expected: PASS — el guard nuevo y los tests existentes de enrich-queue siguen verdes.

- [ ] **Step 5: Commit**

```bash
git add tools/project-memory-context/cli/enrich-queue.mjs tools/project-memory-context/tests/enrich-queue-guard.test.mjs
git commit -m "feat(enrich): single-instance guard for queue startup"
```

---

### Task 5: `session-start-runtime` — `launchRefreshContext` + `launchWatcherIfNeeded`

**Files:**
- Modify: `tools/project-memory-context/src/session-start-runtime.mjs`
- Test: `tools/project-memory-context/tests/session-start.test.mjs` (agregar tests)

- [ ] **Step 1: Write the failing tests** (agregar al final de `tests/session-start.test.mjs`)

```javascript
import {
  launchRefreshContext,
  launchWatcherIfNeeded,
} from '../src/session-start-runtime.mjs';
import { writeWatchPidRecord } from '../src/watcher-lifecycle.mjs';

test('launchRefreshContext spawns detached refresh-context --enrich from package cli dir', () => {
  const spawns = [];
  const result = launchRefreshContext('/proj', {
    spawnBackground: (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return 111; },
  });
  assert.equal(result.launchedRefresh, true);
  assert.equal(result.backend, 'detached-node');
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].cmd, process.execPath);
  assert.match(spawns[0].args[0].replace(/\\/g, '/'), /cli\/refresh-context\.mjs$/);
  assert.equal(spawns[0].args[1], '/proj');
  assert.equal(spawns[0].args[2], '--enrich');
  assert.equal(spawns[0].opts.cwd, '/proj');
});

test('launchWatcherIfNeeded spawns watcher when none alive, skips when alive', async () => {
  const { projectRoot } = await createSessionStartFixture();

  const spawns = [];
  const first = await launchWatcherIfNeeded(projectRoot, {
    spawnBackground: (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return 222; },
  });
  assert.equal(first.launchedWatcher, true);
  assert.equal(first.watcherPid, 222);
  assert.match(spawns[0].args[0].replace(/\\/g, '/'), /cli\/watch\.mjs$/);

  // Simulate a live watcher: fresh heartbeat + matching root + alive pid
  await writeWatchPidRecord(projectRoot, {
    pid: process.pid,
    projectRoot,
    startedAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
  });
  const second = await launchWatcherIfNeeded(projectRoot, {
    spawnBackground: () => { throw new Error('must not spawn'); },
  });
  assert.equal(second.launchedWatcher, false);
  assert.equal(second.watcherPid, process.pid);
});

test('runSessionStartRuntime includes refresh and watcher launch results in snapshot', async () => {
  const { projectRoot } = await createSessionStartFixture();
  const spawned = [];
  const result = await runSessionStartRuntime(projectRoot, {
    buildStatusReport: async () => ({
      state: 'idle',
      worklist: { pending: 0, enriched: 5, errors: 0 },
      subagentQueue: { pending: 0 },
    }),
    spawnBackground: (cmd, args) => { spawned.push(args); return 333; },
  });

  assert.equal(result.refresh.launchedRefresh, true);
  assert.equal(result.watcher.launchedWatcher, true);
  // Snapshot on disk reflects the new fields
  const snapshot = JSON.parse(await readFile(result.snapshot.jsonPath, 'utf8'));
  assert.equal(snapshot.refresh.launchedRefresh, true);
  assert.equal(snapshot.watcher.launchedWatcher, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/project-memory-context && node --test tests/session-start.test.mjs`
Expected: FAIL — `launchRefreshContext` / `launchWatcherIfNeeded` no exportados.

- [ ] **Step 3: Implement in `src/session-start-runtime.mjs`**

Agregar imports:

```javascript
import { isWatcherAlive, readWatchPidRecord } from './watcher-lifecycle.mjs';
```

Agregar después de `launchEnrichmentIfNeeded`:

```javascript
// Always launch: refresh-context is hash-incremental, so a no-change run
// finishes in seconds. CLI_DIR lives inside this package — when installed
// globally, that IS the global package (requirement: run from global install).
export function launchRefreshContext(projectRoot, deps = {}) {
  const spawnBackgroundImpl = deps.spawnBackground ?? spawnBackground;
  spawnBackgroundImpl(
    process.execPath,
    [join(CLI_DIR, 'refresh-context.mjs'), projectRoot, '--enrich'],
    { cwd: projectRoot },
  );
  return { launchedRefresh: true, backend: 'detached-node' };
}

export async function launchWatcherIfNeeded(projectRoot, deps = {}) {
  const record = await readWatchPidRecord(projectRoot, deps);
  if (isWatcherAlive(record, projectRoot, deps)) {
    return { launchedWatcher: false, watcherPid: record.pid, backend: 'detached-node' };
  }
  const spawnBackgroundImpl = deps.spawnBackground ?? spawnBackground;
  const watcherPid = spawnBackgroundImpl(
    process.execPath,
    [join(CLI_DIR, 'watch.mjs'), projectRoot],
    { cwd: projectRoot },
  );
  return { launchedWatcher: true, watcherPid, backend: 'detached-node' };
}
```

En `runSessionStartRuntime`, después del bloque `try { launch = await launchEnrichmentIfNeeded(...) }` y antes de construir `result`, agregar:

```javascript
  let refresh;
  try {
    refresh = launchRefreshContext(root, deps);
  } catch (err) {
    refresh = { launchedRefresh: false, backend: 'detached-node' };
    warnings.push(`launchRefreshContext failed: ${err.message ?? err}`);
  }

  let watcher;
  try {
    watcher = await launchWatcherIfNeeded(root, deps);
  } catch (err) {
    watcher = { launchedWatcher: false, watcherPid: null, backend: 'detached-node' };
    warnings.push(`launchWatcherIfNeeded failed: ${err.message ?? err}`);
  }
```

Y en el objeto `result`, agregar los campos (después de `launch`):

```javascript
    refresh,
    watcher,
```

También en el short-circuit `hasPmc: false` agregar los mismos campos con valores neutros:

```javascript
      refresh: { launchedRefresh: false, backend: 'detached-node' },
      watcher: { launchedWatcher: false, watcherPid: null, backend: 'detached-node' },
```

En `formatSessionStartSnapshotMarkdown`, después del bloque de `subagentPending`, agregar:

```javascript
  if (result.watcher) {
    lines.push(`- Watcher: ${result.watcher.launchedWatcher ? 'launched' : 'already running'}${result.watcher.watcherPid ? ` (pid ${result.watcher.watcherPid})` : ''}`);
  }
  if (result.refresh?.launchedRefresh) {
    lines.push('- Refresh: refresh-context --enrich launched in background');
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/project-memory-context && node --test tests/session-start.test.mjs`
Expected: PASS. **Atención:** los tests preexistentes de `runSessionStartRuntime` que no inyectan `spawnBackground` ahora spawnearían procesos reales — revisar cada test existente del archivo y agregarles `spawnBackground: () => 0` en `deps` donde falte.

- [ ] **Step 5: Commit**

```bash
git add tools/project-memory-context/src/session-start-runtime.mjs tools/project-memory-context/tests/session-start.test.mjs
git commit -m "feat(session-start): launch refresh-context and watcher detached at startup"
```

---

### Task 6: Reescribir `plugin/index.mjs` con named export `PMCPlugin`

**Files:**
- Modify: `tools/project-memory-context/plugin/index.mjs` (reescritura completa)
- Modify: `tools/project-memory-context/package.json` (export `./plugin`)
- Modify: `tools/project-memory-context/tests/session-start.test.mjs` (tests del plugin)

- [ ] **Step 1: Update the plugin tests to the new contract**

En `tests/session-start.test.mjs`: reemplazar `import pluginFactory from '../plugin/index.mjs';` por `import { PMCPlugin } from '../plugin/index.mjs';` y reemplazar los tests existentes que usan `pluginFactory`/hook `config` por:

```javascript
test('PMCPlugin runs session-start runtime on initialization and returns hooks object', async () => {
  const calls = [];
  const hooks = await PMCPlugin({
    directory: '/proj',
    __testOverrides: {
      runSessionStartRuntime: async (root, opts) => { calls.push({ root, opts }); },
    },
  });
  assert.deepEqual(calls, [{ root: '/proj', opts: { mode: 'opencode-plugin' } }]);
  assert.equal(typeof hooks, 'object');
  // Refresh hook eliminated: the FS watcher replaces tool.execute.after
  assert.equal(hooks['tool.execute.after'], undefined);
  assert.equal(hooks.config, undefined);
});

test('PMCPlugin swallows runtime errors so OpenCode startup never fails', async () => {
  const hooks = await PMCPlugin({
    directory: '/proj',
    __testOverrides: {
      runSessionStartRuntime: async () => { throw new Error('disk exploded'); },
    },
  });
  assert.equal(typeof hooks, 'object');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/project-memory-context && node --test tests/session-start.test.mjs`
Expected: FAIL — `PMCPlugin` no exportado.

- [ ] **Step 3: Rewrite `plugin/index.mjs`**

Contenido completo (reemplaza todo el archivo):

```javascript
// tools/project-memory-context/plugin/index.mjs
// OpenCode plugin entrypoint. OpenCode auto-loads named exports from
// .opencode/plugins/*.mjs; the generated wrapper there re-exports PMCPlugin.
// Startup only reads disk state and spawns detached processes — it must
// never block or break OpenCode initialization.
import { runSessionStartRuntime } from '../src/session-start-runtime.mjs';

export const PMCPlugin = async ({ directory, __testOverrides } = {}) => {
  const runStartup = __testOverrides?.runSessionStartRuntime ?? runSessionStartRuntime;

  try {
    await runStartup(directory ?? process.cwd(), { mode: 'opencode-plugin' });
  } catch {
    // Silent by design: PMC startup must never block OpenCode startup.
  }

  return {};
};

export default PMCPlugin;
```

- [ ] **Step 4: Add the `./plugin` export to `package.json`**

En `tools/project-memory-context/package.json`, sección `exports`:

```json
  "exports": {
    ".": "./src/index.mjs",
    "./platform": "./src/platform.mjs",
    "./retrieval": "./src/retrieval/query-engine.mjs",
    "./plugin": "./plugin/index.mjs"
  },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd tools/project-memory-context && node --test tests/session-start.test.mjs`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add tools/project-memory-context/plugin/index.mjs tools/project-memory-context/package.json tools/project-memory-context/tests/session-start.test.mjs
git commit -m "feat(plugin): rewrite as OpenCode-compatible named export PMCPlugin"
```

---

### Task 7: Eliminar `opencode-refresh-hook`

**Files:**
- Delete: `tools/project-memory-context/src/opencode-refresh-hook.mjs`
- Delete: `tools/project-memory-context/tests/opencode-refresh-hook.test.mjs`

- [ ] **Step 1: Verify no remaining importers**

Run: `cd tools/project-memory-context && grep -rn "opencode-refresh-hook" src/ cli/ plugin/ bin/ mcp/ tests/ templates/`
Expected: solo el propio módulo y su test (el plugin ya fue reescrito en Task 6). Si aparece otro importador, actualizarlo para quitar la dependencia antes de borrar.

- [ ] **Step 2: Delete both files**

```bash
git rm tools/project-memory-context/src/opencode-refresh-hook.mjs tools/project-memory-context/tests/opencode-refresh-hook.test.mjs
```

- [ ] **Step 3: Run the full suite to confirm nothing broke**

Run: `cd tools/project-memory-context && npm test`
Expected: PASS (sin referencias colgantes).

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor: remove opencode refresh hook — FS watcher supersedes it"
```

---

### Task 8: Template del plugin + instalación en `.opencode/` (plugin file + MCP config)

**Files:**
- Create: `tools/project-memory-context/templates/opencode/plugin.mjs`
- Modify: `tools/project-memory-context/src/template-installer.mjs` (función `installOpencode`, línea 115)
- Test: `tools/project-memory-context/tests/template-installer.test.mjs` (agregar tests)

- [ ] **Step 1: Write the failing tests** (agregar a `tests/template-installer.test.mjs`, siguiendo el estilo de fixtures existente del archivo — `mkdtemp` + llamada a `installTemplates`/`installOpencode` con `agent: 'opencode'`)

```javascript
test('installOpencode writes auto-load plugin wrapper to .opencode/plugins/pmc.mjs', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-installer-plugin-'));
  const globalConfigDir = await mkdtemp(join(tmpdir(), 'pmc-installer-global-'));

  await installTemplates({ projectRoot, agent: 'opencode', globalConfigDir });

  const pluginPath = join(projectRoot, '.opencode', 'plugins', 'pmc.mjs');
  const content = await readFile(pluginPath, 'utf8');
  assert.match(content, /export const PMCPlugin/);
  // Placeholder resolved to an absolute file:// URL pointing at this package's plugin entry
  assert.match(content, /file:\/\/.*plugin\/index\.mjs/);
  assert.doesNotMatch(content, /\{\{PMC_PLUGIN_IMPORT\}\}/);

  await rm(projectRoot, { recursive: true, force: true });
  await rm(globalConfigDir, { recursive: true, force: true });
});

test('installOpencode merges MCP config into .opencode/opencode.json preserving existing keys', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-installer-mcp-'));
  const globalConfigDir = await mkdtemp(join(tmpdir(), 'pmc-installer-global-'));

  // Pre-existing user config must survive the merge
  await mkdir(join(projectRoot, '.opencode'), { recursive: true });
  await writeFile(
    join(projectRoot, '.opencode', 'opencode.json'),
    JSON.stringify({ theme: 'dark', mcp: { 'user-server': { type: 'local', command: ['x'] } } }),
  );

  await installTemplates({ projectRoot, agent: 'opencode', globalConfigDir });

  const config = JSON.parse(await readFile(join(projectRoot, '.opencode', 'opencode.json'), 'utf8'));
  assert.equal(config.$schema, 'https://opencode.ai/config.json');
  assert.equal(config.theme, 'dark');
  assert.ok(config.mcp['user-server']);
  assert.ok(config.mcp['pmc-query']);
  assert.ok(config.mcp['pmc-agent-memory']);
  assert.equal(config.mcp['pmc-query'].environment.PMC_PROJECT_ROOT, projectRoot);

  await rm(projectRoot, { recursive: true, force: true });
  await rm(globalConfigDir, { recursive: true, force: true });
});
```

Nota: usar el mismo helper de invocación que ya usa `template-installer.test.mjs` para el caso opencode (verificar el nombre exacto del export usado allí — `installTemplates` — y replicar sus argumentos; los tests existentes del archivo muestran el patrón).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/project-memory-context && node --test tests/template-installer.test.mjs`
Expected: FAIL — no existe `.opencode/plugins/pmc.mjs` ni merge de `opencode.json`.

- [ ] **Step 3: Create the plugin template**

```javascript
// tools/project-memory-context/templates/opencode/plugin.mjs
// Generated by pmc install — do not edit. Re-run `pmc init .` to regenerate.
// Thin wrapper: OpenCode auto-loads this file from .opencode/plugins/ and the
// real implementation lives in the installed PMC package.
export const PMCPlugin = async (input) => {
  try {
    const mod = await import('{{PMC_PLUGIN_IMPORT}}');
    return await mod.PMCPlugin(input);
  } catch {
    // PMC unavailable (moved/uninstalled package): never break OpenCode startup.
    return {};
  }
};
```

- [ ] **Step 4: Implement installer changes**

En `src/template-installer.mjs`, agregar imports arriba:

```javascript
import { pathToFileURL } from 'node:url';
import { buildInjectedPmcConfig } from './plugin-config.mjs';
```

Agregar helpers antes de `installOpencode`:

```javascript
async function readOpencodeInstallState(projectRoot) {
  try {
    return JSON.parse(
      await readFile(join(projectRoot, '.planning', 'project-memory-context', 'install.json'), 'utf8'),
    );
  } catch {
    return {
      projectRoot,
      memoryDbPath: join(projectRoot, '.planning', 'project-memory-context', 'memory-db'),
    };
  }
}

async function writeOpencodeProjectConfig({ projectRoot, installState }) {
  const configPath = join(projectRoot, '.opencode', 'opencode.json');
  let existing = {};
  try {
    existing = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {}

  const injected = buildInjectedPmcConfig({ installState });
  const merged = {
    $schema: 'https://opencode.ai/config.json',
    ...existing,
    mcp: { ...(existing.mcp ?? {}), ...injected.mcp },
  };

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
}
```

Al final de `installOpencode` (después del bloque de `AGENTS.md`), agregar:

```javascript
  // Auto-load plugin wrapper: OpenCode loads .opencode/plugins/*.mjs at startup.
  // The import path is resolved at install time to this package's location —
  // global install for consumers, local path in the source repo.
  const pluginImportUrl = pathToFileURL(join(packageRoot, 'plugin', 'index.mjs')).href;
  const pluginContent = renderTemplate(
    await readTemplate(packageRoot, 'opencode/plugin.mjs'),
    { ...placeholders, PMC_PLUGIN_IMPORT: pluginImportUrl },
  );
  await writeIfMissingOrForced(join(projectRoot, '.opencode', 'plugins', 'pmc.mjs'), pluginContent, { force: true });

  // MCP servers: written directly to project config (OpenCode has no `config` hook).
  const installState = await readOpencodeInstallState(projectRoot);
  await writeOpencodeProjectConfig({ projectRoot, installState });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd tools/project-memory-context && node --test tests/template-installer.test.mjs`
Expected: PASS (nuevos + preexistentes).

- [ ] **Step 6: Commit**

```bash
git add tools/project-memory-context/templates/opencode/plugin.mjs tools/project-memory-context/src/template-installer.mjs tools/project-memory-context/tests/template-installer.test.mjs
git commit -m "feat(install): write OpenCode auto-load plugin and MCP config to .opencode/"
```

---

### Task 9: Documentación — autostart snippet, AGENTS.md, README

**Files:**
- Modify: `tools/project-memory-context/templates/opencode/autostart-snippet.md`
- Modify: `AGENTS.md` (raíz del repo — bloque `<!-- pmc:autostart -->`)
- Modify: `tools/project-memory-context/README.md`

- [ ] **Step 1: Update the autostart snippet**

En `templates/opencode/autostart-snippet.md`, reemplazar el primer párrafo de la sección "PMC Session Autostart" (líneas 3-4 del template) por:

```markdown
PMC installs an auto-loaded OpenCode plugin at `.opencode/plugins/pmc.mjs`. On every OpenCode startup the plugin runs a zero-token Node runtime that: launches `refresh-context --enrich` in the background (hash-incremental), launches background enrichment + watchdog if pending symbols exist, ensures a single detached file watcher per project (5-minute per-file quiet debounce → automatic refresh + enrich), and writes the startup snapshot to `.planning/project-memory-context/runs/session-start/latest.json` / `latest.md`. Nothing blocks the session; check `{{PMC_BIN}} watch . --status` or the snapshot to inspect state.
```

Y al final de la lista "This command handles everything deterministic in one shot:", agregar el ítem:

```markdown
- Ensures the file watcher is running (PID + heartbeat tracked; `{{PMC_BIN}} watch . --status` / `--stop` to manage)
```

- [ ] **Step 2: Propagate to the repo root `AGENTS.md`**

Run: `cd tools/project-memory-context && node bin/pmc.mjs install-pmc .. --agent opencode` — o editar manualmente el bloque `<!-- pmc:autostart -->` de `AGENTS.md` con el mismo texto del snippet renderizado (con `pmc` en lugar de `{{PMC_BIN}}`). Verificar con `git diff AGENTS.md` que el bloque quedó actualizado y sin duplicados.

- [ ] **Step 3: Update README**

En `tools/project-memory-context/README.md`, sección de OpenCode startup (buscar "OpenCode Session Startup" o equivalente):
- Documentar que `pmc init`/`install-pmc` ahora instala `.opencode/plugins/pmc.mjs` (auto-cargado por OpenCode) y escribe la config MCP en `.opencode/opencode.json`.
- Documentar los flags del watcher: `pmc watch . --detach` (background con confirmación), `pmc watch . --stop`, `pmc watch . --status`, y la semántica del debounce (5 min por archivo quieto, tick de 30 s, heartbeat para detección de zombies/PID reuse).
- Quitar cualquier mención al hook `tool.execute.after` / `opencode-refresh-hook` como mecanismo de refresh.

- [ ] **Step 4: Commit**

```bash
git add tools/project-memory-context/templates/opencode/autostart-snippet.md AGENTS.md tools/project-memory-context/README.md
git commit -m "docs: describe OpenCode auto-loaded plugin, watcher flags and debounce semantics"
```

---

### Task 10: Verificación final + release

- [ ] **Step 1: Full test suite**

Run: `cd tools/project-memory-context && npm test`
Expected: PASS completo. Si algún test preexistente falla por los cambios de shape (`result.refresh`/`result.watcher` en snapshots, plugin named export), corregir el test al contrato nuevo — no el código.

- [ ] **Step 2: Smoke test end-to-end en este repo**

```bash
cd tools/project-memory-context
node cli/session-start.mjs ..
node cli/watch.mjs .. --status
```

Expected: el session-start reporta lanzamientos (refresh + watcher) sin bloquear; `--status` muestra `"alive": true` con heartbeat reciente. Después: `node cli/watch.mjs .. --stop` → "Stopped watcher".

- [ ] **Step 3: Verificar que el plugin wrapper carga**

```bash
cd tools/project-memory-context
node -e "import(process.argv[1]).then(m => m.PMCPlugin({ directory: process.cwd() })).then(h => console.log('hooks:', Object.keys(h)))" ./plugin/index.mjs
```

Expected: imprime `hooks: []` sin errores (startup silencioso, objeto de hooks vacío).

- [ ] **Step 4: Version bump + commit final**

En `tools/project-memory-context/package.json`: `"version": "0.6.0"` (minor: nueva superficie — flags del watcher, plugin OpenCode real, export `./plugin`; sin breaking para consumidores del CLI).

```bash
git add tools/project-memory-context/package.json
git commit -m "chore(release): bump pmc to 0.6.0 — opencode nonblocking autostart"
```

Publicar (`npm publish` desde `tools/project-memory-context/`) y re-correr `pmc init .` en repos consumidores queda como paso operativo del usuario, fuera de este plan.

---

## Self-review del plan (ya aplicado)

- **Cobertura de spec:** Capa 1 → Task 8; Capa 2 → Tasks 6-7; Capa 3 → Tasks 4-5; Capa 4 → Tasks 1-3; Docs → Task 9; criterios de éxito → Task 10.
- **Consistencia de tipos:** `isWatcherAlive(record, projectRoot, deps)` y `readWatchPidRecord(projectRoot, deps)` se usan con la misma firma en Tasks 1, 3 y 5. `partitionQuiet` retorna `{ quiet: [archivo, ts][], hot: {} }` consistente entre Tasks 2 y 3. `spawnBackground` inyectable vía `deps` en Tasks 3 y 5 igual que el patrón existente de `launchEnrichmentIfNeeded`.
- **Riesgo conocido:** los tests preexistentes de `session-start.test.mjs` que no inyectan `spawnBackground` lanzarían procesos reales tras Task 5 — el Step 4 de esa task lo cubre explícitamente.
