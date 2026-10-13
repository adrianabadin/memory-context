import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSymbolsForFile } from '../src/extractors/tree-sitter/extract.mjs';

const go = content => extractSymbolsForFile({ filePath: 'src/member.go', content: `package p\n${content}` });
const rust = content => extractSymbolsForFile({ filePath: 'src/member.rs', content });
const methods = symbols => symbols.filter(s => s.kind === 'method');
function member(s, language, container, name, arity) {
  assert.ok(s);
  assert.equal(s.kind, 'method');
  assert.equal(s.container, container);
  assert.equal(s.name, name);
  assert.equal(s.exportScope, 'member');
  assert.equal(s.arity, arity);
  const ext = language === 'go' ? 'go' : 'rs';
  assert.equal(s.symbolKey, `${language}|src/member.${ext}|method|member|${container}.${name}|${arity}`);
  assert.ok(s.range.startLine > 0);
  assert.ok(s.range.endLine >= s.range.startLine);
  assert.match(s.codeHash, /^[a-f0-9]+$/);
}

for (const receiver of ['x Animal', 'x *Animal', 'Animal', '*Animal']) {
  test(`Go receiver ${receiver} resolves without a same-file type`, async () => {
    const symbols = await go(`func (${receiver}) Speak(x int) {}`);
    assert.equal(symbols.length, 1);
    member(symbols[0], 'go', 'Animal', 'Speak', 1);
  });
}

test('Go grouped names, variadics, unnamed slots and comments count declared arguments, not receiver', async () => {
  const symbols = await go(`func (x *Animal) Group(a, b int, /* note */ self int, cls int, rest ...string) {}
func (Animal) Unnamed(int, string, ...bool) {}
func (Animal) Zero() {}`);
  assert.equal(symbols.length, 3);
  member(symbols[0], 'go', 'Animal', 'Group', 5);
  member(symbols[1], 'go', 'Animal', 'Unnamed', 3);
  member(symbols[2], 'go', 'Animal', 'Zero', 0);
});

test('Go equal names on distinct receivers and duplicate declarations retain span evidence', async () => {
  const symbols = await go('func (A) Same(x int) {}; func (B) Same(x int) {}; func (A) Same(y int) {}');
  assert.equal(symbols.length, 3);
  member(symbols[0], 'go', 'A', 'Same', 1);
  member(symbols[1], 'go', 'B', 'Same', 1);
  member(symbols[2], 'go', 'A', 'Same', 1);
  assert.equal(symbols[0].symbolKey, symbols[2].symbolKey);
});

test('Go complex, generic and malformed receivers fail closed; interface specs are not concrete methods', async () => {
  for (const receiver of ['x **Animal', 'x pkg.Animal', 'x Animal[T]', 'x *Animal[T]', 'x []Animal', 'x, y Animal']) {
    assert.deepEqual(await go(`func (${receiver}) Unsupported() {}`), [], receiver);
  }
  assert.equal(methods(await go('type Speaker interface { Speak(x int) }')).length, 0);
});

test('Go ordinary globals keep historical key bytes including grouped-parameter undercount', async () => {
  const symbols = await extractSymbolsForFile({ filePath: 'src/legacy.go', content: 'package p\nfunc Global(a, b int) {}\nfunc private(self int) {}' });
  assert.deepEqual(symbols.map(s => s.symbolKey), [
    'go|src/legacy.go|function|exported|Global|1',
    'go|src/legacy.go|function|local|private|1',
  ]);
  assert.ok(symbols.every(s => !Object.hasOwn(s, 'container')));
});

for (const receiver of ['self', 'mut self', '&self', '&mut self', "&'a self", 'self: Box<Self>', 'mut self: Box<Self>']) {
  test(`Rust ${receiver} excludes the actual self slot`, async () => {
    const symbols = await rust(`impl Animal { fn speak(${receiver}, x: i32) {} }`);
    const found = methods(symbols);
    assert.equal(found.length, 1);
    member(found[0], 'rust', 'Animal', 'speak', 1);
  });
}

test('Rust inherent and trait impls use the self type, never the trait; no same-file definition required', async () => {
  const found = methods(await rust('impl Animal { pub fn new(x: i32) -> Self { todo!() } }\nimpl Speaker for Animal { fn speak(&self) {} }'));
  assert.equal(found.length, 2);
  member(found[0], 'rust', 'Animal', 'new', 1);
  member(found[1], 'rust', 'Animal', 'speak', 0);
});

test('Rust associated functions, argument patterns and comments count one declared slot each', async () => {
  const found = methods(await rust('impl Animal { fn zero() {} fn slots((x,y): (i32,i32), /* note */ self_: i32, cls: i32) {} }'));
  assert.equal(found.length, 2);
  member(found[0], 'rust', 'Animal', 'zero', 0);
  member(found[1], 'rust', 'Animal', 'slots', 3);
});

test('Rust equal-arity trait implementations retain ambiguous canonical keys', async () => {
  const found = methods(await rust('impl A for Animal { fn same(&self, x: i32) {} } impl B for Animal { fn same(&self, x: bool) {} }'));
  assert.equal(found.length, 2);
  for (const s of found) member(s, 'rust', 'Animal', 'same', 1);
  assert.equal(found[0].symbolKey, found[1].symbolKey);
});

test('Rust complex, scoped, generic, blanket and nested impl targets fail closed', async () => {
  for (const source of [
    'impl<T> Box<T> { fn unsupported(&self) {} }',
    'impl remote::Animal { fn unsupported(&self) {} }',
    'impl (A, B) { fn unsupported(&self) {} }',
    'impl &Animal { fn unsupported(&self) {} }',
    'impl<T> Trait for T { fn unsupported(&self) {} }',
    'impl<const T: usize> Trait for T { fn unsupported(&self) {} }',
    'mod inner { impl Animal { fn unsupported(&self) {} } }',
    'fn outer() { impl Animal { fn unsupported(&self) {} } }',
    'trait Speaker { fn unsupported(&self) {} }',
  ]) assert.equal(methods(await rust(source)).length, 0, source);
});

test('Rust ordinary globals and existing impl class records keep historical key bytes', async () => {
  const symbols = await extractSymbolsForFile({ filePath: 'src/legacy.rs', content: 'pub fn global(x: i32) {}\nfn private(self_: i32) {}\nimpl Animal {}' });
  assert.deepEqual(symbols.map(s => s.symbolKey), [
    'rust|src/legacy.rs|function|exported|global|1',
    'rust|src/legacy.rs|function|local|private|1',
    'rust|src/legacy.rs|class|local|Animal|0',
  ]);
  assert.ok(symbols.every(s => !Object.hasOwn(s, 'container')));
});

test('C# seven-part and PHP legacy member keys are not requalified by B2', async () => {
  const cs = await extractSymbolsForFile({ filePath: 'src/legacy.cs', content: 'public class Animal { public void Speak(int x) {} }' });
  const php = await extractSymbolsForFile({ filePath: 'src/legacy.php', content: '<?php class Animal { public function speak($x) {} }' });
  assert.deepEqual(cs.map(s => s.symbolKey), [
    'csharp|src/legacy.cs|global|none|class|Animal|()',
    'csharp|src/legacy.cs|global|none|method|Speak|()',
  ]);
  assert.deepEqual(php.map(s => s.symbolKey), [
    'php|src/legacy.php|class|exported|Animal|0',
    'php|src/legacy.php|method|exported|speak|1',
  ]);
  assert.ok([...cs, ...php].every(s => !Object.hasOwn(s, 'container')));
  assert.equal(cs[1].arity, 1);
  assert.equal(php[1].arity, 1);
});
