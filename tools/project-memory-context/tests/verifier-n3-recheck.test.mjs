/**
 * Independent B2 recheck probes for F3 N3, retained verbatim (readable format)
 * from the parent's exact probe content. Public probe semantics unchanged:
 * 5 buildSymbolKey compatibility cases + 1 queue-metadata byte-preservation
 * case. Owned temp fixtures are removed in `finally`; no workspace mutation,
 * no network, no real model.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { buildSymbolKey } from '../src/symbol-keys.mjs';
import { normalizeSymbolKeys, buildNarrativePromptV2 } from '../src/cards/prompt-v2.mjs';
import { appendSubagentQueue } from '../src/subagent-queue.mjs';
import { NARRATIVE_SCHEMA } from '../src/cards/narrative-schema.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');

const cases = [
  ['generic defaults', { language: 'js', filePath: 'src/a.js', kind: 'function', name: 'a' }],
  ['qualified member', { language: 'ts', filePath: 'src/a.ts', kind: 'method', container: 'A', name: 'a', arity: 1 }],
  ['C# defaults', { language: 'csharp', filePath: 'src/A.cs', kind: 'class', name: 'A' }],
  ['C# empty global namespace', { language: 'csharp', filePath: 'src/A.cs', namespace: '', kind: 'class', name: 'A' }],
  ['C# empty top-level container', { language: 'csharp', filePath: 'src/A.cs', namespace: 'Example', containerName: '', kind: 'class', name: 'A' }],
];

for (const [label, input] of cases) {
  test(`S9 B2 actual buildSymbolKey compatibility: ${label}`, () => {
    const key = buildSymbolKey(input);
    assert.deepEqual([...normalizeSymbolKeys([key])], [key]);
    const symbol = { name: 'a', kind: 'function', language: 'js', filePath: 'src/a.js', range: { startLine: 1, endLine: 1 } };
    const { prompt } = buildNarrativePromptV2({
      symbol,
      codeSection: 'function a(){}',
      narrativeContext: { symbolKeys: [key], callees: [{ key, summary: 'CANONICAL_CONTROL' }] },
    });
    assert.ok(prompt.includes(`- ${key}: CANONICAL_CONTROL`));
  });
}

test('S9 B3 partial/wrong/null metadata preserves queue bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'n3-recheck-'));
  try {
    const dir = join(root, 'e');
    await mkdir(dir);
    const file = join(dir, 'subagent-queue.json');
    await writeFile(file, '{"entries":[]}\n');
    const before = digest(await readFile(file));
    const cases = [
      { knownGraphKeys: [] },
      { promptVersion: 'v2', schema: NARRATIVE_SCHEMA },
      { promptVersion: 'v2', schema: NARRATIVE_SCHEMA, knownGraphKeys: null },
      { promptVersion: 'v2', schema: NARRATIVE_SCHEMA, knownGraphKeys: 'raw' },
      { promptVersion: 'v2', schema: NARRATIVE_SCHEMA, knownGraphKeys: ['node_123'] },
    ];
    for (const metadata of cases) {
      await assert.rejects(appendSubagentQueue(dir, { symbolKey: 'js|src/a.js|function|local|a|0', prompt: 'p', ...metadata }), TypeError);
      assert.equal(digest(await readFile(file)), before);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
