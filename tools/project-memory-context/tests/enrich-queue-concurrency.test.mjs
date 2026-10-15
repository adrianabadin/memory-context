/**
 * F3 N6B (accepted plan 3.6 / spec S12) â€” PMC_CONCURRENCY honored in the
 * actual queue loop, SCC-ready fresh callee contexts, and the honest
 * settlement rules around them.
 *
 * Acceptance targeted here: throughput scales with concurrency (bounded,
 * overlapping independent jobs â€” preparation AND run share ONE bound, and
 * the awaited tokenizer probe sits inside the same bound), editing a caller
 * never re-runs the LLM on the callee, and the legacy default flow keeps its
 * exact request shape, content, keysets and canonical aggregate order.
 *
 * Determinism strategy: controlled deferred/gated fake providers and a
 * no-op injected sleep â€” no wall-clock assertions, no real Ollama, no
 * network, no production spawn (child_process.spawn is replaced with a
 * recording fake for the whole file, so background sync/retry never create a
 * real process). Fixtures are owned mkdtemp roots removed in afterEach, and
 * PMC_CONCURRENCY is saved/restored around the one fresh-module import.
 */

import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildSymbolPromptMeta, main, runQueueSymbolEnrichment } from '../cli/enrich-queue.mjs';
import { ensureProjectMemoryContextDirs, readJsonArtifact } from '../src/artifacts.mjs';
import { setQueueStateFileOps } from '../src/cards/queue-state-io.mjs';
import { computeNarrativeHash, hashCalleeSummaries } from '../src/hash.mjs';

const childProcess = createRequire(import.meta.url)('node:child_process');
let originalChildProcessSpawn;
let spawnCalls = [];
let ownedFixtureRoots = new Set();
let fixtureRootsCreated = 0;
let fixtureRootsRemoved = 0;
let restoreFileOps = null;
const savedEnv = new Map();

beforeEach(() => {
  originalChildProcessSpawn = childProcess.spawn;
  spawnCalls = [];
  ownedFixtureRoots = new Set();
  fixtureRootsCreated = 0;
  fixtureRootsRemoved = 0;
  restoreFileOps = null;
  // Recording fake instead of a real process: sync/retry launches must be
  // observable but never actually spawned.
  childProcess.spawn = (...args) => {
    spawnCalls.push(args);
    return { pid: -1, unref() {} };
  };
  syncBuiltinESMExports();
});

afterEach(async () => {
  const failures = [];
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  if (restoreFileOps) {
    try {
      restoreFileOps();
    } catch (error) {
      failures.push(error);
    } finally {
      restoreFileOps = null;
    }
  }
  for (const root of ownedFixtureRoots) {
    try {
      await rm(root, { recursive: true, force: true });
      fixtureRootsRemoved += 1;
      await assert.rejects(access(root), { code: 'ENOENT' });
    } catch (error) {
      failures.push(error);
    }
  }
  ownedFixtureRoots.clear();
  try {
    assert.equal(fixtureRootsRemoved, fixtureRootsCreated, 'every owned fixture root must be removed');
  } catch (error) {
    failures.push(error);
  }
  try {
    childProcess.spawn = originalChildProcessSpawn;
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      syncBuiltinESMExports();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'test teardown failed');
});

// -------------------------------------------------------------------
// Fixtures and controlled fakes
// -------------------------------------------------------------------

// Six declared lines with a real branch: NON-trivial, so every symbol takes
// the tokenizer + provider path (coverage 6/9 stays below the subagent
// threshold; injected tokenizer returns 400 tokens).
function branchySource(name) {
  return [
    `export function ${name}(value) {`,
    '  if (!value) {',
    "    throw new TypeError('value required');",
    '  }',
    "  return typeof value === 'string' ? 'text' : 'other';",
    '}',
    '',
    '// padding line one',
    '// padding line two',
    '',
  ].join('\n');
}

const RANGE = { startLine: 1, endLine: 6 };

function makeSymbol(name) {
  return {
    symbolKey: `js|src/${name}.js|function|exported|${name}|1`,
    name,
    kind: 'function',
    language: 'js',
    filePath: `src/${name}.js`,
    codeHash: `hash-${name}`,
    range: { ...RANGE },
    status: 'pending',
  };
}

async function createFixture(worklistOrder) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-n6b-queue-'));
  ownedFixtureRoots.add(projectRoot);
  fixtureRootsCreated += 1;
  const dirs = await ensureProjectMemoryContextDirs(projectRoot);
  const srcDir = join(projectRoot, 'src');
  await mkdir(srcDir, { recursive: true });
  for (const name of worklistOrder) {
    await writeFile(join(srcDir, `${name}.js`), branchySource(name), 'utf8');
  }

  const worklistFile = join(dirs.enrichment, 'worklist.json');
  const symbolIndexFile = join(dirs.enrichment, 'symbol-index.json');
  const worklist = worklistOrder.map((name) => makeSymbol(name));
  await writeJson(worklistFile, worklist);
  await writeJson(symbolIndexFile, {});

  return { projectRoot, dirs, worklistFile, symbolIndexFile, worklist };
}

async function writeJson(path, data) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function fixtureConfig() {
  return {
    preferredModes: ['local-model'],
    localModel: { provider: 'ollama', baseUrl: 'http://127.0.0.1:0', model: 'fixture-model' },
    subagentTokenThreshold: 5000,
    fileCoverageThreshold: 0.8,
  };
}

