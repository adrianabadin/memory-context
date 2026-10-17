import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Query } from 'web-tree-sitter';

import { extractSymbolsForFile } from '../src/extractors/tree-sitter/extract.mjs';
import { initParser, loadLanguage } from '../src/extractors/tree-sitter/runtime.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, 'fixtures', 'layered-app');
const queryDir = join(__dirname, '../src/extractors/tree-sitter/queries');

async function extractFixtureFile(relPath) {
  const content = await readFile(join(fixtureDir, relPath), 'utf8');
  const symbols = await extractSymbolsForFile({ filePath: relPath, content });
  return { content, symbols };
}

// ── Real backend provenance: the shipped WASM grammars + query files compile ──

test('javascript/typescript/tsx query files compile against their real WASM grammars', async () => {
  await initParser();
  for (const language of ['javascript', 'typescript', 'tsx']) {
    const queryText = await readFile(join(queryDir, `${language}.scm`), 'utf8');
    const lang = await loadLanguage(language);
    assert.doesNotThrow(
      () => new Query(lang, queryText),
      `${language}.scm must compile against the shipped ${language} grammar`,
    );
  }
});

// ── Layered-app acceptance: exact D2 keys from real TS sources ────────────────

test('layered-app: UserService.findById is a member with the exact D2 key', async () => {
  const { content, symbols } = await extractFixtureFile('src/services/user.service.ts');

  const method = symbols.find(s => s.kind === 'method' && s.name === 'findById');
  assert.ok(method, 'findById method should be extracted');
  assert.equal(method.name, 'findById', 'record name must stay unqualified');
  assert.equal(method.container, 'UserService');
  assert.equal(method.exportScope, 'member');
  assert.equal(method.arity, 1);
  assert.equal(
    method.symbolKey,
    'ts|src/services/user.service.ts|method|member|UserService.findById|1',
  );

  // AST source evidence: the recorded range points at the real method line.
  const line = content.split('\n')[method.range.startLine - 1];
  assert.match(line, /findById/);

  // Top-level class key regression: exact bytes unchanged.
  const cls = symbols.find(s => s.kind === 'class' && s.name === 'UserService');
  assert.ok(cls, 'top-level class should still be extracted');
  assert.equal(cls.symbolKey, 'ts|src/services/user.service.ts|class|exported|UserService|0');
  assert.equal(cls.container, undefined, 'classes do not gain a container field');
});

test('layered-app: UserRepository.findOne carries its own container key', async () => {
  const { symbols } = await extractFixtureFile('src/repositories/user.repository.ts');

  const method = symbols.find(s => s.kind === 'method' && s.name === 'findOne');
  assert.ok(method, 'findOne method should be extracted');
  assert.equal(method.container, 'UserRepository');
  assert.equal(
    method.symbolKey,
    'ts|src/repositories/user.repository.ts|method|member|UserRepository.findOne|1',
  );
});

test('layered-app: decorated export class UserController.getUser is extracted', async () => {
  const { content, symbols } = await extractFixtureFile('src/controllers/user.controller.ts');

  const method = symbols.find(s => s.kind === 'method' && s.name === 'getUser');
  assert.ok(method, 'getUser method of the decorated export class should be extracted');
  assert.equal(method.container, 'UserController');
  assert.equal(
    method.symbolKey,
    'ts|src/controllers/user.controller.ts|method|member|UserController.getUser|1',
  );
  const line = content.split('\n')[method.range.startLine - 1];
  assert.match(line, /getUser/);

  // Existing top-level declarations keep their exact key bytes.
  const cls = symbols.find(s => s.kind === 'class' && s.name === 'UserController');
  assert.equal(cls?.symbolKey, 'ts|src/controllers/user.controller.ts|class|exported|UserController|0');
  const fn = symbols.find(s => s.kind === 'function' && s.name === 'Controller');
  assert.equal(fn?.symbolKey, 'ts|src/controllers/user.controller.ts|function|local|Controller|0');
});

// ── Key distinctness per container ────────────────────────────────────────────

