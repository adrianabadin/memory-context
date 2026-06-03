import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { extractTopLevelSymbols } from '../src/symbol-extractor.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => join(__dir, 'fixtures', name);

async function load(name) {
  return readFile(fixture(name), 'utf-8');
}

// ── TypeScript (Babel AST) ──────────────────────────────────────────

test('TypeScript: extracts interface, class, function, type, arrow fn, enum', async () => {
  const content = await load('sample.ts');
  const symbols = extractTopLevelSymbols({ filePath: fixture('sample.ts'), content });

  const names = symbols.map(s => s.name);
  assert.ok(names.includes('Greetable'), 'interface Greetable');
  assert.ok(names.includes('MyService'), 'class MyService (decorated)');
  assert.ok(names.includes('greetUser'), 'function greetUser');
  assert.ok(names.includes('Alias'), 'type Alias');
  assert.ok(names.includes('handler'), 'const arrow handler');
  assert.ok(names.includes('Status'), 'enum Status');

  const cls = symbols.find(s => s.name === 'MyService');
  assert.equal(cls?.kind, 'class');
  assert.equal(cls?.exportScope, 'exported');

  const iface = symbols.find(s => s.name === 'Greetable');
  assert.equal(iface?.kind, 'interface');

  const fn = symbols.find(s => s.name === 'greetUser');
  assert.equal(fn?.arity, 1);
  assert.equal(fn?.exportScope, 'exported');

  const local = symbols.find(s => s.name === 'localArrow');
  assert.equal(local?.exportScope, 'local');
});

// ── Python ─────────────────────────────────────────────────────────

test('Python: extracts classes, public and private functions', async () => {
  const content = await load('sample.py');
  const symbols = extractTopLevelSymbols({ filePath: fixture('sample.py'), content });

  const names = symbols.map(s => s.name);
  assert.ok(names.includes('Animal'), 'class Animal');
  assert.ok(names.includes('Dog'), 'class Dog');
  assert.ok(names.includes('standalone_function'), 'standalone_function');
  assert.ok(names.includes('async_handler'), 'async_handler');

  const priv = symbols.find(s => s.name === '_private_function');
  assert.equal(priv?.exportScope, 'local');

  const pub = symbols.find(s => s.name === 'standalone_function');
  assert.equal(pub?.exportScope, 'exported');
  assert.equal(pub?.arity, 2);

  assert.ok(symbols.every(s => s.language === 'python'));
  assert.ok(symbols.every(s => s.symbolKey?.length > 0));
});

// ── Java ────────────────────────────────────────────────────────────

test('Java: extracts class, interface, enum', async () => {
  const content = await load('sample.java');
  const symbols = extractTopLevelSymbols({ filePath: fixture('sample.java'), content });

  const names = symbols.map(s => s.name);
  assert.ok(names.includes('Greetable'), 'interface Greetable');
  assert.ok(names.includes('Animal'), 'class Animal');
  assert.ok(names.includes('Status'), 'enum Status');

  const iface = symbols.find(s => s.name === 'Greetable');
  assert.equal(iface?.kind, 'interface');
});

// ── Go ──────────────────────────────────────────────────────────────

test('Go: extracts struct, interface, functions with export scope', async () => {
  const content = await load('sample.go');
  const symbols = extractTopLevelSymbols({ filePath: fixture('sample.go'), content });

  const names = symbols.map(s => s.name);
  assert.ok(names.includes('Animal'), 'struct Animal');
  assert.ok(names.includes('Speaker'), 'interface Speaker');
  assert.ok(names.includes('NewAnimal'), 'func NewAnimal');
  assert.ok(names.includes('privateHelper'), 'func privateHelper');

  const pub = symbols.find(s => s.name === 'NewAnimal');
  assert.equal(pub?.exportScope, 'exported');

  const priv = symbols.find(s => s.name === 'privateHelper');
  assert.equal(priv?.exportScope, 'local');
});

// ── Rust ────────────────────────────────────────────────────────────

test('Rust: extracts struct, enum, trait, fn, impl', async () => {
  const content = await load('sample.rs');
  const symbols = extractTopLevelSymbols({ filePath: fixture('sample.rs'), content });

  const names = symbols.map(s => s.name);
  assert.ok(names.includes('Animal'), 'struct Animal');
  assert.ok(names.includes('Status'), 'enum Status');
  assert.ok(names.includes('Speaker'), 'trait Speaker');
  assert.ok(names.includes('standalone'), 'fn standalone');

  const pub = symbols.find(s => s.name === 'standalone');
  assert.equal(pub?.exportScope, 'exported');

  const priv = symbols.find(s => s.name === 'private_helper');
  assert.equal(priv?.exportScope, 'local');
});