function stubConsole() {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => { logs.push(args.join(' ')); };
  console.error = (...args) => { errors.push(args.join(' ')); };
  return {
    logs,
    errors,
    restore() {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

function symbolNameOf(text) {
  const match = /^Symbol: (\w+)/m.exec(text);
  assert.ok(match, `prompt must carry the symbol identity line: ${text.slice(0, 80)}`);
  return match[1];
}

/** Gate that holds provider/tokenizer jobs until explicitly opened. */
function createGate() {
  let opened = false;
  const waiters = [];
  return {
    async wait() {
      if (!opened) await new Promise((resolve) => waiters.push(resolve));
    },
    open() {
      opened = true;
      while (waiters.length) waiters.shift()();
    },
  };
}

/**
 * Provider fake with start/in-flight accounting. Every call is counted per
 * symbol so a duplicate, dropped or retried inference fails the test, and the
 * gate lets the test pin completion order deterministically.
 */
function trackedProvider(gate, { perSymbolGate, resultFor } = {}) {
  const tracker = { starts: [], active: 0, peak: 0, perKey: new Map(), requests: [] };
  tracker.impl = async ({ request }) => {
    const name = symbolNameOf(request.prompt);
    tracker.requests.push({ name, request });
    tracker.starts.push(name);
    tracker.perKey.set(name, (tracker.perKey.get(name) ?? 0) + 1);
    tracker.active += 1;
    tracker.peak = Math.max(tracker.peak, tracker.active);
    const hold = perSymbolGate ? perSymbolGate(name) : gate;
    if (hold) await hold.wait();
    tracker.active -= 1;
    const content = resultFor ? resultFor(name, request) : 'Legacy enrichment text.';
    return succeededTextResult(content);
  };
  tracker.count = (name) => tracker.perKey.get(name) ?? 0;
  return tracker;
}

function succeededTextResult(content) {
  return {
    status: 'succeeded',
    content,
    mode: 'local-model',
    provider: 'ollama',
    model: 'fixture-model',
    attempts: [
      {
        mode: 'local-model',
        provider: 'ollama',
        model: 'fixture-model',
        status: 'succeeded',
        startedAt: '2026-10-15T12:00:00.000Z',
        endedAt: '2026-10-15T12:00:01.000Z',
      },
    ],
  };
}

function succeededNarrativeResult(narrative) {
  return succeededTextResult(JSON.stringify(narrative));
}

/** Tokenizer fake with in-flight accounting; each probe yields one turn. */
function trackedTokenizer() {
  const tracker = { calls: 0, active: 0, peak: 0, gate: null };
  tracker.impl = async ({ prompt }) => {
    tracker.calls += 1;
    tracker.active += 1;
    tracker.peak = Math.max(tracker.peak, tracker.active);
    if (tracker.gate) await tracker.gate.wait();
    else await new Promise((resolve) => setImmediate(resolve));
    tracker.active -= 1;
    return 400;
  };
  return tracker;
}

async function waitFor(condition, message, { iterations = 20_000 } = {}) {
  for (let i = 0; i < iterations; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function installFileOps(overrides) {
  restoreFileOps = setQueueStateFileOps(overrides);
  return restoreFileOps;
}

function codeError(code, message = `${code}: injected test failure`) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function lastJsonLog(consoleStub) {
  return JSON.parse(consoleStub.logs[consoleStub.logs.length - 1]);
}

// -------------------------------------------------------------------
// 1. The effective bound actually limits model and tokenizer jobs.
// -------------------------------------------------------------------

test('explicit concurrency 2 bounds the provider peak, independent jobs overlap and the tokenizer stays inside the bound', async () => {
  const fixture = await createFixture(['sym03', 'sym01', 'sym04', 'sym02']);
  const gate = createGate();
  const provider = trackedProvider(gate);
  const tokenizer = trackedTokenizer();
  const consoleStub = stubConsole();

  let run;
  try {
    run = main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      concurrency: 2,
      countPromptTokensImpl: tokenizer.impl,
      runEnrichmentWithFallbackImpl: provider.impl,
    });

    // Two independent providers must be in flight at once (overlap) while a
    // third never starts (bound). Under a sequential loop only ONE provider
    // ever starts while the gate is closed.
    await waitFor(() => provider.starts.length === 2,
      'two independent provider jobs must run concurrently under concurrency 2');
    assert.equal(provider.peak, 2, 'independent provider jobs must overlap, not run one-by-one');
    assert.equal(provider.starts.length, 2, 'the third job must wait for a free slot');
    assert.equal(tokenizer.calls, 2, 'the awaited tokenizer probes occupy the same bound as the provider jobs');
    assert.ok(tokenizer.peak <= 2, `tokenizer peak ${tokenizer.peak} must stay within the bound`);

    gate.open();
    const output = lastJsonLog(await withConsole(consoleStub, () => run));

    assert.equal(output.enriched, 4);
    assert.equal(output.errors, 0);
    assert.equal(provider.peak, 2, 'the peak never exceeds the bound across the whole run');
    assert.ok(tokenizer.peak <= 2, `tokenizer peak ${tokenizer.peak} must stay within the bound`);
    assert.equal(tokenizer.calls, 4, 'every symbol keeps its tokenizer probe');
    for (const name of ['sym01', 'sym02', 'sym03', 'sym04']) {
      assert.equal(provider.count(name), 1, `${name} must be inferred exactly once â€” no duplicate or dropped job`);
    }
  } finally {
    consoleStub.restore();
    gate.open();
    if (run) await run.catch(() => {});
  }
});

test('explicit concurrency 3 raises the peak to three without exceeding the bound', async () => {
  const fixture = await createFixture(['sym03', 'sym01', 'sym04', 'sym02']);
  const gate = createGate();
  const provider = trackedProvider(gate);
  const consoleStub = stubConsole();

  let run;
  try {
    run = main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      concurrency: 3,
      countPromptTokensImpl: trackedTokenizer().impl,
      runEnrichmentWithFallbackImpl: provider.impl,
    });

    await waitFor(() => provider.starts.length === 3,
      'three independent provider jobs must run concurrently under concurrency 3');
    assert.equal(provider.peak, 3, 'throughput scales with the configured concurrency');
    assert.equal(provider.starts.length, 3, 'the fourth job must wait for a free slot');

    gate.open();
    const output = lastJsonLog(await withConsole(consoleStub, () => run));
    assert.equal(output.enriched, 4);
    assert.equal(provider.peak, 3, 'the peak never exceeds the bound');
    for (const name of ['sym01', 'sym02', 'sym03', 'sym04']) {
      assert.equal(provider.count(name), 1);
    }
  } finally {
    consoleStub.restore();
    gate.open();
    if (run) await run.catch(() => {});
  }
});

test('a gated tokenizer probe proves the tokenizer jobs are bounded by the same slot pool', async () => {
  const fixture = await createFixture(['sym01', 'sym02', 'sym03', 'sym04']);
  const tokenizerGate = createGate();
  const tokenizer = trackedTokenizer();
  tokenizer.gate = tokenizerGate;
  const provider = trackedProvider(null);
  const consoleStub = stubConsole();

  let run;
  try {
    run = main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      concurrency: 2,
      countPromptTokensImpl: tokenizer.impl,
      runEnrichmentWithFallbackImpl: provider.impl,
    });

    await waitFor(() => tokenizer.active === 2 && tokenizer.calls === 2,
      'two tokenizer probes must hold the two slots while a third never starts');
    assert.equal(tokenizer.peak, 2, 'the tokenizer never exceeds the bound');
    assert.equal(tokenizer.calls, 2, 'no third tokenizer probe may start while both slots are held');
    assert.equal(provider.starts.length, 0, 'no provider may run while tokenization still holds every slot');

    tokenizerGate.open();
    const output = lastJsonLog(await withConsole(consoleStub, () => run));
    assert.equal(output.enriched, 4);
    assert.equal(tokenizer.calls, 4);
    assert.ok(tokenizer.peak <= 2, `tokenizer peak ${tokenizer.peak} must stay within the bound`);
    assert.equal(provider.peak <= 2, true);
  } finally {
    consoleStub.restore();
    tokenizerGate.open();
    if (run) await run.catch(() => {});
  }
});

