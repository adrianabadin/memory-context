import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSymbolKey } from '../src/symbol-keys.mjs';
import { normalizeSymbolKeys } from '../src/cards/prompt-v2.mjs';

test('S9 B2 optional C# fields preserve bytes; required fields and raw IDs reject', () => {
  const key = buildSymbolKey({
    language: 'csharp',
    filePath: 'src/A.cs',
    namespace: '',
    containerName: '',
    kind: 'class',
    name: 'A',
  });
  assert.equal(key, 'csharp|src/A.cs|||class|A|()');
  assert.deepEqual([...normalizeSymbolKeys(new Set([key]))], [key]);

  for (const index of [1, 4, 5, 6]) {
    const parts = key.split('|');
    parts[index] = '';
    assert.throws(() => normalizeSymbolKeys([parts.join('|')]), TypeError);
  }

  const generic = buildSymbolKey({
    language: 'js',
    filePath: 'src/a.js',
    kind: 'function',
    name: 'a',
  });
  for (const index of [0, 1, 2, 3, 4, 5]) {
    const parts = generic.split('|');
    parts[index] = '';
    assert.throws(() => normalizeSymbolKeys([parts.join('|')]), TypeError);
  }

  for (const raw of ['123', 'node_123', ' ' + key, key + ' ']) {
    assert.throws(() => normalizeSymbolKeys([raw]), TypeError);
  }
});
