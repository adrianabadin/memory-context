/**
 * Independent verifier probes for F3 N3 (plan 3.3 / spec S9), retained from
 * C:/Users/aabad/AppData/Local/Temp/pmc-n3-verifier-ad7d589cf6cc40eab00ca943a16515df
 * (owned scratch, read-only copy). Public probe semantics are unchanged.
 *
 * Optional N3_BASELINE env var points at a verifier-owned baseline archive and
 * enables the baseline comparison probe; without it 12 of the 13 probes run.
 * No probe mutates workspace state: fixtures are owned temp roots removed in
 * `finally`, subprocesses and network are denied or faked, no real model runs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';

import { main, buildSymbolPromptMeta, runQueueSymbolEnrichment } from '../cli/enrich-queue.mjs';
import { main as apply } from '../cli/subagent-apply.mjs';
import { appendSubagentQueue, loadSubagentQueue } from '../src/subagent-queue.mjs';
import { NARRATIVE_SCHEMA } from '../src/cards/narrative-schema.mjs';
import { normalizeSymbolKeys } from '../src/cards/prompt-v2.mjs';
import { orderNarratives } from '../src/cards/order.mjs';
import { createLocalModelProvider } from '../src/providers/local-model-provider.mjs';

const key = 'js|src/a.js|function|exported|a|1';
const narrative = {
  summary: 'Returns one.',
  behavior: ['Return one.'],
  sideEffects: [],
  errors: [],
  contracts: [],
  changeNotes: 'Preserve the result.',
  mentions: [],
};
const symbol = {
  symbolKey: key,
  name: 'a',
  kind: 'function',
  language: 'js',
  filePath: 'src/a.js',
  range: { startLine: 1, endLine: 1 },
  codeHash: 'a',
  status: 'pending',
};
const context = {
  symbolKeys: [key],
  signature: 'function a()',
  role: { role: 'util' },
  callees: [],
  callers: [],
  fileCardSummary: 'Helpers.',
  projectRules: ['Keep pure.'],
};
const json = (x) => JSON.stringify(x, null, 2) + '\n';
const hash = (x) => createHash('sha256').update(x).digest('hex');

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'n3-own-'));
  const dir = join(root, '.planning/project-memory-context/enrichment');
  await mkdir(dir, { recursive: true });
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/a.js'), 'export function a(){return 1;}\n// padding\n// padding\n');
  const worklist = [structuredClone(symbol)];
  const index = {};
  const wl = join(dir, 'worklist.json');
  const ix = join(dir, 'symbol-index.json');
  await writeFile(wl, json(worklist));
  await writeFile(ix, json(index));
  try {
    return await fn({ root, dir, worklist, index, wl, ix });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function args(f, extra = {}) {
  return {
    symbol,
    projectRoot: f.root,
    projectSlug: 'fixture',
    timeoutMs: 1000,
    enrichmentDir: f.dir,
    worklist: f.worklist,
    worklistFile: f.wl,
    symbolIndex: f.index,
    symbolIndexFile: f.ix,
    config: { preferredModes: ['local-model'] },
    providers: [],
    ...extra,
  };
}

const success = (content) => ({ status: 'succeeded', content, mode: 'local-model', attempts: [] });

async function mute(fn) {
  const l = console.log;
  const e = console.error;
  const out = [];
  const err = [];
  console.log = (...x) => out.push(x.join(' '));
  console.error = (...x) => err.push(x.join(' '));
  try {
    return { value: await fn(), out, err };
  } finally {
    console.log = l;
    console.error = e;
  }
}

// S9: validated summary must survive the actual public loop, not only its helper.
test('S9 final main index retains validated summary', () => fixture(async (f) => {
  const cp = createRequire(import.meta.url)('node:child_process');
  const spawn = cp.spawn;
  const fetch = globalThis.fetch;
  cp.spawn = () => { throw new Error('Forbidden subprocess'); };
  syncBuiltinESMExports();
  globalThis.fetch = () => { throw new Error('Forbidden network'); };
  try {
    await mute(() => main({
      projectRoot: f.root,
      config: { preferredModes: ['local-model'], localModel: { baseUrl: 'http://127.0.0.1:0', model: 'fake' }, fileCoverageThreshold: 0.8, subagentTokenThreshold: 5000 },
      providers: [],
      narrativeResolver: () => context,
      countPromptTokensImpl: async () => 1,
      runEnrichmentWithFallbackImpl: async () => success(JSON.stringify(narrative)),
    }));
  } finally {
    cp.spawn = spawn;
    syncBuiltinESMExports();
    globalThis.fetch = fetch;
  }
  const index = JSON.parse(await readFile(f.ix, 'utf8'));
  assert.equal(index[key].semanticSummary, narrative.summary);
}));

// S9: explicitly supplied context values must not disappear on success.
test('S9 malformed supplied callee list rejects', () => fixture(async (f) => {
  await assert.rejects(
    buildSymbolPromptMeta(symbol, f.root, { narrativeContext: { ...context, callees: { key, summary: 'Returns one.' } } }),
    TypeError,
  );
}));

test('S9 raw string graph IDs are withheld from callee summaries', () => fixture(async (f) => {
  const { prompt } = await buildSymbolPromptMeta(symbol, f.root, {
    narrativeContext: { ...context, callees: [{ key: 'node_123', summary: 'RAW_ID_SHOULD_NOT_APPEAR' }] },
  });
  assert.ok(!prompt.includes('RAW_ID_SHOULD_NOT_APPEAR'));
}));

// S9: newly offered metadata cannot silently become a legacy request.
test('S9 explicitly supplied knownGraphKeys alone rejects without queue writes', () => fixture(async (f) => {
  const before = await loadSubagentQueue(f.dir);
  await assert.rejects(appendSubagentQueue(f.dir, { ...symbol, prompt: 'p', knownGraphKeys: [key] }), TypeError);
  assert.deepEqual(await loadSubagentQueue(f.dir), before);
}));

test('S9 malformed supplied knownGraphKeys rejects without queue writes', () => fixture(async (f) => {
  const before = await loadSubagentQueue(f.dir);
  await assert.rejects(
    appendSubagentQueue(f.dir, { ...symbol, prompt: 'p', promptVersion: 'v2', schema: NARRATIVE_SCHEMA, knownGraphKeys: key }),
    TypeError,
  );
  assert.deepEqual(await loadSubagentQueue(f.dir), before);
}));

// S7/S9 realistic rejection: existing accepted storage stays byte-identical.
test('S7/S9 invalid subagent mention preserves accepted files and exact error', () => fixture(async (f) => {
  const entry = await appendSubagentQueue(f.dir, { ...symbol, prompt: 'p', promptVersion: 'v2', schema: NARRATIVE_SCHEMA, knownGraphKeys: [key] });
  const file = join(f.root, 'output.json');
  await writeFile(file, JSON.stringify({ ...narrative, mentions: ['ghost'] }));
  const manifest = join(f.dir, 'sync-manifest.json');
  const memory = join(f.dir, key.replace(/[^a-zA-Z0-9_-]+/g, '_') + '.memory.json');
  await writeFile(manifest, '{"entries":[]}\n');
  await writeFile(memory, 'existing memory\n');
  const files = [f.wl, f.ix, manifest, memory];
  const before = await Promise.all(files.map(async (p) => hash(await readFile(p))));
  const result = await mute(() => apply([f.root, '--entry-id', entry.id, '--content-file', file]));
  assert.equal(result.value, 1);
  assert.deepEqual(result.out, []);
  assert.deepEqual(result.err, ['[subagent-apply] ERROR: narrative validation failed: Mention does not exist in graph: ghost']);
  assert.deepEqual(await Promise.all(files.map(async (p) => hash(await readFile(p)))), before);
}));

// S7/S9: unknown mentions retry once; malformed JSON retries once; transport doesn't.
for (const [label, content] of [
  ['mentions', JSON.stringify({ ...narrative, mentions: ['ghost'] })],
  ['JSON', '{'],
]) test('S7/S9 bounded ' + label + ' retry preserves accepted memory', () => fixture(async (f) => {
  const memory = join(f.dir, key.replace(/[^a-zA-Z0-9_-]+/g, '_') + '.memory.json');
  const manifest = join(f.dir, 'sync-manifest.json');
  await writeFile(memory, 'old\n');
  await writeFile(manifest, '{"entries":[]}\n');
  const before = await Promise.all([memory, manifest].map((p) => readFile(p)));
  let calls = 0;
  await assert.rejects(
    runQueueSymbolEnrichment(args(f, {
      narrativeContext: context,
      runEnrichmentWithFallbackImpl: async () => {
        calls++;
        return success(content);
      },
    })),
    /Narrative validation failed/,
  );
  assert.equal(calls, 2);
  assert.equal(JSON.parse(await readFile(f.wl, 'utf8'))[0].status, 'error');
  assert.deepEqual(await Promise.all([memory, manifest].map((p) => readFile(p))), before);
}));

// S9 full queue -> subagent -> apply flow uses a single shared schema.
test('S9 queue to subagent to apply preserves summary', () => fixture(async (f) => {
  const cp = createRequire(import.meta.url)('node:child_process');
  const spawn = cp.spawn;
  cp.spawn = () => { throw new Error('Denied'); };
  syncBuiltinESMExports();
  try {
    await mute(() => main({
      projectRoot: f.root,
      config: { preferredModes: ['local-model'], localModel: { baseUrl: 'http://127.0.0.1:0', model: 'fake' }, fileCoverageThreshold: 0.8 },
      providers: [],
      narrativeResolver: () => context,
      countPromptTokensImpl: async () => 9000,
      runEnrichmentWithFallbackImpl: async () => { throw new Error('Provider must not run'); },
    }));
  } finally {
    cp.spawn = spawn;
    syncBuiltinESMExports();
  }
  const entry = (await loadSubagentQueue(f.dir)).entries[0];
  assert.deepEqual(entry.schema, NARRATIVE_SCHEMA);
  const file = join(f.root, 'output.json');
  await writeFile(file, JSON.stringify(narrative));
  assert.equal((await mute(() => apply([f.root, '--entry-id', entry.id, '--content-file', file]))).value, 0);
  assert.equal(JSON.parse(await readFile(f.ix, 'utf8'))[key].semanticSummary, narrative.summary);
}));

// Optional baseline path is a verifier-owned copy; no repository mutation.
if (process.env.N3_BASELINE) test('S9 legacy prompt/request and memory match baseline exactly', () => fixture(async (f) => {
  const baseline = await import(pathToFileURL(resolve(process.env.N3_BASELINE, 'tools/project-memory-context/cli/enrich-queue.mjs')));
  const requests = [];
  const outputs = [];
  for (const api of [baseline, { runQueueSymbolEnrichment }]) {
    const result = await api.runQueueSymbolEnrichment(args(f, {
      runEnrichmentWithFallbackImpl: async ({ request }) => {
        requests.push(request);
        return success('## Responsibility\nReturns one.');
      },
    }));
    outputs.push(result.memoryContent);
  }
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(outputs[0], outputs[1]);
}));

test('S9 numeric raw graph ID is not an authoritative symbol key', () => assert.throws(() => normalizeSymbolKeys(['123']), TypeError));

test('S8 own dependency and cycle control', () => {
  const edge = (a, b) => ({ source: { id: a }, target: { id: b }, relation: 'calls' });
  const output = orderNarratives({ symbolKeys: ['a', 'b', 'c', 'z'], edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'b')] });
  assert.deepEqual(output, [['b', 'c'], ['a'], ['z']]);
});

test('S9 real driver/local fake-fetch receives schema and every context section', () => fixture(async (f) => {
  const other = 'js|src/b.js|function|exported|b|1';
  const c = {
    ...context,
    symbolKeys: [key, other],
    callees: [{ key: other, summary: 'Returns two.\nDetails.' }],
    callers: Array.from({ length: 6 }, (_, i) => ({ key: other, name: 'caller' + i, role: 'controller' })),
  };
  const provider = createLocalModelProvider({
    fetchImpl: async (url, init) => {
      if (init?.body) {
        const body = JSON.parse(init.body);
        assert.deepEqual(body.format, NARRATIVE_SCHEMA);
        for (const text of [
          'export function a(){return 1;}',
          'Signature: function a()',
          'Role: util',
          other + ': Returns two.',
          'caller4 — role: controller',
          'Helpers.',
          'Keep pure.',
        ]) assert.ok(body.prompt.includes(text), text);
        assert.ok(!body.prompt.includes('caller5'));
        return { ok: true, json: async () => ({ response: JSON.stringify(narrative) }) };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  await runQueueSymbolEnrichment(args(f, {
    narrativeContext: c,
    providers: [provider],
    config: { preferredModes: ['local-model'], localModel: { baseUrl: 'http://fixture.invalid', model: 'fake' } },
  }));
  assert.equal(JSON.parse(await readFile(f.ix, 'utf8'))[key].semanticSummary, narrative.summary);
}));
