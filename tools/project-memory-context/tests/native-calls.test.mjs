import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const file = (path, content) => ({ path, content });
async function calls(files, extra = {}) {
  return (await import('../src/relations/native-calls.mjs')).extractNativeCalls({ files, ...extra });
}
const key = (path, kind, scope, name, arity = 0) => `ts|${path}|${kind}|${scope}|${name}|${arity}`;
const edges = result => result.relations.map(e => [e.source.symbolKey, e.target.symbolKey]);
function safe(result) {
  for (const e of result.relations) {
    assert.equal(e.relation, 'calls');
    for (const endpoint of [e.source, e.target]) {
      assert.equal(endpoint.id, endpoint.symbolKey);
      assert.ok(result.symbols.some(s => s.symbolKey === endpoint.symbolKey));
    }
    assert.ok(e.range.startLine > 0);
  }
  assert.ok(result.unresolved.every(e => !Object.hasOwn(e, 'target')));
}

test('direct local calls use actual extracted canonical declarations; input is unchanged', async () => {
  const files = [file('src/main.ts', 'function helper(x: number) { return x; }\nexport function main() { return helper(1); }')];
  const before = JSON.stringify(files);
  const r = await calls(files, { symbols: [{ symbolKey: 'forged', name: 'helper' }] });
  assert.deepEqual(edges(r), [[key('src/main.ts','function','exported','main'), key('src/main.ts','function','local','helper',1)]]);
  assert.equal(JSON.stringify(files), before);
  assert.deepEqual(r.unresolved, []); safe(r);
});

test('named import aliases and local export aliases resolve the actual key without rekeying', async () => {
  const r = await calls([
    file('src/main.ts', "import { renamed as execute } from './dep';\nexport function main() { execute('x'); }"),
    file('src/dep.ts', 'function run(x: string) {}\nexport { run as renamed };'),
  ]);
  assert.deepEqual(edges(r), [[key('src/main.ts','function','exported','main'),key('src/dep.ts','function','local','run',1)]]);
  assert.deepEqual(r.unresolved, []); safe(r);
});

test('default and namespace function imports bind explicit exports, not names guessed from strings', async () => {
  const r = await calls([
    file('src/main.ts', "import execute from './dep';\nimport * as ns from './dep';\nfunction main() { execute(); ns.named(); }"),
    file('src/dep.ts', 'export default function entry() {}\nexport function named() {}'),
  ]);
  assert.deepEqual(edges(r), [
    [key('src/main.ts','function','local','main'),key('src/dep.ts','function','exported','entry')],
    [key('src/main.ts','function','local','main'),key('src/dep.ts','function','exported','named')],
  ]); safe(r);
});

test('top-level arrow/function expressions retain existing canonical source and target keys', async () => {
  const r = await calls([file('src/main.ts','export const helper = (x: number) => x;\nexport const main = () => helper(1);')]);
  assert.deepEqual(edges(r), [[key('src/main.ts','function','exported','main'),key('src/main.ts','function','exported','helper',1)]]); safe(r);
});

test('const-new receivers and explicit constructors link declarations, not arbitrary method names', async () => {
  const r = await calls([
    file('src/main.ts', "import { Service as S } from './service';\nexport function main() { const svc = new S(); svc.run('x'); }"),
    file('src/service.ts','export class Service { constructor() {} run(x: string) {} }'),
  ]);
  assert.deepEqual(edges(r), [
    [key('src/main.ts','function','exported','main'),key('src/service.ts','method','member','Service.constructor')],
    [key('src/main.ts','function','exported','main'),key('src/service.ts','method','member','Service.run',1)],
  ]); safe(r);
});

test('typed this fields and constructor parameter properties bind unique imported concrete classes', async () => {
  for (const declaration of ['private svc: Service; constructor(svc: Service) { this.svc = svc; }', 'constructor(private readonly svc: Service) {}']) {
    const r = await calls([
      file('src/main.ts', `import { Service } from './service';\nexport class Controller { ${declaration} handle(x: string) { return this.svc.run(x); } }`),
      file('src/service.ts','export class Service { run(x: string) {} }'),
    ]);
    assert.deepEqual(edges(r), [[key('src/main.ts','method','member','Controller.handle',1),key('src/service.ts','method','member','Service.run',1)]]); safe(r);
  }
});

