import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSymbolsForFile } from '../../src/extractors/tree-sitter/extract.mjs';

test('extracts class', async () => {
  const content = `class Animal {}`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.js', content });
  const sym = symbols.find(s => s.name === 'Animal');
  assert.ok(sym, 'class should be extracted');
  assert.equal(sym.kind, 'class');
  assert.equal(sym.language, 'js');
});

test('extracts exported class', async () => {
  const content = `export class Bar {}`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.js', content });
  const sym = symbols.find(s => s.name === 'Bar');
  assert.ok(sym, 'exported class should be extracted');
  assert.equal(sym.kind, 'class');
  assert.equal(sym.exportScope, 'exported');
});

test('extracts function declaration', async () => {
  const content = `function greetUser() {}`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.js', content });
  const sym = symbols.find(s => s.name === 'greetUser');
  assert.ok(sym, 'function should be extracted');
  assert.equal(sym.kind, 'function');
  assert.equal(sym.exportScope, 'local');
});

test('extracts exported function', async () => {
  const content = `export function foo(a, b) {}`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.js', content });
  const sym = symbols.find(s => s.name === 'foo');
  assert.ok(sym, 'exported function should be extracted');
  assert.equal(sym.kind, 'function');
  assert.equal(sym.exportScope, 'exported');
  assert.equal(sym.arity, 2);
});

test('extracts const arrow function', async () => {
  const content = `export const handler = async (req) => {};`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.js', content });
  const sym = symbols.find(s => s.name === 'handler');
  assert.ok(sym, 'exported const arrow should be extracted');
  assert.equal(sym.kind, 'function');
  assert.equal(sym.exportScope, 'exported');
});

test('extracts non-exported const arrow as local', async () => {
  const content = `const helper = (x) => x * 2;`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.js', content });
  const sym = symbols.find(s => s.name === 'helper');
  assert.ok(sym, 'local const arrow should be extracted');
  assert.equal(sym.exportScope, 'local');
});

test('does not extract nested functions', async () => {
  const content = `
function outer() {
  function inner() {}
}
`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.js', content });
  const names = symbols.map(s => s.name);
  assert.ok(names.includes('outer'), 'outer should be extracted');
  assert.ok(!names.includes('inner'), 'inner should NOT be extracted');
});

test('all symbols have symbolKey and codeHash', async () => {
  const content = `
export class A {}
export function b() {}
const c = () => {};
`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.js', content });
  assert.ok(symbols.length >= 3);
  for (const s of symbols) {
    assert.ok(s.symbolKey?.length > 0, `${s.name} should have a symbolKey`);
    assert.ok(s.codeHash?.length > 0, `${s.name} should have a codeHash`);
  }
});
