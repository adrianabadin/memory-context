import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLanguage, initParser } from '../../src/extractors/tree-sitter/runtime.mjs';

test('initParser returns a Parser instance', async () => {
  const parser = await initParser();
  assert.ok(parser, 'parser should be truthy');
});

test('loadLanguage returns a Language for python', async () => {
  const lang = await loadLanguage('python');
  assert.ok(lang, 'language should be truthy');
});

test('loadLanguage throws for unsupported language', async () => {
  await assert.rejects(
    () => loadLanguage('brainfuck'),
    /unsupported language/i
  );
});

test('loadLanguage is cached (same reference on second call)', async () => {
  const a = await loadLanguage('python');
  const b = await loadLanguage('python');
  assert.strictEqual(a, b);
});