// -------------------------------------------------------------------
// 2. PMC_CONCURRENCY environment is the real default bound.
// -------------------------------------------------------------------

test('PMC_CONCURRENCY from the environment drives the default run bound through a fresh module import', async () => {
  const fixture = await createFixture(['sym03', 'sym01', 'sym04', 'sym02']);
  const gate = createGate();
  const provider = trackedProvider(gate);
  const consoleStub = stubConsole();

  savedEnv.set('PMC_CONCURRENCY', process.env.PMC_CONCURRENCY);
  process.env.PMC_CONCURRENCY = '2';
  let freshQueue;
  try {
    // Cache-busted import so the module constant re-reads the environment;
    // the env value is restored immediately after the import captures it.
    freshQueue = await import('../cli/enrich-queue.mjs?pmc-concurrency-env=2');
  } finally {
    const value = savedEnv.get('PMC_CONCURRENCY');
    if (value === undefined) delete process.env.PMC_CONCURRENCY;
    else process.env.PMC_CONCURRENCY = value;
    savedEnv.delete('PMC_CONCURRENCY');
  }

  let run;
  try {
    // NO explicit concurrency parameter: this is the actual default path.
    run = freshQueue.main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      countPromptTokensImpl: trackedTokenizer().impl,
      runEnrichmentWithFallbackImpl: provider.impl,
    });

    await waitFor(() => provider.starts.length === 2,
      'PMC_CONCURRENCY=2 must bound the default run to two concurrent provider jobs');
    assert.equal(provider.peak, 2, 'the environment default must produce overlapping bounded jobs');
    assert.equal(provider.starts.length, 2, 'a third job must wait under the environment bound');

    gate.open();
    const output = lastJsonLog(await withConsole(consoleStub, () => run));
    assert.equal(output.enriched, 4);
    assert.equal(provider.peak, 2, 'the environment default is honored for the whole run');
  } finally {
    consoleStub.restore();
    gate.open();
    if (run) await run.catch(() => {});
  }
});

// -------------------------------------------------------------------
// 3. A malformed explicit bound rejects before any mutation.
// -------------------------------------------------------------------

test('a malformed explicit concurrency rejects before any file write or provider call', async () => {
  const fixture = await createFixture(['sym01', 'sym02']);
  const before = await readFile(fixture.worklistFile, 'utf8');
  const provider = trackedProvider(null);
  const tokenizer = trackedTokenizer();

  for (const badValue of [0, 'abc']) {
    await assert.rejects(
      main({
        projectRoot: fixture.projectRoot,
        config: fixtureConfig(),
        providers: [],
        concurrency: badValue,
        countPromptTokensImpl: tokenizer.impl,
        runEnrichmentWithFallbackImpl: provider.impl,
      }),
      TypeError,
      `concurrency ${JSON.stringify(badValue)} must reject with TypeError`,
    );
  }

  assert.equal(provider.starts.length, 0, 'a rejected bound must never reach a provider');
  assert.equal(tokenizer.calls, 0, 'a rejected bound must never reach the tokenizer');
  assert.equal(await readFile(fixture.worklistFile, 'utf8'), before, 'the worklist must be untouched');
  await assert.rejects(access(join(fixture.dirs.enrichment, 'queue-state.json')), { code: 'ENOENT' },
    'no queue state may be written by a rejected run');
});

// -------------------------------------------------------------------
// 4. Deterministic aggregation and full settlement before the final report.
// -------------------------------------------------------------------

test('completions released in reverse order still produce the original selected order in the final output', async () => {
  const worklistOrder = ['sym03', 'sym01', 'sym04', 'sym02'];
  const fixture = await createFixture(worklistOrder);
  const gates = new Map(worklistOrder.map((name) => [name, createGate()]));
  const provider = trackedProvider(null, { perSymbolGate: (name) => gates.get(name) });
  const consoleStub = stubConsole();

  let run;
  try {
    run = main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      concurrency: 4,
      countPromptTokensImpl: trackedTokenizer().impl,
      runEnrichmentWithFallbackImpl: provider.impl,
    });

    await waitFor(() => provider.starts.length === 4, 'all four independent jobs must start under bound 4');

    // Release in reverse worklist order: completion order is the opposite of
    // the selected order.
    for (const name of ['sym02', 'sym04', 'sym01', 'sym03']) {
      gates.get(name).open();
    }

    const output = lastJsonLog(await withConsole(consoleStub, () => run));

    const expectedKeys = worklistOrder.map((name) => makeSymbol(name).symbolKey);
    assert.deepEqual(output.timing.map((entry) => entry.symbolKey), expectedKeys,
      'the aggregate timing array must follow the ORIGINAL selected worklist order, not completion order');
    assert.equal(output.enriched, 4);
    assert.equal(output.complete, true);

    const persisted = await readJsonArtifact(fixture.worklistFile);
    assert.deepEqual(persisted.map((entry) => entry.symbolKey), expectedKeys,
      'worklist record order must be preserved');
    assert.ok(persisted.every((entry) => entry.status === 'enriched'));
  } finally {
    consoleStub.restore();
    for (const gate of gates.values()) gate.open();
    if (run) await run.catch(() => {});
  }
});

