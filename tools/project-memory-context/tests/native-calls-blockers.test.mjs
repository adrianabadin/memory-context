import test from 'node:test';
import assert from 'node:assert/strict';
import { extractNativeCalls } from '../src/relations/native-calls.mjs';

async function noTargets(content, extension = 'ts') {
  const files = [{ path: `src/blocker.${extension}`, content }];
  const before = JSON.stringify(files);
  const result = await extractNativeCalls({ files });
  assert.equal(JSON.stringify(files), before);
  assert.equal(result.relations.length, 0, content);
  assert.ok(result.unresolved.length > 0, content);
  assert.ok(result.unresolved.every(fact => !Object.hasOwn(fact, 'target')));
}

test('verified blocker 1: class type parameters cannot resolve field annotations to global classes', async () => {
  for (const field of ['item: T;', 'constructor(private item: T) {}']) {
    await noTargets(`class T { go() {} } class Box<T> { ${field} run() { this.item.go(); } }`);
  }
  await noTargets('class T { go() {} } class Box<T extends TBase> { item: T; run() { this.item.go(); } }');
});

test('verified blocker 2: named function-expression self names shadow unrelated module functions', async () => {
  await noTargets('function g() {} const f = function g() { g(); };');
  await noTargets('function g() {} export const f = function g() { g(); };');
});

test('verified blocker 3: module-block var declarations invalidate hoisted same-name bindings', async () => {
  for (const declaration of ['if (c) { var foo = 1; }', 'for (var foo = 0; c; ) {}', '{ var foo; }']) {
    await noTargets(`function foo() {} ${declaration} function bar() { foo(); }`, 'js');
  }
});

test('verified blocker 4: instance fields and parameter properties cannot masquerade as methods', async () => {
  await noTargets('class A { m = () => 1; m() {} run() { this.m(); } }', 'js');
  await noTargets('class S {} class A { constructor(private m: S) {} m() {} run() { this.m(); } }');
  await noTargets('class A { [key] = () => 1; m() {} run() { this.m(); } }', 'js');
  await noTargets('class A { static m = () => 1; static m() {} static run() { this.m(); } }', 'js');
});

test('verified blocker 5: class method signatures remain ambiguous with their implementation', async () => {
  await noTargets('class A { m(a: string): void; m(a: number): void; m(a: any) {} run() { this.m(1); } }');
  await noTargets('class A { static m(a: string): void; static m(a: number): void; static m(a: any) {} static run() { this.m(1); } }');
});
