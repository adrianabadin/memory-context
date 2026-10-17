/**
 * TDD specs for sanitize:
 *  - must use the shared async runGraphifyUpdate from src/graphify-runner.mjs
 *  - must NOT have its own blocking spawnSync for graphify
 *  - must not hang indefinitely when graphify is stuck
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { join, resolve, dirname } from 'node:path';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { sanitize } from '../cli/sanitize.mjs';

// Resolve paths relative to this test file, not process.cwd()
const __dirname = dirname(fileURLToPath(import.meta.url));
const sanitizeSrcPath = resolve(__dirname, '../cli/sanitize.mjs');

let counter = 0;
function tmp(label) {
  return join(tmpdir(), `pmc-sanitize-test-${++counter}-${label}`);
}

/**
 * On Windows, sanitized projects may have background enrichment processes
 * or hanging fake-graphify children that hold the tmp dir open briefly
 * after the test asserts. We retry the rm with a small backoff and give
 * up silently if it stays busy — the assertions have already passed.
 */
async function cleanup(dir) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err?.code !== 'EBUSY' && err?.code !== 'EPERM') throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

function makeHangingChildFactory() {
  return () => {
    const child = new EventEmitter();
    child.pid = 88000 + counter;
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    child.killCalls = [];
    child.kill = (sig) => {
      child.killCalls.push(sig);
      return true;
    };
    // Never emit 'close' or 'error' on its own — only the runner's timeout can finish it.
    return child;
  };
}

test('1. sanitize module imports runGraphifyUpdate from the shared async runner', async () => {
  // Source-level check: the cli/sanitize.mjs source must import the shared
  // runner. This guards against accidental regression to a local spawnSync.
  const src = await readFile(sanitizeSrcPath, 'utf8');
  assert.ok(
    /from\s+['"]\.\.\/src\/graphify-runner\.mjs['"]/.test(src),
    'sanitize.mjs must import runGraphifyUpdate from ../src/graphify-runner.mjs',
  );
  assert.ok(
    /import\s*\{[^}]*runGraphifyUpdate[^}]*\}\s*from\s+['"]\.\.\/src\/graphify-runner\.mjs['"]/.test(src),
    'sanitize.mjs must destructure runGraphifyUpdate from the shared runner import',
  );
});

test('2. sanitize module no longer contains its own spawnSync for graphify', async () => {
  const src = await readFile(sanitizeSrcPath, 'utf8');
  // After the refactor, sanitize must NOT have its own spawnSync — it
  // delegates to the shared async runner which has a timeout.
  assert.ok(
    !/spawnSync\s*\(/.test(src),
    'sanitize.mjs must not call spawnSync directly',
  );
  // And the local runGraphifyUpdate helper that used spawnSync must be gone.
  assert.ok(
    !/function\s+runGraphifyUpdate\s*\(/.test(src),
    'sanitize.mjs must not declare its own runGraphifyUpdate function',
  );
});

test('3. sanitize does not hang indefinitely when graphify is stuck (timeout fires)', async () => {
  const T = tmp('hangs');
  await mkdir(join(T, 'src'), { recursive: true });
  await writeFile(join(T, 'src', 'app.mjs'), 'export function hello() { return 1; }\n');

  const hangingSpawn = makeHangingChildFactory();

  const start = Date.now();
  const result = await sanitize({
    projectRoot: T,
    spawnImpl: hangingSpawn,
    graphifyTimeoutMs: 200,
    skipBackgroundEnrich: true,
  });
  const elapsed = Date.now() - start;

  assert.ok(
    elapsed < 5_000,
    `sanitize must return within bounded time, took ${elapsed}ms`,
  );
  assert.equal(result.total, 1, 'should still find and register the source symbol');
  await cleanup(T);
});

test('4. sanitize completes successfully when graphify is missing (graceful degradation)', async () => {
  const T = tmp('missing');
  await mkdir(join(T, 'src'), { recursive: true });
  await writeFile(join(T, 'src', 'app.mjs'), 'export function hi() { return 1; }\n');

  const result = await sanitize({
    projectRoot: T,
    // Inject a resolver that always throws — mimics graphify not installed.
    resolveGraphifyFn: () => { throw new Error('not installed'); },
    graphifyTimeoutMs: 100,
    skipBackgroundEnrich: true,
  });

  // Must not throw, must return a valid result object.
  assert.equal(typeof result.total, 'number');
  assert.equal(result.total, 1, 'should find the one source symbol even without graphify');
  await cleanup(T);
});

test('5. sanitize writes worklist and reports sane counts', async () => {
  const T = tmp('happy');
  await mkdir(join(T, 'src'), { recursive: true });
  await writeFile(join(T, 'src', 'a.mjs'), 'export function a() { return 1; }\n');
  await writeFile(join(T, 'src', 'b.mjs'), 'export function b() { return 2; }\n');

  const result = await sanitize({
    projectRoot: T,
    resolveGraphifyFn: () => { throw new Error('not installed'); },
    skipBackgroundEnrich: true,
  });

  assert.equal(result.new, 2, 'should detect 2 new symbols');
  assert.equal(result.total, 2);

  const wlRaw = await readFile(
    join(T, '.planning', 'project-memory-context', 'enrichment', 'worklist.json'),
    'utf8',
  );
  const wl = JSON.parse(wlRaw);
  assert.equal(wl.length, 2);
  assert.ok(wl.every((e) => e.status === 'pending'), 'all new entries should be pending');

  await cleanup(T);
});