test('every job is settled before the final report, final index write and background sync are attempted', async () => {
  const fixture = await createFixture(['sym01', 'sym02', 'sym03', 'sym04']);
  const gate = createGate();
  const provider = trackedProvider(gate);
  const consoleStub = stubConsole();

  let settled = false;
  let run;
  try {
    run = main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      concurrency: 4,
      countPromptTokensImpl: trackedTokenizer().impl,
      runEnrichmentWithFallbackImpl: provider.impl,
    });
    run.then(() => { settled = true; }, () => { settled = true; });

    await waitFor(() => provider.starts.length === 4, 'all jobs must be in flight');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'main must not resolve while a provider job is still gated');
    assert.equal(spawnCalls.length, 0, 'no background sync may be spawned while jobs are pending');
    const inFlight = await readJsonArtifact(fixture.worklistFile);
    assert.ok(inFlight.every((entry) => entry.status === 'pending'),
      'no partial final persistence may happen before all jobs settle');

    gate.open();
    const output = lastJsonLog(await withConsole(consoleStub, () => run));
    assert.equal(settled, true);
    assert.equal(output.enriched, 4);
    assert.ok(spawnCalls.length >= 1, 'the background sync is attempted only after full settlement');

    const finalIndex = await readJsonArtifact(fixture.symbolIndexFile);
    for (const name of ['sym01', 'sym02', 'sym03', 'sym04']) {
      assert.equal(finalIndex[makeSymbol(name).symbolKey].status, 'enriched',
        'the final index write happens after every job settled');
    }
    const queueState = await readJsonArtifact(join(fixture.dirs.enrichment, 'queue-state.json'));
    assert.equal(queueState.status, 'finished');
  } finally {
    consoleStub.restore();
    gate.open();
    if (run) await run.catch(() => {});
  }
});

// -------------------------------------------------------------------
// 5. SCC barrier: callees settle before the caller's tokenizer/prompt, and
//    the caller prompt carries the NEW same-run summaries, never the stale
//    resolver text.
// -------------------------------------------------------------------

const ALPHA_KEY = 'js|src/alpha.js|function|exported|alpha|1';
const BETA_KEY = 'js|src/beta.js|function|exported|beta|1';
const OMEGA_KEY = 'js|src/omega.js|function|exported|omega|1';
const STALE_ALPHA_SUMMARY = 'Stale resolver summary for alpha.';
const STALE_BETA_SUMMARY = 'Stale resolver summary for beta.';
const NEW_ALPHA_SUMMARY = 'Fresh alpha summary from this run.';
const NEW_BETA_SUMMARY = 'Fresh beta summary from this run.';

function narrativeContextFor(symbolKey, { callees = [], symbolKeys }) {
  const name = symbolKey.split('|')[4];
  return {
    symbolKeys,
    signature: `export function ${name}(value)`,
    role: { role: 'util', layer: 'shared', confidence: 0.85, evidence: [] },
    callees,
    callers: [],
    fileCardSummary: 'Fixture module.',
    projectRules: [],
  };
}

test('a diamond caller resolves AFTER both callees settle and its prompt carries the NEW summaries, not the stale resolver text', async () => {
  // Caller FIRST in the worklist: a resolver-in-loop (stale-at-processing)
  // implementation would build the caller prompt from the stale text.
  const fixture = await createFixture(['omega', 'alpha', 'beta']);
  const events = [];
  let omegaRequest = null;

  const resolver = async (symbol) => {
    if (symbol.symbolKey === OMEGA_KEY) {
      return narrativeContextFor(OMEGA_KEY, {
        symbolKeys: [OMEGA_KEY, ALPHA_KEY, BETA_KEY],
        callees: [
          { key: ALPHA_KEY, name: 'alpha', summary: STALE_ALPHA_SUMMARY },
          { key: BETA_KEY, name: 'beta', summary: STALE_BETA_SUMMARY },
        ],
      });
    }
    if (symbol.symbolKey === ALPHA_KEY) {
      return narrativeContextFor(ALPHA_KEY, { symbolKeys: [ALPHA_KEY] });
    }
    return narrativeContextFor(BETA_KEY, { symbolKeys: [BETA_KEY] });
  };

  const tokenizer = trackedTokenizer();
  const tokenizerImpl = async (input) => {
    events.push(`tokenizer:${symbolNameOf(input.prompt)}`);
    return tokenizer.impl(input);
  };

  const provider = trackedProvider(null, {
    resultFor: (name, request) => {
      if (name === 'omega') omegaRequest = request;
      const summary = name === 'alpha' ? NEW_ALPHA_SUMMARY
        : name === 'beta' ? NEW_BETA_SUMMARY
          : 'Orchestrates both helpers.';
      return JSON.stringify({
        summary,
        behavior: [`${name} behavior.`],
        sideEffects: [],
        errors: [],
        contracts: [],
        changeNotes: 'Keep the call order.',
        mentions: name === 'omega' ? [ALPHA_KEY, BETA_KEY] : [],
      });
    },
  });
  const providerImpl = async (input) => {
    const name = symbolNameOf(input.request.prompt);
    events.push(`provider-start:${name}`);
    const result = await provider.impl(input);
    events.push(`provider-end:${name}`);
    return result;
  };

  const consoleStub = stubConsole();
  try {
    const output = lastJsonLog(await withConsole(consoleStub, () => main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      concurrency: 3,
      narrativeResolver: resolver,
      countPromptTokensImpl: tokenizerImpl,
      runEnrichmentWithFallbackImpl: providerImpl,
    })));

    assert.equal(output.enriched, 3);
    assert.equal(output.errors, 0);

    for (const callee of ['alpha', 'beta']) {
      assert.ok(
        events.indexOf(`tokenizer:omega`) > events.indexOf(`provider-end:${callee}`),
        `the caller tokenizer must run only after ${callee} settled (${events.join(', ')})`,
      );
      assert.equal(provider.count(callee), 1, `${callee} must be inferred exactly once`);
    }
    assert.equal(provider.count('omega'), 1);

    // The fresh-at-barrier overlay: the caller prompt shows the SAME-RUN
    // accepted summaries and never the stale resolver text.
    assert.ok(omegaRequest.prompt.includes(NEW_ALPHA_SUMMARY), 'caller prompt must carry the fresh alpha summary');
    assert.ok(omegaRequest.prompt.includes(NEW_BETA_SUMMARY), 'caller prompt must carry the fresh beta summary');
    assert.ok(!omegaRequest.prompt.includes(STALE_ALPHA_SUMMARY), 'the stale resolver summary must never reach the prompt');
    assert.ok(!omegaRequest.prompt.includes(STALE_BETA_SUMMARY), 'the stale resolver summary must never reach the prompt');

    // N5B alignment: the accepted caller fingerprint hashes the NEW summaries.
    const persisted = await readJsonArtifact(fixture.worklistFile);
    const omega = persisted.find((entry) => entry.symbolKey === OMEGA_KEY);
    assert.equal(omega.status, 'enriched');
    const calleeSummaryHashes = await hashCalleeSummaries({
      [ALPHA_KEY]: NEW_ALPHA_SUMMARY,
      [BETA_KEY]: NEW_BETA_SUMMARY,
    });
    assert.deepEqual(omega.calleeSummaryHashes, calleeSummaryHashes,
      'the accepted fingerprint must describe the fresh summaries the model actually saw');
    const context = await resolver(makeSymbol('omega'));
    assert.equal(omega.narrativeHash, await computeNarrativeHash({
      code: branchySource('omega').split('\n').slice(0, 6).join('\n'),
      signature: context.signature,
      role: context.role,
      calleeSummaryHashes,
      promptVersion: 'v2',
    }));

    // Zero invalid mentions: the persisted narrative only names graph keys.
    const memory = await readJsonArtifact(join(
      fixture.dirs.enrichment,
      `${OMEGA_KEY.replace(/[^a-zA-Z0-9_-]+/g, '_')}.memory.json`,
    ));
    const mentions = JSON.parse(memory.content).mentions;
    assert.deepEqual(mentions, [ALPHA_KEY, BETA_KEY]);
    for (const mention of mentions) assert.ok([OMEGA_KEY, ALPHA_KEY, BETA_KEY].includes(mention));
  } finally {
    consoleStub.restore();
  }
});