// ── Ruby ────────────────────────────────────────────────────────────

test('Ruby: extracts class, module, method', async () => {
  const content = await load('sample.rb');
  const symbols = extractTopLevelSymbols({ filePath: fixture('sample.rb'), content });

  const names = symbols.map(s => s.name);
  assert.ok(names.includes('Greetable'), 'module Greetable');
  assert.ok(names.includes('Animal'), 'class Animal');
  assert.ok(names.includes('Dog'), 'class Dog');
});

// ── PHP ─────────────────────────────────────────────────────────────

test('PHP: extracts class, interface, trait, function', async () => {
  const content = await load('sample.php');
  const symbols = extractTopLevelSymbols({ filePath: fixture('sample.php'), content });

  const names = symbols.map(s => s.name);
  assert.ok(names.includes('Greetable'), 'interface Greetable');
  assert.ok(names.includes('Animal'), 'class Animal');
  assert.ok(names.includes('Dog'), 'class Dog');
  assert.ok(names.includes('Loggable'), 'trait Loggable');
  assert.ok(names.includes('standaloneFunction'), 'standaloneFunction');
});

// ── Kotlin ──────────────────────────────────────────────────────────

test('Kotlin: extracts class, object, interface, fun', async () => {
  const content = await load('sample.kt');
  const symbols = extractTopLevelSymbols({ filePath: fixture('sample.kt'), content });

  const names = symbols.map(s => s.name);
  assert.ok(names.includes('Greetable'), 'interface Greetable');
  assert.ok(names.includes('Animal'), 'data class Animal');
  assert.ok(names.includes('Singleton'), 'object Singleton');
  assert.ok(names.includes('standaloneFunction'), 'fun standaloneFunction');
});

// ── Swift ───────────────────────────────────────────────────────────

test('Swift: extracts class, struct, protocol, func, extension', async () => {
  const content = await load('sample.swift');
  const symbols = extractTopLevelSymbols({ filePath: fixture('sample.swift'), content });

  const names = symbols.map(s => s.name);
  assert.ok(names.includes('Greetable'), 'protocol Greetable');
  assert.ok(names.includes('Animal'), 'class Animal');
  assert.ok(names.includes('Point'), 'struct Point');
  assert.ok(names.includes('standaloneFunction'), 'func standaloneFunction');
});

// ── C++ ─────────────────────────────────────────────────────────────

test('C++: extracts namespace, class, struct, function', async () => {
  const content = await load('sample.cpp');
  const symbols = extractTopLevelSymbols({ filePath: fixture('sample.cpp'), content });

  const names = symbols.map(s => s.name);
  assert.ok(names.includes('Animals'), 'namespace Animals');
  assert.ok(names.includes('Animal') || names.some(n => n === 'Animal'), 'class Animal');
  assert.ok(names.includes('standaloneFunction'), 'standaloneFunction');
});

// ── C# ──────────────────────────────────────────────────────────────

test('C#: extracts interface, class, enum, record', async () => {
  const content = await load('sample.cs');
  const symbols = extractTopLevelSymbols({ filePath: fixture('sample.cs'), content });

  const names = symbols.map(s => s.name);
  assert.ok(names.includes('IGreetable'), 'interface IGreetable');
  assert.ok(names.includes('Animal'), 'class Animal');
  assert.ok(names.includes('Status'), 'enum Status');
  assert.ok(names.includes('PersonRecord') || names.includes('PersonRecord'), 'record PersonRecord');

  const record = symbols.find(s => s.name === 'PersonRecord');
  assert.equal(record?.kind, 'record');

  const method = symbols.find(s => s.name === 'Greet');
  assert.equal(method?.kind, 'method');
});

// ── Unknown extension returns empty ────────────────────────────────

test('Unknown extension returns empty array without error', () => {
  const symbols = extractTopLevelSymbols({ filePath: 'file.unknown', content: 'some content' });
  assert.deepEqual(symbols, []);
});

// ── symbolKey integrity ─────────────────────────────────────────────

test('All symbols have unique non-empty symbolKeys', async () => {
  const fixtures = ['sample.ts', 'sample.py', 'sample.java', 'sample.go', 'sample.rs'];
  for (const fname of fixtures) {
    const content = await load(fname);
    const symbols = extractTopLevelSymbols({ filePath: fixture(fname), content });
    const keys = symbols.map(s => s.symbolKey);
    const unique = new Set(keys);
    assert.equal(unique.size, keys.length, `Duplicate symbolKeys in ${fname}`);
    assert.ok(keys.every(k => k?.length > 0), `Empty symbolKey in ${fname}`);
  }
});
