import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { main } from '../cli/enrich-queue.mjs';
import { setQueueStateFileOps } from '../src/cards/queue-state-io.mjs';
import { evaluateNarrativeCache } from '../src/cards/narrative-cache.mjs';
const cp = createRequire(import.meta.url)('node:child_process');

test('S12 B4 direct regression: final worklist write failure is an error and partial evidence is never a cache hit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'n6b-lastwrite-'));
  const original = { spawn: cp.spawn, log: console.log, error: console.error };
  let restore = () => {};
  try {
    const dir = join(root, '.planning/project-memory-context/enrichment');
    await mkdir(dir, { recursive: true });
    await mkdir(join(root, 'src'));
    const symbol = { symbolKey: 'js|src/a.js|function|exported|a|1', name: 'a', kind: 'function', language: 'js', filePath: 'src/a.js', codeHash: 'fixture', status: 'pending', range: { startLine: 1, endLine: 6 } };
    const source = "export function a(v) {\n if (!v) {\n throw Error('required');\n }\n return String(v);\n}\n// padding\n// padding\n// padding\n";
    await writeFile(join(root, 'src/a.js'), source);
    const wlFile = join(dir, 'worklist.json');
    const ixFile = join(dir, 'symbol-index.json');
    await writeFile(wlFile, JSON.stringify([symbol]));
    await writeFile(ixFile, '{}');
    const context = { symbolKeys: [symbol.symbolKey], signature: 'a(v)', role: null, callees: [], callers: [] };
    const config = { preferredModes: ['local-model'], localModel: { baseUrl: 'http://127.0.0.1:0', model: 'fake' }, subagentTokenThreshold: 5000, fileCoverageThreshold: .8 };
    let failures = 0, providerCalls = 0;
    const logs = [], errors = [];
    cp.spawn = () => ({ unref() {} });
    syncBuiltinESMExports();
    console.log = (...xs) => logs.push(xs.join(' '));
    console.error = (...xs) => errors.push(xs.join(' '));
    restore = setQueueStateFileOps({ rename: async (from, to) => {
      if (to === wlFile && failures === 0) {
        failures++;
        throw Object.assign(new Error('owned last worklist EIO'), { code: 'EIO' });
      }
      return rename(from, to);
    } });
    await main({ projectRoot: root, config, providers: [], concurrency: 1,
      narrativeResolver: async () => context, countPromptTokensImpl: async () => 100,
      runEnrichmentWithFallbackImpl: async () => {
        providerCalls++;
        return { status: 'succeeded', content: JSON.stringify({ summary: 'Normalizes a required value.', behavior: [], sideEffects: [], errors: [], contracts: [], changeNotes: '', mentions: [] }), attempts: [], mode: 'local-model' };
      },
    });
    const output = JSON.parse(logs.at(-1));
    assert.equal(failures, 1);
    assert.equal(providerCalls, 1);
    assert.equal(output.errors, 1);
    assert.equal(output.enriched, 0);
    assert.ok(errors.some(s => s.includes('owned last worklist EIO')));
    assert.ok(!errors.some(s => /\[queue\] DONE/.test(s)));
    const worklist = JSON.parse(await readFile(wlFile, 'utf8'));
    const index = JSON.parse(await readFile(ixFile, 'utf8'));
    assert.equal(worklist[0].status, 'error');
    const cached = await evaluateNarrativeCache({ symbol, projectRoot: root, narrativeContext: context, enrichmentDir: dir, worklistEntry: worklist[0], indexEntry: index[symbol.symbolKey] });
    assert.equal(cached.hit, false);
    assert.ok(errors.includes('[queue] Starting sequential enrichment: 1 pending (0 stale), 0 already enriched'));
  } finally {
    restore(); cp.spawn = original.spawn; syncBuiltinESMExports();
    console.log = original.log; console.error = original.error;
    await rm(root, { recursive: true, force: true });
  }
});
