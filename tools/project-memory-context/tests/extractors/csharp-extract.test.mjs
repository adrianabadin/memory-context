import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSymbolsForFile } from '../../src/extractors/tree-sitter/extract.mjs';

test('extracts class', async () => {
  const content = `public class Animal {}`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.cs', content });
  const sym = symbols.find(s => s.name === 'Animal');
  assert.ok(sym, 'class should be extracted');
  assert.equal(sym.kind, 'class');
  assert.equal(sym.language, 'csharp');
  assert.equal(sym.exportScope, 'exported');
});

test('extracts interface', async () => {
  const content = `public interface IGreetable { string Greet(); }`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.cs', content });
  const sym = symbols.find(s => s.name === 'IGreetable');
  assert.ok(sym, 'interface should be extracted');
  assert.equal(sym.kind, 'interface');
});

test('extracts record with kind class — NOT record', async () => {
  // Note: record maps to kind='record' (backward compat with regex extractor)
  const content = `public record PersonRecord(string Name, int Age);`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.cs', content });
  const sym = symbols.find(s => s.name === 'PersonRecord');
  assert.ok(sym, 'record should be extracted');
  assert.equal(sym.kind, 'record', 'record kind should be preserved for backward compat');
});

test('extracts method with kind method — NOT function', async () => {
  const content = `public class UserService {
  public Task<User> GetUserAsync(Guid id) {
    throw new NotImplementedException();
  }
}`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.cs', content });
  const method = symbols.find(s => s.name === 'GetUserAsync');
  assert.ok(method, 'method should be extracted');
  assert.equal(method.kind, 'method', 'method kind should be preserved for backward compat');
});

test('extracts enum', async () => {
  const content = `public enum Status { Active, Inactive }`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.cs', content });
  const sym = symbols.find(s => s.name === 'Status');
  assert.ok(sym, 'enum should be extracted');
  assert.equal(sym.kind, 'class', 'enum maps to class kind');
});

test('handles file-scoped namespace', async () => {
  const content = `namespace Example;
public class Foo {}
public interface IBar {}`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.cs', content });
  const names = symbols.map(s => s.name);
  assert.ok(names.includes('Foo'), 'class in file-scoped namespace should be extracted');
  assert.ok(names.includes('IBar'), 'interface in file-scoped namespace should be extracted');
});

test('handles block namespace', async () => {
  const content = `namespace Example {
  public class Foo {}
}`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.cs', content });
  const names = symbols.map(s => s.name);
  assert.ok(names.includes('Foo'), 'class in block namespace should be extracted');
});

test('does not extract methods from interface body', async () => {
  const content = `public interface IFoo { void Bar(); }`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.cs', content });
  const names = symbols.map(s => s.name);
  assert.ok(names.includes('IFoo'), 'interface should be extracted');
  assert.ok(!names.includes('Bar'), 'interface method should NOT be extracted as top-level');
});

test('all symbols have symbolKey and codeHash', async () => {
  const content = `
namespace App;
public class Animal {}
public interface IGreetable {}
public record User(string Name);
`;
  const symbols = await extractSymbolsForFile({ filePath: 'a.cs', content });
  assert.ok(symbols.length >= 3);
  for (const s of symbols) {
    assert.ok(s.symbolKey?.length > 0, `${s.name} should have a symbolKey`);
    assert.ok(s.codeHash?.length > 0, `${s.name} should have a codeHash`);
  }
});