test('same method name in two same-line classes yields distinct container keys', async () => {
  const content = 'class Alpha { run() {} } class Beta { run() {} }';
  const symbols = await extractSymbolsForFile({ filePath: 'src/twin.js', content });

  const methods = symbols.filter(s => s.kind === 'method');
  assert.equal(methods.length, 2, 'both same-line methods must survive dedupe');
  const keys = methods.map(s => s.symbolKey).sort();
  assert.deepEqual(keys, [
    'js|src/twin.js|method|member|Alpha.run|0',
    'js|src/twin.js|method|member|Beta.run|0',
  ]);
});

// ── Fail-closed: no invented containers ───────────────────────────────────────

test('object literal methods never acquire a class container', async () => {
  const content = 'const o = { run(x) { return x; } };';
  const symbols = await extractSymbolsForFile({ filePath: 'src/obj.js', content });
  assert.deepEqual(symbols.filter(s => s.kind === 'method'), []);
});

test('anonymous default class methods are not extracted', async () => {
  const content = 'export default class { run() {} }';
  const symbols = await extractSymbolsForFile({ filePath: 'src/anon.js', content });
  assert.deepEqual(symbols, []);
});

test('named default class methods use the concrete class name', async () => {
  const content = 'export default class Named { run(a) {} }';
  const symbols = await extractSymbolsForFile({ filePath: 'src/named-default.js', content });
  const method = symbols.find(s => s.kind === 'method');
  assert.ok(method, 'method of a named default class should be extracted');
  assert.equal(method.container, 'Named');
  assert.equal(method.symbolKey, 'js|src/named-default.js|method|member|Named.run|1');
});

test('nested class methods do not inherit the outer container', async () => {
  const content = 'class Outer { m() { class Inner { deep() {} } } }';
  const symbols = await extractSymbolsForFile({ filePath: 'src/nested.js', content });

  const methods = symbols.filter(s => s.kind === 'method');
  assert.equal(methods.length, 1, 'only the top-level class method is extracted');
  assert.equal(methods[0].name, 'm');
  assert.equal(methods[0].container, 'Outer');
  assert.ok(!symbols.some(s => s.name === 'deep'), 'nested class method must be skipped');
  assert.ok(!symbols.some(s => s.name === 'Inner'), 'nested class symbol stays non-top-level');
});

test('computed and string method names fail closed (no stable identifier)', async () => {
  const content = 'class C { [Symbol.iterator]() {} "quoted"() {} }';
  const symbols = await extractSymbolsForFile({ filePath: 'src/computed.js', content });
  assert.deepEqual(symbols.filter(s => s.kind === 'method'), []);
});

// ── Actual JS AST features: static / private / constructor / accessors ───────

