import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Query } from 'web-tree-sitter';

import { extractSymbolsForFile } from '../src/extractors/tree-sitter/extract.mjs';
import { initParser, loadLanguage } from '../src/extractors/tree-sitter/runtime.mjs';

// Unit 1.2-B1: Python/Java enclosed-type (member) extraction fixtures are
// hermetic in-memory sources — no fixture files are written to disk.

const __dirname = dirname(fileURLToPath(import.meta.url));
const queryDir = join(__dirname, '../src/extractors/tree-sitter/queries');

// ── Real backend provenance: shipped WASM grammars + query files compile ─────

test('python and java query files compile against their real WASM grammars', async () => {
  await initParser();
  for (const language of ['python', 'java']) {
    const queryText = await readFile(join(queryDir, `${language}.scm`), 'utf8');
    const lang = await loadLanguage(language);
    assert.doesNotThrow(
      () => new Query(lang, queryText),
      `${language}.scm must compile against the shipped ${language} grammar`,
    );
  }
});

// ── Python: members of named top-level classes ───────────────────────────────

test('python: same method name in two top-level classes yields distinct container keys', async () => {
  const content = [
    'class Alpha:',
    '    def run(self):',
    '        pass',
    'class Beta:',
    '    def run(self):',
    '        pass',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/twin.py', content });

  const methods = symbols.filter(s => s.kind === 'method');
  assert.equal(methods.length, 2, 'both class methods must survive span dedupe');
  assert.deepEqual(methods.map(s => s.symbolKey).sort(), [
    'python|src/twin.py|method|member|Alpha.run|0',
    'python|src/twin.py|method|member|Beta.run|0',
  ]);
  for (const m of methods) {
    assert.equal(m.name, m.name.split('.').pop(), 'record names stay unqualified');
    assert.equal(m.exportScope, 'member', 'members expose the D2 member scope');
  }

  // Top-level class keys and shapes are unchanged: no container field.
  const alpha = symbols.find(s => s.kind === 'class' && s.name === 'Alpha');
  assert.equal(alpha?.symbolKey, 'python|src/twin.py|class|exported|Alpha|0');
  assert.equal(alpha?.container, undefined, 'classes do not gain a container field');
});

test('python: decorated method keeps its container; span starts at the decorator', async () => {
  const content = [
    'class Svc:',
    '    @mydecorator',
    '    def handle(self, a):',
    '        pass',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/decorated.py', content });

  const handle = symbols.find(s => s.kind === 'method' && s.name === 'handle');
  assert.ok(handle, 'decorated class method must be extracted');
  assert.equal(handle.container, 'Svc');
  assert.equal(handle.exportScope, 'member');
  assert.equal(handle.arity, 1, 'first positional parameter is the bound receiver (by position)');
  assert.equal(handle.symbolKey, 'python|src/decorated.py|method|member|Svc.handle|1');

  const line = content.split('\n')[handle.range.startLine - 1];
  assert.match(line, /@mydecorator/, 'the recorded range starts at the decorator wrapper');
});

test('python: @staticmethod keeps all declared slots, names self/cls included', async () => {
  const content = [
    'class Svc:',
    '    @staticmethod',
    '    def take(self, cls):',
    '        pass',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/static.py', content });

  const take = symbols.find(s => s.kind === 'method' && s.name === 'take');
  assert.ok(take, '@staticmethod method must be extracted');
  assert.equal(take.arity, 2, '@staticmethod is not bound: self/cls are ordinary slots');
  assert.equal(take.symbolKey, 'python|src/static.py|method|member|Svc.take|2');
});

test('python: @classmethod excludes its first positional receiver', async () => {
  const content = [
    'class Svc:',
    '    @classmethod',
    '    def make(cls, a):',
    '        pass',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/classmethod.py', content });

  const make = symbols.find(s => s.kind === 'method' && s.name === 'make');
  assert.ok(make, '@classmethod method must be extracted');
  assert.equal(make.arity, 1, 'the class-bound receiver slot is excluded by position');
  assert.equal(make.symbolKey, 'python|src/classmethod.py|method|member|Svc.make|1');
});

test('python: __init__ is a method with its actual name and declared arity', async () => {
  const content = [
    'class C:',
    '    def __init__(self, a, b):',
    '        pass',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/init.py', content });

  const init = symbols.find(s => s.kind === 'method' && s.name === '__init__');
  assert.ok(init, '__init__ must be extracted as a method, not renamed');
  assert.equal(init.container, 'C');
  assert.equal(init.arity, 2, 'receiver excluded; a and b are declared slots');
  assert.equal(init.symbolKey, 'python|src/init.py|method|member|C.__init__|2');
});

test('python: receiver is excluded by position, not by parameter name', async () => {
  const content = [
    'class R:',
    '    def typed(self: "R", x):',
    '        pass',
    '    def renamed(this, y):',
    '        pass',
    '    def realnames(alpha, self, cls):',
    '        pass',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/receivers.py', content });

  const typed = symbols.find(s => s.name === 'typed');
  assert.equal(typed?.arity, 1, 'typed receiver slot excluded by position');
  assert.equal(typed?.symbolKey, 'python|src/receivers.py|method|member|R.typed|1');

  const renamed = symbols.find(s => s.name === 'renamed');
  assert.equal(renamed?.arity, 1, 'renamed receiver excluded by position, not by name');
  assert.equal(renamed?.symbolKey, 'python|src/receivers.py|method|member|R.renamed|1');

  const realnames = symbols.find(s => s.name === 'realnames');
  assert.equal(realnames?.arity, 2, 'real arguments named self/cls after the receiver still count');
  assert.equal(realnames?.symbolKey, 'python|src/receivers.py|method|member|R.realnames|2');
});

test('python: variadic slots count one and are never removed as a receiver', async () => {
  const content = [
    'class V:',
    '    def only(*args):',
    '        pass',
    '    def kwonly(*args, z):',
    '        pass',
    '    def withrecv(self, *rest):',
    '        pass',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/variadic.py', content });

  const only = symbols.find(s => s.name === 'only');
  assert.equal(only?.arity, 1, 'first variadic is not an explicit positional receiver slot');
  assert.equal(only?.symbolKey, 'python|src/variadic.py|method|member|V.only|1');

  const kwonly = symbols.find(s => s.name === 'kwonly');
  assert.equal(kwonly?.arity, 2, 'variadic plus keyword-only slot are two declared slots');

  const withrecv = symbols.find(s => s.name === 'withrecv');
  assert.equal(withrecv?.arity, 1, 'receiver excluded, the variadic itself still counts one');
});

test('python: typed first-slot variadics are declared slots, never receiver-elided', async () => {
  // Real AST: `*args: int` is a typed_parameter whose FIRST NAMED child is a
  // list_splat_pattern (likewise dictionary_splat_pattern for `**kw: int`) —
  // a variadic shape, not a positional receiver candidate. The distinction is
  // the actual AST child kind, never parameter text or an identifier guess.
  const content = [
    'class V:',
    '    def t1(*args: int):',
    '        pass',
    '    def t2(**kw: int):',
    '        pass',
    '    def t3(*args: int, flag, note=1  # trailing note',
    '        ):',
    '        pass',
    '    def t4(self, *rest: str, flag):',
    '        pass',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/typed-variadic.py', content });

  const t1 = symbols.find(s => s.name === 't1');
  assert.ok(t1, 'typed *args method extracted');
  assert.equal(t1.arity, 1, 'typed list-splat first slot counts one (no receiver to elide)');
  assert.equal(t1.symbolKey, 'python|src/typed-variadic.py|method|member|V.t1|1');

  const t2 = symbols.find(s => s.name === 't2');
  assert.ok(t2, 'typed **kw method extracted');
  assert.equal(t2.arity, 1, 'typed dictionary-splat first slot counts one (no receiver to elide)');
  assert.equal(t2.symbolKey, 'python|src/typed-variadic.py|method|member|V.t2|1');

  const t3 = symbols.find(s => s.name === 't3');
  assert.equal(t3?.arity, 3,
    'typed variadic + keyword-only identifier + defaulted slot count three; the comment adds none');
  assert.equal(t3?.symbolKey, 'python|src/typed-variadic.py|method|member|V.t3|3');

  const t4 = symbols.find(s => s.name === 't4');
  assert.equal(t4?.arity, 2,
    'positional receiver elided by position; typed variadic and keyword-only slot both count');
  assert.equal(t4?.symbolKey, 'python|src/typed-variadic.py|method|member|V.t4|2');
});

// ── Python: negatives — no invented containers or symbols ────────────────────

test('python: nested function inside a method is not extracted', async () => {
  const content = [
    'class N:',
    '    def outer(self):',
    '        def inner(x):',
    '            pass',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/nested-func.py', content });

  assert.ok(!symbols.some(s => s.name === 'inner'), 'inner is not a class member nor top-level');
  const outer = symbols.find(s => s.kind === 'method' && s.name === 'outer');
  assert.ok(outer, 'the enclosing method itself is still extracted');
  assert.equal(outer.symbolKey, 'python|src/nested-func.py|method|member|N.outer|0');
});

test('python: nested class methods do not inherit the outer container', async () => {
  const content = [
    'class Outer:',
    '    class Inner:',
    '        def deep(self):',
    '            pass',
    '    def top(self):',
    '        pass',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/nested-class.py', content });

  const methods = symbols.filter(s => s.kind === 'method');
  assert.equal(methods.length, 1, 'only the top-level class method resolves a container');
  assert.equal(methods[0].name, 'top');
  assert.equal(methods[0].container, 'Outer');
  assert.ok(!symbols.some(s => s.name === 'deep'), 'nested class method fails closed');
  assert.ok(!symbols.some(s => s.name === 'Inner'), 'nested class symbol stays non-top-level');
});

test('python: decorated top-level class methods fail closed when no class symbol exists', async () => {
  const content = [
    '@dataclass',
    'class Point:',
    '    def m(self):',
    '        pass',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/decorated-class.py', content });

  assert.ok(!symbols.some(s => s.name === 'm'),
    'no container may be invented for a class without a captured top-level class symbol');
  assert.ok(!symbols.some(s => s.name === 'Point'),
    'the decorated class itself keeps its existing capture behavior');
});

test('python: top-level decorated function parity — legacy key bytes unchanged', async () => {
  const content = [
    '@staticmethod',
    'def helper():',
    '    pass',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/topdec.py', content });

  const helper = symbols.find(s => s.kind === 'function' && s.name === 'helper');
  assert.ok(helper, 'top-level decorated function keeps legacy extraction');
  assert.equal(helper.container, undefined, 'top-level functions never gain a container');
  assert.equal(helper.symbolKey, 'python|src/topdec.py|function|exported|helper|0');
});

test('python: legacy global helper arity stays untouched (known self skip)', async () => {
  const content = [
    'def legacy(self):',
    '    pass',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/legacy-fn.py', content });

  const legacy = symbols.find(s => s.kind === 'function' && s.name === 'legacy');
  assert.equal(legacy?.arity, 0,
    'the legacy global countArity self skip is preserved byte-for-byte (known bug, protected)');
  assert.equal(legacy?.symbolKey, 'python|src/legacy-fn.py|function|exported|legacy|0');
});

// ── Java: members of named top-level types ───────────────────────────────────

test('java: constructor keeps kind method and its actual AST name', async () => {
  const content = [
    'class C {',
    '  C(int x) {}',
    '}',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/Ctor.java', content });

  const ctor = symbols.find(s => s.kind === 'method' && s.name === 'C');
  assert.ok(ctor, 'constructor must be extracted as a method');
  assert.equal(ctor.container, 'C');
  assert.equal(ctor.exportScope, 'member');
  assert.equal(ctor.arity, 1, 'the declared formal parameter counts one slot');
  assert.equal(ctor.symbolKey, 'java|src/Ctor.java|method|member|C.C|1');
});

test('java: same method name in two top-level classes yields distinct container keys', async () => {
  const content = [
    'class Alpha { void run() {} }',
    'class Beta { void run() {} }',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/twin.java', content });

  const methods = symbols.filter(s => s.kind === 'method');
  assert.equal(methods.length, 2, 'both same-line methods must survive span dedupe');
  assert.deepEqual(methods.map(s => s.symbolKey).sort(), [
    'java|src/twin.java|method|member|Alpha.run|0',
    'java|src/twin.java|method|member|Beta.run|0',
  ]);
  const alpha = symbols.find(s => s.kind === 'class' && s.name === 'Alpha');
  assert.equal(alpha?.container, undefined, 'classes do not gain a container field');
});

test('java: same-arity typed overloads keep the identical canonical key as distinct spans', async () => {
  const content = 'class Box { void m(int a) {} void m(String a) {} }';
  const symbols = await extractSymbolsForFile({ filePath: 'src/Over.java', content });

  const overloads = symbols.filter(s => s.kind === 'method' && s.name === 'm');
  assert.equal(overloads.length, 2,
    'both distinct same-line AST declarations must be retained (no silent collapse)');
  const keys = overloads.map(s => s.symbolKey);
  assert.equal(keys[0], keys[1],
    'typed overloads with the same arity intentionally share one canonical key (unresolved collision)');
  assert.equal(keys[0], 'java|src/Over.java|method|member|Box.m|1');
  for (const m of overloads) {
    assert.ok(!('ordinal' in m) && !('variant' in m),
      'no invented ordinal/variant identity is added for the collision');
  }
});

test('java: static method is a member with declared-slot arity', async () => {
  const content = [
    'class S {',
    '  static int add(int a, int b) { return a + b; }',
    '}',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/Static.java', content });

  const add = symbols.find(s => s.kind === 'method' && s.name === 'add');
  assert.ok(add, 'static method must be extracted');
  assert.equal(add.container, 'S');
  assert.equal(add.exportScope, 'member');
  assert.equal(add.arity, 2);
  assert.equal(add.symbolKey, 'java|src/Static.java|method|member|S.add|2');
});

test('java: explicit receiver_parameter excluded, varargs count one, comments ignored', async () => {
  const content = [
    'class P {',
    '  void recv(P this, int y) {}',
    '  void va(String... args) {}',
    '  void cm(/* c */ int a, int b) {}',
    '}',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/Params.java', content });

  const recv = symbols.find(s => s.name === 'recv');
  assert.ok(recv, 'explicit receiver_parameter method extracted');
  assert.equal(recv.arity, 1, 'the explicit receiver is not an argument slot');
  assert.equal(recv.symbolKey, 'java|src/Params.java|method|member|P.recv|1');

  const va = symbols.find(s => s.name === 'va');
  assert.equal(va?.arity, 1, 'a varargs parameter is exactly one declared slot');

  const cm = symbols.find(s => s.name === 'cm');
  assert.equal(cm?.arity, 2, 'parameter comments are not slots');
});

test('java: interface methods resolve the existing interface symbol as container', async () => {
  const content = [
    'interface G {',
    '  String greet();',
    '  default void go() {}',
    '}',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/G.java', content });

  const greet = symbols.find(s => s.name === 'greet');
  assert.ok(greet, 'abstract interface method_declaration is a member');
  assert.equal(greet.container, 'G');
  assert.equal(greet.arity, 0);
  assert.equal(greet.symbolKey, 'java|src/G.java|method|member|G.greet|0');

  const go = symbols.find(s => s.name === 'go');
  assert.ok(go, 'default interface method is a member');
  assert.equal(go.symbolKey, 'java|src/G.java|method|member|G.go|0');

  const iface = symbols.find(s => s.kind === 'interface' && s.name === 'G');
  assert.equal(iface?.container, undefined, 'the interface symbol itself keeps no container');
});

test('java: enum methods resolve the existing enum class symbol as container', async () => {
  const content = [
    'enum Status {',
    '  ACTIVE;',
    '  void describe() {}',
    '}',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/Status.java', content });

  const describe = symbols.find(s => s.name === 'describe');
  assert.ok(describe, 'enum member method is extracted');
  assert.equal(describe.container, 'Status');
  assert.equal(describe.symbolKey, 'java|src/Status.java|method|member|Status.describe|0');
});

// ── Java: negatives — nested/unsupported containers documented ───────────────

test('java: nested class methods do not inherit the outer container', async () => {
  const content = [
    'class Outer {',
    '  class Inner { void deep() {} }',
    '  void top() {}',
    '}',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/Nested.java', content });

  const methods = symbols.filter(s => s.kind === 'method');
  assert.equal(methods.length, 1, 'only the top-level class method resolves a container');
  assert.equal(methods[0].name, 'top');
  assert.equal(methods[0].container, 'Outer');
  assert.ok(!symbols.some(s => s.name === 'deep'), 'nested class method fails closed');
  assert.ok(!symbols.some(s => s.name === 'Inner'), 'nested class symbol stays non-top-level');
});

test('java: record methods stay unsupported (no record container capture)', async () => {
  const content = 'record Point(int x) { int sum() { return x; } }';
  const symbols = await extractSymbolsForFile({ filePath: 'src/Point.java', content });

  assert.ok(!symbols.some(s => s.kind === 'method'),
    'record bodies have no captured top-level container in this unit — honestly unsupported');
});
