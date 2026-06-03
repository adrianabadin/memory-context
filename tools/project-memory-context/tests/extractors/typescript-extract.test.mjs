import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSymbolsForFile } from '../../src/extractors/tree-sitter/extract.mjs';

// ── Critical cases: things the old regex extractor couldn't handle ─────────

test('handles decorator on class', async () => {
  const content = `@Injectable()\nexport class MyService {}`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.ts', content });
  assert.ok(symbols.some(s => s.name === 'MyService' && s.kind === 'class'),
    'decorated class should be extracted');
});

test('handles generic class', async () => {
  const content = `export class Repository<T extends Entity> {}`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.ts', content });
  assert.ok(symbols.some(s => s.name === 'Repository'),
    'generic class should be extracted');
});

test('handles arrow function in const at top level', async () => {
  const content = `export const handler = async (req: Request): Promise<void> => { }`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.ts', content });
  assert.ok(symbols.some(s => s.name === 'handler'),
    'exported const arrow function should be extracted');
});

// ── Basic symbols ──────────────────────────────────────────────────────────

test('extracts class', async () => {
  const content = `export class MyService {}`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.ts', content });
  const sym = symbols.find(s => s.name === 'MyService');
  assert.ok(sym, 'class should be extracted');
  assert.equal(sym.kind, 'class');
  assert.equal(sym.exportScope, 'exported');
  assert.equal(sym.language, 'ts');
});

test('extracts interface', async () => {
  const content = `interface Greetable { greet(): string; }`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.ts', content });
  const sym = symbols.find(s => s.name === 'Greetable');
  assert.ok(sym, 'interface should be extracted');
  assert.equal(sym.kind, 'interface');
  assert.equal(sym.exportScope, 'local');
});

test('extracts exported interface', async () => {
  const content = `export interface User { id: string; }`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.ts', content });
  const sym = symbols.find(s => s.name === 'User');
  assert.ok(sym, 'exported interface should be extracted');
  assert.equal(sym.kind, 'interface');
  assert.equal(sym.exportScope, 'exported');
});

test('extracts function declaration', async () => {
  const content = `export function greetUser(name: string): void {}`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.ts', content });
  const sym = symbols.find(s => s.name === 'greetUser');
  assert.ok(sym, 'function should be extracted');
  assert.equal(sym.kind, 'function');
  assert.equal(sym.exportScope, 'exported');
  assert.equal(sym.arity, 1);
});

test('extracts type alias', async () => {
  const content = `type Alias = string | number;`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.ts', content });
  const sym = symbols.find(s => s.name === 'Alias');
  assert.ok(sym, 'type alias should be extracted');
  assert.equal(sym.kind, 'type');
});

test('extracts enum as class kind', async () => {
  const content = `export enum Status { Active, Inactive }`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.ts', content });
  const sym = symbols.find(s => s.name === 'Status');
  assert.ok(sym, 'enum should be extracted');
  assert.equal(sym.kind, 'class');
});

test('non-exported function has local scope', async () => {
  const content = `function helper() {}`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.ts', content });
  const sym = symbols.find(s => s.name === 'helper');
  assert.ok(sym, 'non-exported function should be extracted');
  assert.equal(sym.exportScope, 'local');
});

test('non-exported const arrow has local scope', async () => {
  const content = `const localArrow = (x: number) => x * 2;`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.ts', content });
  const sym = symbols.find(s => s.name === 'localArrow');
  assert.ok(sym, 'local arrow should be extracted');
  assert.equal(sym.exportScope, 'local');
});

test('all symbols have symbolKey and codeHash', async () => {
  const content = `
export class MyService {}
export function foo(): void {}
interface Bar {}
`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.ts', content });
  assert.ok(symbols.length >= 3, 'should find at least 3 symbols');
  for (const s of symbols) {
    assert.ok(s.symbolKey?.length > 0, `${s.name} should have a symbolKey`);
    assert.ok(s.codeHash?.length > 0, `${s.name} should have a codeHash`);
  }
});
