import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { extractSymbolsForFile } from '../../src/extractors/tree-sitter/extract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '../fixtures');

// ── Task 3: Java ──────────────────────────────────────────────────────────────

test('extracts Java classes and interfaces', async () => {
  const content = await readFile(join(fixturesDir, 'sample.java'), 'utf-8');
  const symbols = await extractSymbolsForFile({ filePath: 'sample.java', content });

  const names = symbols.map(s => s.name);

  // class names
  assert.ok(names.includes('Animal'), 'should find class Animal');
  assert.ok(names.includes('Base'), 'should find class Base');

  // interface name
  assert.ok(names.includes('Greetable'), 'should find interface Greetable');

  // enum is captured as class
  assert.ok(names.includes('Status'), 'should find enum Status as class');

  // kinds
  const animalSym = symbols.find(s => s.name === 'Animal');
  assert.equal(animalSym?.kind, 'class', 'Animal should be kind=class');

  const greetableSym = symbols.find(s => s.name === 'Greetable');
  assert.equal(greetableSym?.kind, 'interface', 'Greetable should be kind=interface');

  const statusSym = symbols.find(s => s.name === 'Status');
  assert.equal(statusSym?.kind, 'class', 'Status enum should be kind=class');
});

// ── Task 3: Go ────────────────────────────────────────────────────────────────

test('extracts Go functions with correct export scopes', async () => {
  const content = await readFile(join(fixturesDir, 'sample.go'), 'utf-8');
  const symbols = await extractSymbolsForFile({ filePath: 'sample.go', content });

  const names = symbols.map(s => s.name);

  // function declarations
  assert.ok(names.includes('NewAnimal'), 'should find exported function NewAnimal');
  assert.ok(names.includes('privateHelper'), 'should find unexported function privateHelper');

  // export scopes via Go naming convention (uppercase → exported, lowercase → local)
  const newAnimal = symbols.find(s => s.name === 'NewAnimal');
  assert.equal(newAnimal?.exportScope, 'exported', 'NewAnimal (uppercase) should be exported');

  const helper = symbols.find(s => s.name === 'privateHelper');
  assert.equal(helper?.exportScope, 'local', 'privateHelper (lowercase) should be local');
});

// ── Task 3: Rust ──────────────────────────────────────────────────────────────

test('extracts Rust structs, enums, traits, and functions with correct export scopes', async () => {
  const content = await readFile(join(fixturesDir, 'sample.rs'), 'utf-8');
  const symbols = await extractSymbolsForFile({ filePath: 'sample.rs', content });

  const names = symbols.map(s => s.name);

  // struct and enum
  assert.ok(names.includes('Animal'), 'should find struct Animal');
  assert.ok(names.includes('Status'), 'should find enum Status');

  // trait
  assert.ok(names.includes('Speaker'), 'should find trait Speaker');

  // functions
  assert.ok(names.includes('standalone'), 'should find pub fn standalone');
  assert.ok(names.includes('private_helper'), 'should find fn private_helper');

  // export scopes
  const standalone = symbols.find(s => s.name === 'standalone');
  assert.equal(standalone?.exportScope, 'exported', 'pub fn standalone should be exported');

  const privateHelper = symbols.find(s => s.name === 'private_helper');
  assert.equal(privateHelper?.exportScope, 'local', 'fn private_helper (no pub) should be local');

  // kinds
  // struct → class
  const animalSyms = symbols.filter(s => s.name === 'Animal' && s.kind === 'class');
  assert.ok(animalSyms.length > 0, 'Animal struct should be kind=class');

  // trait → interface
  const speakerSym = symbols.find(s => s.name === 'Speaker');
  assert.equal(speakerSym?.kind, 'interface', 'Speaker trait should be kind=interface');
});

// ── Task 4: Ruby ──────────────────────────────────────────────────────────────

test('extracts Ruby classes and modules', async () => {
  const content = await readFile(join(fixturesDir, 'sample.rb'), 'utf-8');
  const symbols = await extractSymbolsForFile({ filePath: 'sample.rb', content });

  const names = symbols.map(s => s.name);

  // classes
  assert.ok(names.includes('Animal'), 'should find class Animal');
  assert.ok(names.includes('Dog'), 'should find class Dog');

  // module (extracted as class kind)
  assert.ok(names.includes('Greetable'), 'should find module Greetable');

  // kinds
  const animalSym = symbols.find(s => s.name === 'Animal');
  assert.equal(animalSym?.kind, 'class', 'Animal should be kind=class');

  const greetableSym = symbols.find(s => s.name === 'Greetable');
  assert.equal(greetableSym?.kind, 'class', 'Greetable module should be kind=class');
});

// ── Task 4: PHP ───────────────────────────────────────────────────────────────

test('extracts PHP classes, interfaces, traits, and functions', async () => {
  const content = await readFile(join(fixturesDir, 'sample.php'), 'utf-8');
  const symbols = await extractSymbolsForFile({ filePath: 'sample.php', content });

  const names = symbols.map(s => s.name);

  // classes
  assert.ok(names.includes('Animal'), 'should find class Animal');
  assert.ok(names.includes('Dog'), 'should find class Dog');

  // interface
  assert.ok(names.includes('Greetable'), 'should find interface Greetable');

  // trait
  assert.ok(names.includes('Loggable'), 'should find trait Loggable');

  // top-level function
  assert.ok(names.includes('standaloneFunction'), 'should find standalone function');

  // kinds
  const greetableSym = symbols.find(s => s.name === 'Greetable');
  assert.equal(greetableSym?.kind, 'interface', 'Greetable should be kind=interface');

  const animalSym = symbols.find(s => s.name === 'Animal');
  assert.equal(animalSym?.kind, 'class', 'Animal should be kind=class');

  const standaloneSym = symbols.find(s => s.name === 'standaloneFunction');
  assert.equal(standaloneSym?.kind, 'function', 'standaloneFunction should be kind=function');
});

// ── Task 4: C++ ───────────────────────────────────────────────────────────────

test('extracts C++ classes, structs, namespaces, and functions', async () => {
  const content = await readFile(join(fixturesDir, 'sample.cpp'), 'utf-8');
  const symbols = await extractSymbolsForFile({ filePath: 'sample.cpp', content });

  const names = symbols.map(s => s.name);

  // class inside namespace
  assert.ok(names.includes('Animal'), 'should find class Animal (inside namespace)');

  // struct inside namespace
  assert.ok(names.includes('Point'), 'should find struct Point (inside namespace)');

  // namespace itself
  assert.ok(names.includes('Animals'), 'should find namespace Animals');

  // top-level functions
  assert.ok(names.includes('standaloneFunction'), 'should find standaloneFunction');
  assert.ok(names.includes('helperVoid'), 'should find helperVoid');

  // kinds
  const animalSym = symbols.find(s => s.name === 'Animal');
  assert.equal(animalSym?.kind, 'class', 'Animal should be kind=class');

  const standaloneSym = symbols.find(s => s.name === 'standaloneFunction');
  assert.equal(standaloneSym?.kind, 'function', 'standaloneFunction should be kind=function');
});