test('a mutual cycle resolves exactly once per member at the barrier before either provider runs, then converges without extra LLM calls', async () => {
  const fixture = await createFixture(['alpha', 'beta']);
  const events = [];
  const STATIC_ALPHA_SUMMARY = 'Static resolver summary for alpha.';
  const STATIC_BETA_SUMMARY = 'Static resolver summary for beta.';

  const resolver = async (symbol) => {
    events.push(`resolve:${symbol.name}`);
    if (symbol.symbolKey === ALPHA_KEY) {
      return narrativeContextFor(ALPHA_KEY, {
        symbolKeys: [ALPHA_KEY, BETA_KEY],
        callees: [{ key: BETA_KEY, name: 'beta', summary: STATIC_BETA_SUMMARY }],
      });
    }
    return narrativeContextFor(BETA_KEY, {
      symbolKeys: [ALPHA_KEY, BETA_KEY],
      callees: [{ key: ALPHA_KEY, name: 'alpha', summary: STATIC_ALPHA_SUMMARY }],
    });
  };

  const provider = trackedProvider(null, {
    resultFor: (name) => JSON.stringify({
      summary: name === 'alpha' ? 'Alpha narrative summary.' : 'Beta narrative summary.',
      behavior: [`${name} behavior.`],
      sideEffects: [],
      errors: [],
      contracts: [],
      changeNotes: 'Keep the branch.',
      mentions: [],
    }),
  });
  const providerImpl = async (input) => {
    const name = symbolNameOf(input.request.prompt);
    events.push(`provider-start:${name}`);
    const result = await provider.impl(input);
    events.push(`provider-end:${name}`);
    return result;
  };

  const consoleStub = stubConsole();
  try {
    const first = lastJsonLog(await withConsole(consoleStub, () => main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      concurrency: 2,
      narrativeResolver: resolver,
      countPromptTokensImpl: trackedTokenizer().impl,
      runEnrichmentWithFallbackImpl: providerImpl,
    })));

    assert.equal(first.enriched, 2);
    assert.equal(first.errors, 0);
    // One cycle = one SCC: discovery (2) + one prepare pass (2) â€” all four
    // resolutions happen before EITHER provider starts. A resolver-in-loop
    // implementation interleaves resolution with inference instead.
    const resolveIndexes = events.map((event, index) => (event.startsWith('resolve:') ? index : -1)).filter((index) => index >= 0);
    const providerIndexes = events.map((event, index) => (event.startsWith('provider-start:') ? index : -1)).filter((index) => index >= 0);
    assert.equal(resolveIndexes.length, 4, 'two discovery resolutions plus one two-member barrier preparation');
    assert.ok(Math.max(...resolveIndexes) < Math.min(...providerIndexes),
      `every cycle member must be resolved at the barrier before any inference starts (${events.join(', ')})`);
    assert.equal(provider.count('alpha'), 1);
    assert.equal(provider.count('beta'), 1);

    // Second pass: both entries reuse their accepted fingerprints â€” the cycle
    // converged in ONE pass, no fixpoint loop, no extra model call.
    const second = lastJsonLog(await withConsole(consoleStub, () => main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      concurrency: 2,
      narrativeResolver: resolver,
      countPromptTokensImpl: trackedTokenizer().impl,
      runEnrichmentWithFallbackImpl: providerImpl,
    })));
    assert.equal(second.enriched, 2);
    assert.equal(provider.count('alpha'), 1, 'an unchanged cycle member must not regenerate');
    assert.equal(provider.count('beta'), 1, 'an unchanged cycle member must not regenerate');
    assert.ok(consoleStub.errors.filter((line) => line.includes('REUSE')).length >= 2,
      'the second pass reports accepted-cache reuses for both cycle members');
  } finally {
    consoleStub.restore();
  }
});

// -------------------------------------------------------------------
// 6. Caller/callee edit immunity (S11 + S12): a caller edit never re-runs
//    the callee, and an unchanged callee summary never re-runs the caller.
// -------------------------------------------------------------------

function simpleNarrative(summary) {
  return {
    summary,
    behavior: ['Behavior.'],
    sideEffects: [],
    errors: [],
    contracts: [],
    changeNotes: 'Keep it stable.',
    mentions: [],
  };
}

async function runNarrativeMain(fixture, { resolver, provider, concurrency = 2 }) {
  const consoleStub = stubConsole();
  try {
    const output = lastJsonLog(await withConsole(consoleStub, () => main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      concurrency,
      narrativeResolver: resolver,
      countPromptTokensImpl: trackedTokenizer().impl,
      runEnrichmentWithFallbackImpl: provider.impl,
    })));
    return { output, consoleStub: { errors: consoleStub.errors, logs: consoleStub.logs } };
  } finally {
    consoleStub.restore();
  }
}

async function withConsole(consoleStub, fn) {
  // Console is already stubbed by the caller; await the run, then hand back
  // the stub so the caller can read the final JSON line.
  await fn();
  return consoleStub;
}