test('direct this methods and class static methods distinguish static from instance members', async () => {
  const r = await calls([file('src/main.ts', 'class A { m() { this.n(); A.s(); A.n(); } n() {} static s() {} }')]);
  assert.deepEqual(edges(r), [
    [key('src/main.ts','method','member','A.m'),key('src/main.ts','method','member','A.n')],
    [key('src/main.ts','method','member','A.m'),key('src/main.ts','method','member','A.s')],
  ]);
  assert.ok(r.unresolved.some(e => e.callee === 'A.n')); safe(r);
});

test('parameters, destructuring, block locals and nested function declarations shadow imports conservatively', async () => {
  for (const body of [
    'function main(run: any) { run(); }',
    'function main({run}: any) { run(); }',
    'function main() { const run = unknown; run(); }',
    'function main() { { let run = unknown; run(); } }',
    'function main() { function run() {} run(); }',
  ]) {
    const r = await calls([file('src/main.ts', `import { run } from './dep';\n${body}`),file('src/dep.ts','export function run() {}')]);
    assert.equal(r.relations.length, 0, body); safe(r);
  }
});

test('reassigned module bindings and receiver variables never get positive call edges', async () => {
  for (const body of [
    'function run() {}\nfunction main() { run = other; run(); }',
    'class A { m() {} }\nfunction main() { const a = new A(); a = other; a.m(); }',
    'class A { m() {} }\nfunction main() { let a = new A(); a.m(); }',
  ]) {
    const r = await calls([file('src/main.ts', body)]);
    assert.equal(r.relations.length, 0, body); safe(r);
  }
});

test('destructuring assignments and loop-assigned bindings are not mistaken for original functions', async () => {
  for (const body of [
    '({run} = other); run();',
    '[run] = other; run();',
    'for (run of callbacks) { run(); }',
    'for (const run of callbacks) { run(); }',
  ]) {
    const r = await calls([file('src/main.ts', `function run() {} function main() { ${body} }`)]);
    assert.equal(r.relations.length,0,body); safe(r);
  }
});

test('duplicate class names with different method names still withhold this-call uniqueness', async () => {
  const r = await calls([file('src/main.ts','class A { m() { this.n(); } n() {} } class A { other() {} }')]);
  assert.equal(r.relations.length,0); safe(r);
});

test('same-key declarations, overloads and duplicate export names fail closed without an order winner', async () => {
  for (const dep of [
    'export function run() {}\nexport function run() {}',
    'function run() {} function run() {}\nexport {run};',
    'export function run(x: number): void;\nexport function run(x: string): void;\nexport function run(x: any) {}',
    'function a() {} function b() {}\nexport {a as run, b as run};',
  ]) {
    const files = [file('src/main.ts', "import { run } from './dep';\nfunction main() { run(); }"),file('src/dep.ts',dep)];
    const r = await calls(files); assert.equal(r.relations.length,0,dep); safe(r);
    assert.deepEqual(r,await calls([...files].reverse()));
  }
});

test('method collisions, overloads and same-name concrete classes do not invent uniqueness', async () => {
  for (const content of [
    'class A { m() {} m() {} } function main() { const a = new A(); a.m(); }',
    'class A { m(x: number) {} m(x: number,y: number) {} } function main() { const a = new A(); a.m(1); }',
    'class A { m() {} } class A { m() {} } function main() { const a = new A(); a.m(); }',
  ]) {
    const r = await calls([file('src/main.ts',content)]);
    assert.equal(r.relations.length,0,content); safe(r);
  }
});

test('dynamic, optional, computed, type-only, inherited and unknown receivers remain unresolved', async () => {
  for (const content of [
    'function main(fn: any) { fn(); }',
    'function run() {} function main() { run?.(); }',
    'class A { m() {} } function main() { const a = new A(); a["m"](); }',
    'class A { m() {} } class B extends A {} function main() { const b = new B(); b.m(); }',
    'function main(obj: any) { obj.m(); }',
  ]) {
    const r = await calls([file('src/main.ts',content)]); assert.equal(r.relations.length,0,content); safe(r);
  }
  const typeOnly = await calls([file('src/main.ts',"import type {run} from './dep';\nfunction main(){run();}"),file('src/dep.ts','export function run() {}')]);
  assert.equal(typeOnly.relations.length,0); safe(typeOnly);
});

