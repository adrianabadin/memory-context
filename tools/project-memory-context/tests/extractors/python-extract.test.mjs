import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { extractSymbolsForFile } from '../../src/extractors/tree-sitter/extract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('extracts Python classes and functions', async () => {
  const content = await readFile(join(__dirname, '../fixtures/sample.py'), 'utf-8');
  const symbols = await extractSymbolsForFile({ filePath: 'sample.py', content });

  const names = symbols.map(s => s.name);
  assert.ok(names.includes('Animal'), 'should find class Animal');
  assert.ok(names.includes('Dog'), 'should find class Dog');
  assert.ok(names.includes('standalone_function'), 'should find standalone function');
  assert.ok(names.includes('async_handler'), 'should find async function');

  const classSymbols = symbols.filter(s => s.kind === 'class');
  assert.equal(classSymbols.length, 2);

  const funcSymbols = symbols.filter(s => s.kind === 'function');
  assert.ok(funcSymbols.length >= 3);

  const privateFunc = symbols.find(s => s.name === '_private_function');
  assert.equal(privateFunc?.exportScope, 'local');

  const pubFunc = symbols.find(s => s.name === 'standalone_function');
  assert.equal(pubFunc?.exportScope, 'exported');
});