test('static, private, constructor and accessor methods derive from real AST nodes', async () => {
  const content = [
    'class A {',
    '  constructor(x) {}',
    '  static create(a, b) {}',
    '  #secret(v) {}',
    '  get value() {}',
    '  set value(v) {}',
    '}',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/features.js', content });
  const methods = symbols.filter(s => s.kind === 'method');
  const byName = new Map(methods.map(s => [`${s.name}:${s.arity}`, s]));

  assert.equal(methods.length, 5, 'constructor, static, private, getter and setter are methods');
  assert.ok(byName.has('constructor:1'));
  assert.equal(byName.get('constructor:1').container, 'A');
  assert.ok(byName.has('create:2'), 'static identifier method with arity 2');
  assert.ok(byName.has('#secret:1'), 'private identifier name is the honest AST text');
  assert.ok(byName.has('value:0'), 'getter arity 0');
  assert.ok(byName.has('value:1'), 'setter arity 1');

  for (const m of methods) {
    assert.equal(m.container, 'A');
    assert.equal(m.exportScope, 'member');
    assert.match(m.symbolKey, /^js\|src\/features\.js\|method\|member\|A\..+\|\d+$/);
  }
  assert.ok(!symbols.some(s => s.kind === 'field' || s.kind === 'property'),
    'fields/properties are not new symbol kinds');
});

// ── TS forms that are not automatically class methods ─────────────────────────

test('TS interface members and abstract signatures are not class methods', async () => {
  const content = [
    'interface Repo { findOne(id: string): Promise<void>; }',
    'abstract class Base { concrete() {} abstract run(): void; }',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/abstract.ts', content });

  assert.deepEqual(symbols.filter(s => s.kind === 'method'), []);
  assert.ok(symbols.some(s => s.kind === 'interface' && s.name === 'Repo'),
    'the interface declaration itself is still extracted');
  assert.ok(!symbols.some(s => s.name === 'Base'),
    'abstract class has no top-level class symbol yet, so its methods stay skipped');
});

test('TS arity keeps the existing counting rule for optional and rest params', async () => {
  const content = [
    'export class Clamp {',
    '  static clamp(n?: number, ...rest: number[]): void {}',
    '  empty() {}',
    '}',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/clamp.ts', content });
  const clamp = symbols.find(s => s.kind === 'method' && s.name === 'clamp');
  const empty = symbols.find(s => s.kind === 'method' && s.name === 'empty');
  assert.equal(clamp?.arity, 2, 'optional + rest parameters count under the existing rule');
  assert.equal(clamp?.symbolKey,
    'ts|src/clamp.ts|method|member|Clamp.clamp|2');
  assert.equal(empty?.arity, 0);
});

// ── TSX: JSX embedded in a method body parses with the real tsx grammar ───────

test('TSX method with a JSX body extracts with a container key', async () => {
  const content = [
    'export class Card {',
    '  render(items: string[]) {',
    '    return <div className="x">{items.map((i) => <span>{i}</span>)}</div>;',
    '  }',
    '}',
  ].join('\n');
  const symbols = await extractSymbolsForFile({ filePath: 'src/Card.tsx', content });

  const method = symbols.find(s => s.kind === 'method' && s.name === 'render');
  assert.ok(method, 'render method should be extracted from the tsx grammar');
  assert.equal(method.container, 'Card');
  assert.equal(method.arity, 1);
  assert.equal(method.symbolKey, 'tsx|src/Card.tsx|method|member|Card.render|1');

  const cls = symbols.find(s => s.kind === 'class' && s.name === 'Card');
  assert.equal(cls?.symbolKey, 'tsx|src/Card.tsx|class|exported|Card|0');
});

// ── Same-line declarations: AST-span dedupe, no silent collapse ──────────

test('same-line getter/setter pair keeps both D2 arity keys', async () => {
  const content = 'class Box { get value(){return 1} set value(v){this.v=v} }';
  const symbols = await extractSymbolsForFile({ filePath: 'src/box.js', content });

  const methods = symbols.filter(s => s.kind === 'method');
  assert.equal(methods.length, 2, 'both same-line accessor declarations must survive');
  const keys = methods.map(s => s.symbolKey).sort();
  assert.deepEqual(keys, [
    'js|src/box.js|method|member|Box.value|0',
    'js|src/box.js|method|member|Box.value|1',
  ]);
  for (const m of methods) {
    assert.equal(m.name, 'value', 'record names stay unqualified');
    assert.equal(m.container, 'Box');
  }
});

test('same-line same-name methods with different arities are both retained', async () => {
  const content = 'class Box { run(){return 1} run(x){return x} }';
  const symbols = await extractSymbolsForFile({ filePath: 'src/overload.js', content });

  const methods = symbols.filter(s => s.kind === 'method');
  assert.equal(methods.length, 2, 'distinct same-line declarations must both survive');
  assert.deepEqual(methods.map(s => s.symbolKey).sort(), [
    'js|src/overload.js|method|member|Box.run|0',
    'js|src/overload.js|method|member|Box.run|1',
  ]);
});

test('same-line identical-key declarations stay separate records (no collapse)', async () => {
  const content = 'class Box { run(){return 1} run(){return 2} }';
  const symbols = await extractSymbolsForFile({ filePath: 'src/dup.js', content });

  const methods = symbols.filter(s => s.kind === 'method');
  assert.equal(methods.length, 2,
    'two distinct AST declarations with the same canonical key must not silently collapse');
  const keys = methods.map(s => s.symbolKey);
  assert.equal(keys[0], keys[1], 'the ambiguity is preserved as an identical-key pair');
  assert.equal(keys[0], 'js|src/dup.js|method|member|Box.run|0');
  for (const m of methods) {
    assert.ok(!('ordinal' in m) && !('variant' in m),
      'no invented ordinal/variant identity is added');
  }
});

test('TS same-line accessor pair keeps both canonical keys', async () => {
  const content = 'class Box { get value(): number { return 1; } set value(v: number) {} }';
  const symbols = await extractSymbolsForFile({ filePath: 'src/box.ts', content });

  const methods = symbols.filter(s => s.kind === 'method');
  assert.equal(methods.length, 2, 'both TS same-line accessor declarations must survive');
  assert.deepEqual(methods.map(s => s.symbolKey).sort(), [
    'ts|src/box.ts|method|member|Box.value|0',
    'ts|src/box.ts|method|member|Box.value|1',
  ]);
});

// ── Unit 1.2-B0: member parameter-slot counting (JS/TS/TSX members only) ──────

test('JS member counts declared slots: self/cls names and renames keep one D2 key', async () => {
  const receiver = await extractSymbolsForFile({
    filePath: 'src/box-params.js',
    content: 'class Box { take(self, cls) {} }',
  });
  const renamed = await extractSymbolsForFile({
    filePath: 'src/box-params.js',
    content: 'class Box { take(alpha, beta) {} }',
  });

  const take = receiver.find(s => s.kind === 'method' && s.name === 'take');
  assert.ok(take, 'take member must be extracted');
  assert.equal(take.arity, 2, 'self and cls are declared parameter slots for a member');
  assert.equal(take.symbolKey, 'js|src/box-params.js|method|member|Box.take|2');

  const renamedTake = renamed.find(s => s.kind === 'method' && s.name === 'take');
  assert.equal(renamedTake?.symbolKey, take.symbolKey,
    'renaming parameter identifiers must not change the member D2 key');
});

test('JS member parameter comments are not additional slots', async () => {
  const leading = await extractSymbolsForFile({
    filePath: 'src/box-comment.js',
    content: 'class Box { take(/* note */ a, b) {} }',
  });
  const leadingTake = leading.find(s => s.kind === 'method' && s.name === 'take');
  assert.equal(leadingTake?.arity, 2, 'a comment inside formal_parameters is not a declared slot');
  assert.equal(leadingTake?.symbolKey, 'js|src/box-comment.js|method|member|Box.take|2');

  const trailing = await extractSymbolsForFile({
    filePath: 'src/box-comment.js',
    content: 'class Box { take(a /* trail */, b) {} }',
  });
  const trailingTake = trailing.find(s => s.kind === 'method' && s.name === 'take');
  assert.equal(trailingTake?.arity, 2, 'trailing parameter comments are slots-neutral too');
});

test('TS and TSX members count untyped self/cls parameters as slots', async () => {
  const ts = await extractSymbolsForFile({
    filePath: 'src/box-untyped.ts',
    content: 'class Box { take(self, cls) {} }',
  });
  const tsTake = ts.find(s => s.kind === 'method' && s.name === 'take');
  assert.equal(tsTake?.arity, 2, 'TS untyped self/cls are declared slots');
  assert.equal(tsTake?.symbolKey, 'ts|src/box-untyped.ts|method|member|Box.take|2');

  const tsx = await extractSymbolsForFile({
    filePath: 'src/box-untyped.tsx',
    content: 'class Box { take(self, cls) {} }',
  });
  const tsxTake = tsx.find(s => s.kind === 'method' && s.name === 'take');
  assert.equal(tsxTake?.arity, 2, 'TSX untyped self/cls are declared slots');
  assert.equal(tsxTake?.symbolKey, 'tsx|src/box-untyped.tsx|method|member|Box.take|2');
});

test('TS/TSX explicit this receiver parameter is not a runtime formal slot', async () => {
  const ts = await extractSymbolsForFile({
    filePath: 'src/this-receiver.ts',
    content: 'class Box { take(this: Box, a?: number, ...rest: string[]): void {} }',
  });
  const take = ts.find(s => s.kind === 'method' && s.name === 'take');
  assert.ok(take, 'TS receiver method must be extracted');
  assert.equal(take.arity, 2, 'this receiver excluded; optional + rest each count one slot');
  assert.equal(take.symbolKey, 'ts|src/this-receiver.ts|method|member|Box.take|2');

  const tsx = await extractSymbolsForFile({
    filePath: 'src/this-receiver.tsx',
    content: 'class Box { take(this: Box, x: number) {} }',
  });
  const tsxTake = tsx.find(s => s.kind === 'method' && s.name === 'take');
  assert.equal(tsxTake?.arity, 1, 'only x is a runtime slot after the compile-time receiver');
  assert.equal(tsxTake?.symbolKey, 'tsx|src/this-receiver.tsx|method|member|Box.take|1');
});

test('member default, destructuring and rest parameters each count one slot', async () => {
  const content = 'class Box { cfg(a = 1, {b}, ...rest) {} }';
  const symbols = await extractSymbolsForFile({ filePath: 'src/box-destructure.js', content });
  const cfg = symbols.find(s => s.kind === 'method' && s.name === 'cfg');
  assert.equal(cfg?.arity, 3, 'default + object destructuring + rest are three declared slots');
  assert.equal(cfg?.symbolKey, 'js|src/box-destructure.js|method|member|Box.cfg|3');
});

test('legacy global function descriptors keep their pre-B0 key bytes (pinned)', async () => {
  // Literal pre-fix behavior captured from the current code BEFORE the member
  // counter landed: legacy `countArity` skips self/cls and counts comments.
  // These descriptors stay intentionally wrong-but-stable; B0 must not rekey them.
  const takeAll = await extractSymbolsForFile({
    filePath: 'src/legacy.js',
    content: 'function take(self, cls) {}',
  });
  const take = takeAll.find(s => s.kind === 'function' && s.name === 'take');
  assert.equal(take?.arity, 0, 'legacy global self/cls skip is preserved byte-for-byte');
  assert.equal(take?.symbolKey, 'js|src/legacy.js|function|local|take|0');

  const commentOnly = await extractSymbolsForFile({
    filePath: 'src/legacy-comment.js',
    content: 'function foo(/* c */) {}',
  });
  const foo = commentOnly.find(s => s.kind === 'function' && s.name === 'foo');
  assert.equal(foo?.arity, 1, 'legacy block-comment descriptor keeps its literal pre-B0 count');
  assert.equal(foo?.symbolKey, 'js|src/legacy-comment.js|function|local|foo|1');
});

// ── Legacy languages: extraction output stays byte-compatible ─────────────────

test('C# methods keep legacy key behavior with no container field', async () => {
  const content = 'public class UserService { public int Get(int x) { return x; } }';
  const symbols = await extractSymbolsForFile({ filePath: 'src/service.cs', content });

  const method = symbols.find(s => s.kind === 'method' && s.name === 'Get');
  assert.ok(method, 'legacy C# method extraction is preserved');
  assert.equal(method.container, undefined, 'unit A does not add containers to C# output');
  assert.equal(method.symbolKey, 'csharp|src/service.cs|global|none|method|Get|()');
});

test('PHP methods keep legacy key behavior with no container field', async () => {
  const content = '<?php\nclass Foo { public function handle($a) { return $a; } }\n';
  const symbols = await extractSymbolsForFile({ filePath: 'src/foo.php', content });

  const method = symbols.find(s => s.kind === 'method' && s.name === 'handle');
  assert.ok(method, 'legacy PHP method extraction is preserved');
  assert.equal(method.container, undefined, 'unit A does not add containers to PHP output');
  assert.equal(method.symbolKey, 'php|src/foo.php|method|exported|handle|1');
});