test('nested closures and top-level expressions are not attributed to an outer symbol', async () => {
  const r = await calls([file('src/main.ts','function run() {}\nfunction outer() { function inner() { run(); } const cb = () => run(); }\nrun();')]);
  assert.equal(r.relations.length,0); assert.equal(r.unresolved.length,3); safe(r);
});

test('unexported targets, reexports and missing/ambiguous import modules do not become symbol edges', async () => {
  for (const files of [
    [file('src/main.ts',"import {run} from './dep'; function main(){run();}"),file('src/dep.ts','function run() {}')],
    [file('src/main.ts',"import {run} from './dep'; function main(){run();}"),file('src/dep.ts',"export {run} from './real';"),file('src/real.ts','export function run() {}')],
    [file('src/main.ts',"import {run} from './dep'; function main(){run();}"),file('src/dep.ts','export function run() {}'),file('src/dep.js','export function run() {}')],
    [file('src/main.ts',"import {run} from './missing'; function main(){run();}")],
  ]) { const r = await calls(files); assert.equal(r.relations.length,0); safe(r); }
});

test('unsupported languages and duplicate file identities do not produce canonical call endpoints', async () => {
  const r = await calls([file('src/main.py','run()'),file('src/a.ts','function a(){b();}'),file('./src/a.ts','function a(){b();}')]);
  assert.equal(r.relations.length,0); assert.ok(r.unresolved.some(e => e.reason==='file-collision')); assert.ok(r.unresolved.some(e=>e.reason==='unsupported-language')); safe(r);
});

test('with/eval dynamic scopes cannot fabricate lexical call bindings', async () => {
  for (const body of ['with(obj) { run(); }','eval(code); run();']) {
    const r = await calls([file('src/main.js', `function run() {} function main(obj, code) { ${body} }`)]);
    assert.equal(r.relations.length,0,body); safe(r);
  }
});

test('existing JS/TS global and member descriptors remain byte-identical after native call extraction', async () => {
  const { extractSymbolsForFile } = await import('../src/extractors/tree-sitter/extract.mjs');
  for (const ext of ['js','ts']) {
    const input = { filePath: `src/parity.${ext}`, content: 'export function run(x) { return x; }\nexport class A { m() { return run(1); } }' };
    const before = await extractSymbolsForFile(input);
    const r = await calls([file(input.filePath,input.content)]); safe(r);
    assert.deepEqual(await extractSymbolsForFile(input),before);
    assert.ok(r.symbols.every(s=>before.some(b=>b.symbolKey===s.symbolKey)));
  }
});

test('layered-app static declaration chain and free-function alias call resolve exact canonical keys', async () => {
  const paths = ['src/cli/main.ts','src/controllers/user.controller.ts','src/services/user.service.ts','src/repositories/user.repository.ts','src/utils/format.ts','src/models/user.model.ts','src/interfaces/user-repository.ts','src/db/client.ts'];
  const files = await Promise.all(paths.map(async path => file(path,await readFile(new URL(`./fixtures/layered-app/${path}`,import.meta.url),'utf8'))));
  const r = await calls(files); const pairs=edges(r);
  for (const pair of [
    [key(paths[0],'function','exported','main'),key(paths[1],'method','member','UserController.getUser',1)],
    [key(paths[1],'method','member','UserController.getUser',1),key(paths[2],'method','member','UserService.findById',1)],
    [key(paths[2],'method','member','UserService.findById',1),key(paths[3],'method','member','UserRepository.findOne',1)],
    [key(paths[2],'method','member','UserService.findById',1),key(paths[4],'function','exported','formatName',1)],
  ]) assert.ok(pairs.some(p=>JSON.stringify(p)===JSON.stringify(pair)),JSON.stringify(pair));
  safe(r);
});