test('editing a caller never re-runs the callee, and the caller prompt still carries the accepted callee summary', async () => {
  const CALLEE_SUMMARY = 'Normalizes a raw value.';
  const fixture = await createFixture(['alpha', 'omega']);
  const resolver = async (symbol) => {
    if (symbol.symbolKey === OMEGA_KEY) {
      return narrativeContextFor(OMEGA_KEY, {
        symbolKeys: [OMEGA_KEY, ALPHA_KEY],
        callees: [{ key: ALPHA_KEY, name: 'alpha', summary: CALLEE_SUMMARY }],
      });
    }
    return narrativeContextFor(ALPHA_KEY, { symbolKeys: [ALPHA_KEY] });
  };
  const provider = trackedProvider(null, {
    resultFor: (name) => JSON.stringify(simpleNarrative(
      name === 'alpha' ? CALLEE_SUMMARY : 'Consumes the normalized value.',
    )),
  });

  const first = await runNarrativeMain(fixture, { resolver, provider });
  assert.equal(first.output.enriched, 2);
  assert.equal(provider.count('alpha'), 1);
  assert.equal(provider.count('omega'), 1);

  const alphaMemoryFile = join(
    fixture.dirs.enrichment,
    `${ALPHA_KEY.replace(/[^a-zA-Z0-9_-]+/g, '_')}.memory.json`,
  );
  const alphaBytesBefore = await readFile(alphaMemoryFile, 'utf8');
  const alphaWorklistBefore = (await readJsonArtifact(fixture.worklistFile))
    .find((entry) => entry.symbolKey === ALPHA_KEY);

  // Caller-only edit.
  await writeFile(join(fixture.projectRoot, 'src', 'omega.js'), [
    'export function omega(value) {',
    '  if (!value) {',
    "    throw new TypeError('value required');",
    '  }',
    '  return String(value).toUpperCase();',
    '}',
    '',
    '// padding line one',
    '// padding line two',
    '',
  ].join('\n'), 'utf8');

  let omegaPrompt = null;
  const secondProvider = trackedProvider(null, {
    resultFor: () => JSON.stringify(simpleNarrative('Consumes the normalized value (edited).')),
  });
  // Capture the caller prompt from the request stream instead of the result.
  const captureProvider = async (input) => {
    if (symbolNameOf(input.request.prompt) === 'omega') omegaPrompt = input.request.prompt;
    return secondProvider.impl(input);
  };

  const second = await runNarrativeMain(fixture, {
    resolver,
    provider: { impl: captureProvider },
  });

  assert.equal(second.output.enriched, 2);
  assert.equal(secondProvider.count('alpha'), 0,
    'editing a caller must never re-run the LLM on the callee');
  assert.equal(secondProvider.count('omega'), 1, 'the edited caller regenerates exactly once');
  assert.ok(typeof omegaPrompt === 'string' && omegaPrompt.includes(CALLEE_SUMMARY),
    'the regenerated caller prompt still carries the accepted callee summary');
  assert.ok(second.consoleStub.errors.some((line) => line.includes('REUSE') && line.includes('alpha')),
    'the unchanged callee is reported as an accepted-cache reuse');

  assert.equal(await readFile(alphaMemoryFile, 'utf8'), alphaBytesBefore,
    'the accepted callee memory bytes stay untouched');
  const alphaAfter = (await readJsonArtifact(fixture.worklistFile))
    .find((entry) => entry.symbolKey === ALPHA_KEY);
  assert.equal(alphaAfter.narrativeHash, alphaWorklistBefore.narrativeHash,
    'the accepted callee fingerprint is preserved');
  assert.equal(alphaAfter.memoryId, alphaWorklistBefore.memoryId,
    'the accepted callee memory reference is preserved');
  assert.ok(['enriched', 'already_enriched'].includes(alphaAfter.status),
    'the callee stays in an accepted status — never stale or error after a caller-only edit');
  assert.ok(!('staleReason' in alphaAfter),
    'a caller-only edit must not propagate staleness onto the callee');
});

test('a callee regeneration whose summary text is byte-identical never re-runs the caller', async () => {
  const CALLEE_SUMMARY = 'Normalizes a raw value.';
  const fixture = await createFixture(['alpha', 'omega']);
  const resolver = async (symbol) => {
    if (symbol.symbolKey === OMEGA_KEY) {
      return narrativeContextFor(OMEGA_KEY, {
        symbolKeys: [OMEGA_KEY, ALPHA_KEY],
        callees: [{ key: ALPHA_KEY, name: 'alpha', summary: CALLEE_SUMMARY }],
      });
    }
    return narrativeContextFor(ALPHA_KEY, { symbolKeys: [ALPHA_KEY] });
  };
  const provider = trackedProvider(null, {
    resultFor: (name) => JSON.stringify(simpleNarrative(
      name === 'alpha' ? CALLEE_SUMMARY : 'Consumes the normalized value.',
    )),
  });

  const first = await runNarrativeMain(fixture, { resolver, provider });
  assert.equal(first.output.enriched, 2);

  const omegaWorklistBefore = (await readJsonArtifact(fixture.worklistFile))
    .find((entry) => entry.symbolKey === OMEGA_KEY);
  const omegaMemoryFile = join(
    fixture.dirs.enrichment,
    `${OMEGA_KEY.replace(/[^a-zA-Z0-9_-]+/g, '_')}.memory.json`,
  );
  const omegaBytesBefore = await readFile(omegaMemoryFile, 'utf8');

  // Callee-only edit: the callee must regenerate, and it produces the SAME
  // summary text as before.
  await writeFile(join(fixture.projectRoot, 'src', 'alpha.js'), [
    'export function alpha(value) {',
    '  if (!value) {',
    "    throw new TypeError('value required');",
    '  }',
    '  return String(value).trim().toLowerCase();',
    '}',
    '',
    '// padding line one',
    '// padding line two',
    '',
  ].join('\n'), 'utf8');

  const second = await runNarrativeMain(fixture, { resolver, provider });
  assert.equal(second.output.enriched, 2);
  assert.equal(provider.count('alpha'), 2, 'the edited callee regenerates exactly once per pass');
  assert.equal(provider.count('omega'), 1,
    'an unchanged summary text must never trigger a caller regeneration');
  assert.ok(second.consoleStub.errors.some((line) => line.includes('REUSE') && line.includes('omega')),
    'the caller reuses its accepted fingerprint after the callee pass');

  const omegaAfter = (await readJsonArtifact(fixture.worklistFile))
    .find((entry) => entry.symbolKey === OMEGA_KEY);
  assert.equal(omegaAfter.narrativeHash, omegaWorklistBefore.narrativeHash,
    'the caller fingerprint is untouched when the callee summary text did not change');
  assert.equal(await readFile(omegaMemoryFile, 'utf8'), omegaBytesBefore,
    'the caller memory bytes stay untouched');
});

