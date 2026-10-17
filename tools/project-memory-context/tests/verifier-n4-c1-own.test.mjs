import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { main, runQueueSymbolEnrichment } from '../cli/enrich-queue.mjs';
import { buildSymbolKey } from '../src/symbol-keys.mjs';
const originalCode = 'export function a(x) {\n  return x;\n}';
const branchingCode = 'export function a(x) {\n  if (x) return 1; return 2;\n}';
const narrative = { summary: 'Provider output.', behavior: [], sideEffects: [], errors: [], contracts: [], changeNotes: 'Check behavior.', mentions: [] };
const success = () => ({ status: 'succeeded', content: JSON.stringify(narrative), mode: 'local-model', attempts: [] });
const config = { preferredModes: ['local-model'], localModel: { baseUrl: 'http://127.0.0.1:0', model: 'fake' }, fileCoverageThreshold: 2, subagentTokenThreshold: 5000 };
const encode = x => JSON.stringify(x, null, 2) + '\n';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'n4-c1-own-'));
  try {
    const dir = join(root, '.planning/project-memory-context/enrichment');
    await mkdir(dir, { recursive: true }); await mkdir(join(root, 'src'));
    const symbol = { name: 'a', language: 'js', kind: 'function', filePath: 'src/a.js', arity: 1, range: { startLine: 1, endLine: 3 }, status: 'stale', codeHash: 'old' };
    symbol.symbolKey = buildSymbolKey(symbol);
    const source = join(root, symbol.filePath), wl = join(dir, 'worklist.json'), ix = join(dir, 'symbol-index.json');
    const memory = join(dir, symbol.symbolKey.replace(/[^a-zA-Z0-9_-]+/g, '_') + '.memory.json');
    const manifest = join(dir, 'sync-manifest.json'), events = join(dir, 'provider-events.jsonl');
    await writeFile(source, originalCode);
    await writeFile(wl, encode([symbol]));
    await writeFile(ix, encode({ [symbol.symbolKey]: { memoryId: 'accepted', graphNodeId: null, codeHash: 'old', status: 'enriched', lastEnrichedAt: '2026-01-01', semanticSummary: 'Accepted summary.', customMetadata: 'keep' } }));
    await writeFile(memory, '{"content":"Accepted memory."}\n');
    await writeFile(manifest, '{"entries":[]}\n');
    await writeFile(events, '{"event":"old-history"}\n');
    const f = { root, dir, source, symbol, wl, ix, memory, manifest, events };
    return await fn(f);
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function hashAccepted(f) { return Promise.all([f.memory, f.ix, f.manifest, f.events].map(async p => sha(await readFile(p)))); }
async function runnerArgs(f, extra = {}) {
  return { symbol: f.symbol, projectRoot: f.root, projectSlug: 'fixture', timeoutMs: 1000, enrichmentDir: f.dir, worklist: JSON.parse(await readFile(f.wl, 'utf8')), worklistFile: f.wl, symbolIndex: JSON.parse(await readFile(f.ix, 'utf8')), symbolIndexFile: f.ix, config, providers: [], narrativeContext: { symbolKeys: [f.symbol.symbolKey] }, ...extra };
}
async function intercepted(f, mutation, fn) {
  const require = createRequire(import.meta.url), fs = require('node:fs/promises'), cp = require('node:child_process');
  const read = fs.readFile, spawn = cp.spawn, fetch = globalThis.fetch, log = console.log, error = console.error;
  const logs = [], errors = []; let sourceReads = 0;
  fs.readFile = async (path, ...args) => {
    const bytes = await read(path, ...args);
    if (String(path) === f.source && ++sourceReads === 1 && mutation) await mutation();
    return bytes;
  };
  cp.spawn = () => ({ pid: -1, unref() {} });
  globalThis.fetch = () => { throw new Error('Forbidden network'); };
  console.log = (...x) => logs.push(x.join(' ')); console.error = (...x) => errors.push(x.join(' ')); syncBuiltinESMExports();
  try { return { value: await fn(), logs, errors, sourceReads }; }
  finally { fs.readFile = read; cp.spawn = spawn; globalThis.fetch = fetch; console.log = log; console.error = error; syncBuiltinESMExports(); }
}
for (const outcome of ['branching', 'gone']) test('C1 own actual main: ' + outcome, () => fixture(async f => {
  const before = await hashAccepted(f); const calls = { tokenizer: 0, provider: 0 };
  const result = await intercepted(f, () => outcome === 'gone' ? rm(f.source) : writeFile(f.source, branchingCode), () => main({
    projectRoot: f.root, config, providers: [], narrativeResolver: () => ({ symbolKeys: [f.symbol.symbolKey] }),
    countPromptTokensImpl: async () => { calls.tokenizer++; return 1; },
    runEnrichmentWithFallbackImpl: async () => { calls.provider++; return success(); },
  }));
  assert.deepEqual(calls, { tokenizer: 0, provider: 0 });
  const wl = JSON.parse(await readFile(f.wl, 'utf8'));
  assert.equal(wl[0].status, 'error'); assert.equal(wl[0].attempts, undefined);
  const reason = outcome === 'gone' ? 'source-unavailable' : 'branching';
  assert.equal(wl[0].error, `Trivial-template recheck failed for ${f.symbol.symbolKey}: the symbol source changed or became unavailable after the routing bypass (reason: ${reason}). Refusing to run model providers behind bypassed routing; retry this entry through the normal queue.`);
  assert.deepEqual(await hashAccepted(f), before);
  const final = JSON.parse(result.logs.at(-1)); assert.equal(final.errors, 1); assert.equal(final.enriched, 0); assert.equal(final.complete, true);
  assert.ok(!/\bDONE\b|template narrative|no model call/i.test([...result.logs, ...result.errors].join('\n')));
  await assert.rejects(readFile(join(f.dir, 'subagent-queue.json')), { code: 'ENOENT' });
}));
test('C1 explicit strictness cannot turn branching syntax into a template', () => fixture(async f => {
  await writeFile(f.source, branchingCode); const before = await hashAccepted(f); let calls = 0;
  await assert.rejects(runQueueSymbolEnrichment(await runnerArgs(f, { prompt: 'caller claims trivial', expectTrivialTemplate: true, runEnrichmentWithFallbackImpl: async () => { calls++; return success(); } })), /source changed or became unavailable/);
  assert.equal(calls, 0); assert.deepEqual(await hashAccepted(f), before);
}));
if (process.env.N3_BASELINE) test('C1 direct runner no-flag narrative and legacy outputs match baseline', async () => {
  const baseline = await import(pathToFileURL(resolve(process.env.N3_BASELINE, 'tools/project-memory-context/cli/enrich-queue.mjs')));
  for (const legacy of [false, true]) await fixture(async f => {
    await writeFile(f.source, branchingCode); const requests = [], outputs = [];
    for (const api of [baseline, { runQueueSymbolEnrichment }]) {
      const result = await api.runQueueSymbolEnrichment(await runnerArgs(f, { narrativeContext: legacy ? null : { symbolKeys: [f.symbol.symbolKey] }, runEnrichmentWithFallbackImpl: async ({ request }) => { requests.push(request); return success(); } }));
      outputs.push(result.memoryContent);
    }
    assert.deepEqual(requests[0], requests[1]); assert.equal(outputs[0], outputs[1]);
  });
});
if (process.env.N3_BASELINE) test('C1 baseline and candidate ordinary errors preserve accepted index and complete semantics', async () => {
  const baseline = await import(pathToFileURL(resolve(process.env.N3_BASELINE, 'tools/project-memory-context/cli/enrich-queue.mjs')));
  for (const api of [baseline, { main }]) await fixture(async f => {
    await writeFile(f.source, branchingCode);
    const before = sha(await readFile(f.ix));
    const result = await intercepted(f, null, () => api.main({
      projectRoot: f.root, config, providers: [],
      narrativeResolver: () => ({ symbolKeys: [f.symbol.symbolKey] }),
      countPromptTokensImpl: async () => 1,
      runEnrichmentWithFallbackImpl: async () => ({ status: 'error', attempts: [{ mode: 'local-model', status: 'failed', errorMessage: 'fixture failure' }] }),
    }));
    const final = JSON.parse(result.logs.at(-1));
    assert.deepEqual({ complete: final.complete, enriched: final.enriched, errors: final.errors }, { complete: true, enriched: 0, errors: 1 });
    assert.equal(sha(await readFile(f.ix)), before);
    assert.equal(JSON.parse(await readFile(f.wl, 'utf8'))[0].error, 'fixture failure');
  });
});
