/**
 * TDD specs for runGraphifyUpdate:
 *  - must be async (Promise return) and use spawn (not spawnSync)
 *  - must time out and kill child tree when graphify hangs
 *  - must warn and continue when graphify exits non-zero
 *  - must warn and continue when graphify binary is missing
 *  - must copy generated graph artifacts on success
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { join, resolve } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { runGraphifyUpdate, ensureGraphifyIgnore, installGraphify } from '../src/graphify-runner.mjs';

let counter = 0;
function tmp(label) {
  return join(tmpdir(), `pmc-graphify-runner-test-${++counter}-${label}`);
}

function fakeChild({ exitCode = 0, delayMs = 0, error = null, killable = true } = {}) {
  const child = new EventEmitter();
  child.pid = 99000 + counter;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.killCalls = [];
  child.kill = killable
    ? (sig) => {
        child.killCalls.push(sig);
        return true;
      }
    : () => false;

  const fire = () => {
    if (error) child.emit('error', new Error(error));
    else child.emit('close', exitCode);
  };
  if (delayMs > 0) {
    const t = setTimeout(fire, delayMs);
    // Don't keep the event loop alive past the test (the child is fake).
    if (typeof t.unref === 'function') t.unref();
  } else {
    queueMicrotask(fire);
  }
  return child;
}

function makeSpawnFactory(impl) {
  return (..._args) => impl();
}

test('1. runGraphifyUpdate returns a Promise (is async)', () => {
  const result = runGraphifyUpdate(tmp('async'), {
    resolveGraphifyFn: () => '/nonexistent/graphify',
    spawnImpl: () => fakeChild({ delayMs: 5 }),
    timeoutMs: 100,
  });
  assert.equal(typeof result.then, 'function', 'must return a thenable');
  return result; // drain
});

test('2. runGraphifyUpdate warns and continues when graphify is not installed', async () => {
  const messages = [];
  const result = await runGraphifyUpdate(tmp('missing'), {
    resolveGraphifyFn: () => { throw new Error('not installed'); },
    log: (m) => messages.push(m),
  });
  assert.equal(result.ran, false, 'must report ran:false when missing');
  assert.deepEqual(result.copied, []);
  assert.ok(
    messages.some((m) => m.includes('graphify not found')),
    'must log that graphify is missing',
  );
});

test('3. runGraphifyUpdate warns and continues when graphify exits non-zero', async () => {
  const T = tmp('nonzero');
  await mkdir(T, { recursive: true });
  const messages = [];
  const result = await runGraphifyUpdate(T, {
    resolveGraphifyFn: () => '/fake/graphify',
    spawnImpl: makeSpawnFactory(() => fakeChild({ exitCode: 2 })),
    log: (m) => messages.push(m),
    timeoutMs: 1000,
  });
  assert.equal(result.ran, false, 'non-zero exit must NOT count as ran');
  assert.equal(result.timedOut, undefined, 'must not be flagged as timed out');
  assert.ok(
    messages.some((m) => m.includes('exited with code 2')),
    'must log non-zero exit code',
  );
  await rm(T, { recursive: true, force: true });
});

test('4. runGraphifyUpdate times out and kills child tree when graphify hangs', async () => {
  const T = tmp('hangs');
  await mkdir(T, { recursive: true });
  const messages = [];
  // Child never emits 'close' or 'error' — it just hangs forever.
  const child = fakeChild({ delayMs: 60_000, killable: true });
  const start = Date.now();
  const result = await runGraphifyUpdate(T, {
    resolveGraphifyFn: () => '/fake/graphify',
    spawnImpl: makeSpawnFactory(() => child),
    log: (m) => messages.push(m),
    timeoutMs: 150, // short timeout for test
  });
  const elapsed = Date.now() - start;
  assert.equal(result.ran, false, 'timed-out run must report ran:false');
  assert.equal(result.timedOut, true, 'result must be flagged as timed out');
  assert.ok(elapsed < 5_000, `must return promptly, took ${elapsed}ms`);
  assert.ok(child.killCalls.length > 0, `must call child.kill (got ${child.killCalls.length} calls)`);
  assert.ok(
    messages.some((m) => /timed out|exceeded/.test(m)),
    'must log timeout',
  );
  await rm(T, { recursive: true, force: true });
});

test('5. runGraphifyUpdate returns ran:true and copies graph artifacts on success', async () => {
  const T = tmp('success');
  // Simulate the side effect of a real graphify: writes graphify-out/{graph.json, ...}
  const graphifyOut = resolve(T, 'graphify-out');
  await mkdir(graphifyOut, { recursive: true });
  for (const f of ['graph.json', 'graph.metadata.json', 'graph.html', 'GRAPH_REPORT.md']) {
    await writeFile(join(graphifyOut, f), `content-of-${f}`, 'utf8');
  }
  const result = await runGraphifyUpdate(T, {
    resolveGraphifyFn: () => '/fake/graphify',
    spawnImpl: makeSpawnFactory(() => fakeChild({ exitCode: 0 })),
    timeoutMs: 1000,
  });
  assert.equal(result.ran, true, 'success must report ran:true');
  assert.equal(result.timedOut, undefined, 'success must not be flagged as timed out');
  assert.ok(result.copied.includes('graph.json'), 'must copy graph.json');
  assert.ok(result.copied.includes('graph.html'), 'must copy graph.html');
  // Verify the destination file actually exists
  const dest = resolve(T, '.planning', 'project-memory-context', 'graph', 'graph.json');
  const { readFile } = await import('node:fs/promises');
  const content = await readFile(dest, 'utf8');
  assert.equal(content, 'content-of-graph.json');
  await rm(T, { recursive: true, force: true });
});

test('6. runGraphifyUpdate reports ran:true with empty copied list when graphify-out missing', async () => {
  const T = tmp('no-out');
  await mkdir(T, { recursive: true });
  const result = await runGraphifyUpdate(T, {
    resolveGraphifyFn: () => '/fake/graphify',
    spawnImpl: makeSpawnFactory(() => fakeChild({ exitCode: 0 })),
    timeoutMs: 1000,
  });
  assert.equal(result.ran, true, 'ran must be true when exit code is 0');
  assert.deepEqual(result.copied, [], 'nothing to copy if graphify-out missing');
  await rm(T, { recursive: true, force: true });
});

test('7. ensureGraphifyIgnore creates .graphifyignore with required entries when absent', async () => {
  const T = tmp('ignore-create');
  await mkdir(T, { recursive: true });
  const ignoreFile = resolve(T, '.graphifyignore');

  await ensureGraphifyIgnore(T);

  const { readFile } = await import('node:fs/promises');
  const content = await readFile(ignoreFile, 'utf8');
  assert.ok(content.includes('.worktrees/'), 'must include .worktrees/');
  assert.ok(content.includes('.planning/'), 'must include .planning/');
  assert.ok(content.includes('node_modules/'), 'must include node_modules/');
  assert.ok(content.includes('graphify-out/'), 'must include graphify-out/');
  assert.ok(content.includes('.graphify_*.json'), 'must include .graphify_*.json');
  await rm(T, { recursive: true, force: true });
});

test('8. ensureGraphifyIgnore preserves user lines/comments and appends missing entries idempotently', async () => {
  const T = tmp('ignore-preserve');
  await mkdir(T, { recursive: true });
  const ignoreFile = resolve(T, '.graphifyignore');
  const initial = '# Custom user comment\nmy-custom-build/\n.worktrees\n';
  await writeFile(ignoreFile, initial, 'utf8');

  await ensureGraphifyIgnore(T);

  const { readFile } = await import('node:fs/promises');
  const content1 = await readFile(ignoreFile, 'utf8');
  assert.ok(content1.startsWith('# Custom user comment\nmy-custom-build/\n.worktrees'), 'must preserve user header');
  assert.ok(content1.includes('.planning/'), 'must append .planning/');
  assert.ok(content1.includes('node_modules/'), 'must append node_modules/');
  assert.ok(content1.includes('graphify-out/'), 'must append graphify-out/');
  assert.ok(content1.includes('.graphify_*.json'), 'must append .graphify_*.json');

  // Verify .worktrees (without slash) was recognized and .worktrees/ was not duplicated
  const occurrences = (content1.match(/\.worktrees\/?/g) || []).length;
  assert.equal(occurrences, 1, '.worktrees must not be duplicated even when entered without trailing slash');

  // Idempotency: run again, content must not change
  await ensureGraphifyIgnore(T);
  const content2 = await readFile(ignoreFile, 'utf8');
  assert.equal(content2, content1, 'second call must be idempotent');

  await rm(T, { recursive: true, force: true });
});

test('9. runGraphifyUpdate invokes ensureGraphifyIgnore before spawning child process', async () => {
  const T = tmp('order-before-spawn');
  await mkdir(T, { recursive: true });
  const ignoreFile = resolve(T, '.graphifyignore');

  const { existsSync } = await import('node:fs');
  let ignoreExistedAtSpawnTime = false;
  const spawnImpl = (...args) => {
    ignoreExistedAtSpawnTime = existsSync(ignoreFile);
    return fakeChild({ exitCode: 0 });
  };

  await runGraphifyUpdate(T, {
    resolveGraphifyFn: () => '/fake/graphify',
    spawnImpl,
    timeoutMs: 1000,
  });

  assert.equal(ignoreExistedAtSpawnTime, true, '.graphifyignore must exist before spawn is called');
  await rm(T, { recursive: true, force: true });
});

test('10. runGraphifyUpdate degrades gracefully and does not throw when .graphifyignore cannot be written (directory collision)', async () => {
  const T = tmp('dir-collision');
  await mkdir(T, { recursive: true });
  // Create .graphifyignore as a directory to force an EISDIR / EPERM write failure
  await mkdir(resolve(T, '.graphifyignore'), { recursive: true });

  const messages = [];
  const result = await runGraphifyUpdate(T, {
    resolveGraphifyFn: () => '/fake/graphify',
    spawnImpl: makeSpawnFactory(() => fakeChild({ exitCode: 0 })),
    log: (m) => messages.push(m),
    timeoutMs: 1000,
  });

  assert.equal(result.ran, false, 'must report ran:false on .graphifyignore write error');
  assert.deepEqual(result.copied, []);
  assert.ok(
    messages.some((m) => m.includes('.graphifyignore')),
    'must log error about .graphifyignore',
  );
  await rm(T, { recursive: true, force: true });
});

test('11. installGraphify respects PMC_GRAPHIFY_PATH and skips pip installation', () => {
  const spawnCalls = [];
  const messages = [];
  const result = installGraphify({
    env: { PMC_GRAPHIFY_PATH: '/custom/bin/graphify' },
    spawnSyncImpl: (...args) => {
      spawnCalls.push(args);
      return { status: 0 };
    },
    log: (m) => messages.push(m),
  });
  assert.equal(result, true, 'must return true when skipping install');
  assert.equal(spawnCalls.length, 0, 'spawnSync must NOT be called when PMC_GRAPHIFY_PATH is set');
  assert.ok(
    messages.some((m) => m.includes('PMC_GRAPHIFY_PATH') && m.includes('skipping')),
    'must log truthful skip message mentioning PMC_GRAPHIFY_PATH',
  );
});

test('12. installGraphify skips pip installation when graphify executable is already available', () => {
  const spawnCalls = [];
  const messages = [];
  const result = installGraphify({
    env: {},
    resolveGraphifyFn: () => '/usr/bin/graphify',
    spawnSyncImpl: (...args) => {
      spawnCalls.push(args);
      return { status: 0 };
    },
    log: (m) => messages.push(m),
  });
  assert.equal(result, true, 'must return true when skipping install');
  assert.equal(spawnCalls.length, 0, 'spawnSync must NOT be called when graphify is already available');
  assert.ok(
    messages.some((m) => m.includes('already available') && m.includes('skipping')),
    'must log truthful skip message mentioning executable is already available',
  );
});

test('13. installGraphify preserves legacy PMC_GRAPHIFY_BIN and skips pip installation', () => {
  const spawnCalls = [];
  const messages = [];
  const result = installGraphify({
    env: { PMC_GRAPHIFY_BIN: 'custom-graphify-bin' },
    spawnSyncImpl: (...args) => {
      spawnCalls.push(args);
      return { status: 0 };
    },
    log: (m) => messages.push(m),
  });
  assert.equal(result, true, 'must return true when skipping install');
  assert.equal(spawnCalls.length, 0, 'spawnSync must NOT be called when PMC_GRAPHIFY_BIN is set');
  assert.ok(
    messages.some((m) => m.includes('PMC_GRAPHIFY_BIN') && m.includes('skipping')),
    'must log truthful skip message mentioning PMC_GRAPHIFY_BIN',
  );
});

test('14. installGraphify never falls through to global pip install on rejected or invalid explicit config', () => {
  const spawnCalls = [];
  const messages = [];
  const result = installGraphify({
    env: { PMC_GRAPHIFY_PATH: '/nonexistent/path/graphify' },
    resolveGraphifyFn: () => {
      throw new Error('graphify not found');
    },
    spawnSyncImpl: (...args) => {
      spawnCalls.push(args);
      return { status: 0 };
    },
    log: (m) => messages.push(m),
  });
  assert.equal(result, true, 'must return true when explicit override is provided');
  assert.equal(spawnCalls.length, 0, 'spawnSync must NOT be called even if override is unresolvable');
  assert.ok(
    messages.some((m) => m.includes('PMC_GRAPHIFY_PATH') && m.includes('skipping')),
    'must log truthful skip rather than falling through to global pip install',
  );
});

test('15. installGraphify falls back to pip install fork when graphify is missing and no explicit override exists', () => {
  const spawnCalls = [];
  const messages = [];
  const result = installGraphify({
    env: {},
    resolveGraphifyFn: () => {
      throw new Error('graphify not found');
    },
    resolvePythonBinFn: () => 'fake-python',
    spawnSyncImpl: (...args) => {
      spawnCalls.push(args);
      return { status: 0 };
    },
    log: (m) => messages.push(m),
  });
  assert.equal(result, true, 'must return true on successful pip install');
  assert.equal(spawnCalls.length, 1, 'spawnSync must be called once when graphify is missing');
  assert.equal(spawnCalls[0][0], 'fake-python');
  assert.deepEqual(spawnCalls[0][1], [
    '-m',
    'pip',
    'install',
    'git+https://github.com/adrianabadin/graphify.git@feat/cshtml-mvc-razor-extraction',
  ]);
});