// -------------------------------------------------------------------
// 7. Legacy baseline parity at concurrency 1 (keysets, requests, content,
//    aggregate order) and the legacy error/empty cases.
// -------------------------------------------------------------------

test('concurrency 1 legacy run keeps the exact request keysets, per-symbol prompt bytes and aggregate order', async () => {
  const worklistOrder = ['sym03', 'sym01', 'sym04', 'sym02'];
  const fixture = await createFixture(worklistOrder);
  const provider = trackedProvider(null);
  const tokenizer = trackedTokenizer();
  const consoleStub = stubConsole();

  try {
    const output = lastJsonLog(await withConsole(consoleStub, () => main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      concurrency: 1,
      countPromptTokensImpl: tokenizer.impl,
      runEnrichmentWithFallbackImpl: provider.impl,
    })));

    // Request shape: legacy keyset, no format, byte-identical prompt text.
    assert.equal(provider.requests.length, 4);
    const expectedPrompts = new Map();
    for (const name of worklistOrder) {
      const { prompt } = await buildSymbolPromptMeta(makeSymbol(name), fixture.projectRoot);
      expectedPrompts.set(name, prompt);
    }
    const seenPrompts = new Map();
    for (const { name, request } of provider.requests) {
      assert.deepEqual(Object.keys(request).sort(), ['prompt', 'timeoutMs'],
        'legacy requests keep their exact keyset');
      assert.ok(!('format' in request), 'legacy requests never gain a format key');
      assert.equal(request.prompt, expectedPrompts.get(name),
        `the legacy prompt for ${name} stays byte-identical`);
      seenPrompts.set(name, request.prompt);
    }
    assert.deepEqual([...seenPrompts.keys()].sort(), [...expectedPrompts.keys()].sort());

    // Bound: sequential at 1.
    assert.equal(provider.peak, 1, 'concurrency 1 must stay strictly sequential');

    // Aggregate output keyset and canonical order.
    assert.deepEqual(Object.keys(output).sort(), [
      'avgSymbolTimeSeconds',
      'complete',
      'enriched',
      'errors',
      'pending',
      'resultsPerSecond',
      'subagentQueued',
      'timing',
      'total',
      'totalElapsedSeconds',
    ]);
    assert.deepEqual(output.timing.map((entry) => entry.symbolKey),
      worklistOrder.map((name) => makeSymbol(name).symbolKey),
      'the aggregate order stays the original selected order');
    assert.equal(output.complete, true);
    assert.equal(output.enriched, 4);
    assert.equal(output.errors, 0);
    assert.equal(output.subagentQueued, 0);
    assert.equal(tokenizer.calls, 4);
    for (const name of worklistOrder) assert.equal(provider.count(name), 1);

    // Final summary parity from the persisted state.
    const summary = await readJsonArtifact(fixture.worklistFile);
    assert.ok(summary.every((entry) => entry.status === 'enriched'));
    assert.ok(!('narrativeHash' in summary[0]), 'legacy entries stay free of narrative metadata');
  } finally {
    consoleStub.restore();
  }
});

test('a provider failure still counts as one honest error while independent jobs continue (legacy, no format)', async () => {
  const fixture = await createFixture(['sym01', 'sym02', 'sym03']);
  const failing = 'sym02';
  const provider = trackedProvider(null, {
    resultFor: () => 'Legacy enrichment text.',
  });
  const failingImpl = async (input) => {
    const name = symbolNameOf(input.request.prompt);
    if (name === failing) {
      provider.starts.push(name);
      provider.perKey.set(name, (provider.perKey.get(name) ?? 0) + 1);
      provider.requests.push({ name, request: input.request });
      return {
        status: 'error',
        content: null,
        mode: null,
        provider: null,
        model: null,
        attempts: [
          {
            mode: 'local-model',
            provider: 'ollama',
            model: 'fixture-model',
            status: 'failed',
            errorType: 'network',
            errorMessage: 'ECONNREFUSED',
            startedAt: '2026-10-15T12:00:00.000Z',
            endedAt: '2026-10-15T12:00:01.000Z',
          },
        ],
      };
    }
    return provider.impl(input);
  };

  const consoleStub = stubConsole();
  try {
    const output = lastJsonLog(await withConsole(consoleStub, () => main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      concurrency: 3,
      countPromptTokensImpl: trackedTokenizer().impl,
      runEnrichmentWithFallbackImpl: failingImpl,
    })));

    assert.equal(output.errors, 1, 'the async failure counts through the existing status rules');
    assert.equal(output.enriched, 2);
    assert.equal(provider.count(failing), 1, 'a failed inference is never retried by the pool');
    assert.equal(provider.count('sym01'), 1);
    assert.equal(provider.count('sym03'), 1);

    const persisted = await readJsonArtifact(fixture.worklistFile);
    const failed = persisted.find((entry) => entry.symbolKey === makeSymbol(failing).symbolKey);
    assert.equal(failed.status, 'error');
    assert.match(failed.error, /ECONNREFUSED/);
    assert.ok(consoleStub.errors.some((line) => line.includes('[queue] ERROR')),
      'the failure is reported through the existing progress format');
    assert.ok(spawnCalls.length >= 1, 'the retry-errors launch goes through the intercepted spawn, never a real process');
  } finally {
    consoleStub.restore();
  }
});

test('an empty selection finishes without any provider or tokenizer call', async () => {
  const fixture = await createFixture(['sym01', 'sym02']);
  const enriched = (await readJsonArtifact(fixture.worklistFile)).map((entry) => ({
    ...entry,
    status: 'enriched',
    memoryId: `queue-${entry.name}`,
  }));
  await writeJson(fixture.worklistFile, enriched);

  const provider = trackedProvider(null);
  const tokenizer = trackedTokenizer();
  const consoleStub = stubConsole();
  try {
    const output = lastJsonLog(await withConsole(consoleStub, () => main({
      projectRoot: fixture.projectRoot,
      config: fixtureConfig(),
      providers: [],
      countPromptTokensImpl: tokenizer.impl,
      runEnrichmentWithFallbackImpl: provider.impl,
    })));
    assert.equal(output.complete, true);
    assert.equal(provider.starts.length, 0, 'an empty queue must never reach a provider');
    assert.equal(tokenizer.calls, 0, 'an empty queue must never reach the tokenizer');
  } finally {
    consoleStub.restore();
  }
});

// -------------------------------------------------------------------
// 8. Bounded file-lock retry around the actual acceptance writes: the FILE
//    operation retries, the inference never does, and an exhausted or
//    non-lock failure is visible instead of a false DONE/accepted success.
// -------------------------------------------------------------------

function baseRunnerArgs(fixture, symbol) {
  return {
    symbol,
    projectRoot: fixture.projectRoot,
    projectSlug: 'n6b-fixture',
    timeoutMs: 30_000,
    enrichmentDir: fixture.dirs.enrichment,
    worklist: [],
    worklistFile: fixture.worklistFile,
    symbolIndex: {},
    symbolIndexFile: fixture.symbolIndexFile,
    config: { preferredModes: ['local-model'] },
    providers: [],
  };
}

async function freshRunnerFixture() {
  const fixture = await createFixture(['sym01']);
  const worklist = await readJsonArtifact(fixture.worklistFile);
  const symbolIndex = await readJsonArtifact(fixture.symbolIndexFile);
  return { fixture, worklist, symbolIndex, symbol: makeSymbol('sym01') };
}

test('two transient lock failures on the acceptance write retry the FILE only: exactly one inference, bounded backoff, accepted state persisted', async () => {
  const { fixture, worklist, symbolIndex, symbol } = await freshRunnerFixture();
  const realWriteFile = (await import('node:fs/promises')).writeFile;
  const delays = [];
  let writeFailures = 0;
  let providerCalls = 0;

  installFileOps({
    writeFile: async (path, data, encoding) => {
      if (writeFailures < 2) {
        writeFailures += 1;
        throw codeError(writeFailures === 1 ? 'EBUSY' : 'EPERM');
      }
      return realWriteFile(path, data, encoding);
    },
    sleep: async (ms) => { delays.push(ms); },
  });

  try {
    const result = await runQueueSymbolEnrichment({
      ...baseRunnerArgs(fixture, symbol),
      worklist,
      symbolIndex,
      runEnrichmentWithFallbackImpl: async () => {
        providerCalls += 1;
        return succeededTextResult('Legacy enrichment text.');
      },
    });

    assert.equal(result.status, 'enriched');
    assert.equal(providerCalls, 1, 'the file-lock remedy must never re-run the inference (1, not 3)');
    assert.equal(writeFailures, 2, 'both transient lock failures were retried');
    assert.deepEqual(delays, [15, 30], 'the backoff stays small and bounded');

    const persisted = await readJsonArtifact(fixture.worklistFile);
    assert.equal(persisted[0].status, 'enriched');
    const memory = await readJsonArtifact(join(
      fixture.dirs.enrichment,
      `${symbol.symbolKey.replace(/[^a-zA-Z0-9_-]+/g, '_')}.memory.json`,
    ));
    assert.equal(memory.content, 'Legacy enrichment text.');
  } finally {
    restoreFileOps();
    restoreFileOps = null;
  }
});

test('a non-lock EIO on the acceptance write fails immediately: no retry, no inference retry, previous state untouched', async () => {
  const { fixture, worklist, symbolIndex, symbol } = await freshRunnerFixture();
  const before = await readFile(fixture.worklistFile, 'utf8');
  const delays = [];
  let writeFailures = 0;
  let providerCalls = 0;

  installFileOps({
    writeFile: async () => {
      writeFailures += 1;
      throw codeError('EIO', 'disk error');
    },
    sleep: async (ms) => { delays.push(ms); },
  });

  try {
    await assert.rejects(
      runQueueSymbolEnrichment({
        ...baseRunnerArgs(fixture, symbol),
        worklist,
        symbolIndex,
        runEnrichmentWithFallbackImpl: async () => {
          providerCalls += 1;
          return succeededTextResult('Legacy enrichment text.');
        },
      }),
      (error) => error.code === 'EIO',
    );

    assert.equal(writeFailures, 1, 'EIO is not a lock error â€” exactly one write attempt');
    assert.deepEqual(delays, []);
    assert.equal(providerCalls, 1, 'the inference is not retried to repair a disk error');
    assert.equal(await readFile(fixture.worklistFile, 'utf8'), before,
      'the previous worklist state stays byte-identical');
    await assert.rejects(access(join(
      fixture.dirs.enrichment,
      `${symbol.symbolKey.replace(/[^a-zA-Z0-9_-]+/g, '_')}.memory.json`,
    )), { code: 'ENOENT' }, 'no accepted artifact may be claimed');
  } finally {
    restoreFileOps();
    restoreFileOps = null;
  }
});

test('an exhausted lock retry surfaces as an honest failure: no DONE, no accepted state, exactly one inference', async () => {
  const { fixture, worklist, symbolIndex, symbol } = await freshRunnerFixture();
  const delays = [];
  let writeFailures = 0;
  let providerCalls = 0;

  installFileOps({
    writeFile: async () => {
      writeFailures += 1;
      throw codeError('EBUSY');
    },
    sleep: async (ms) => { delays.push(ms); },
  });

  try {
    await assert.rejects(
      runQueueSymbolEnrichment({
        ...baseRunnerArgs(fixture, symbol),
        worklist,
        symbolIndex,
        runEnrichmentWithFallbackImpl: async () => {
          providerCalls += 1;
          return succeededTextResult('Legacy enrichment text.');
        },
      }),
      (error) => error.code === 'EBUSY',
    );

    assert.equal(writeFailures, 4, 'the lock chain is finite: four attempts, then visible failure');
    assert.deepEqual(delays, [15, 30, 60], 'the exhausted backoff stays bounded');
    assert.equal(providerCalls, 1, 'the inference is never repeated to repair a file lock');

    const persisted = await readJsonArtifact(fixture.worklistFile);
    assert.equal(persisted[0].status, 'pending', 'an exhausted lock must never publish an accepted status');

    const files = await readdir(fixture.dirs.enrichment);
    assert.ok(!files.some((file) => file.endsWith('.memory.json')), 'no accepted artifact may exist');
    assert.ok(!files.some((file) => file.endsWith('.tmp')), 'only this runtime\u2019s own temp file is used, and it is cleaned up');
  } finally {
    restoreFileOps();
    restoreFileOps = null;
  }
});
