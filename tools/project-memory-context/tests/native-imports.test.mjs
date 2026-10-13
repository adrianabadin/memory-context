import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function extract(files) {
  const { extractNativeImports } = await import('../src/relations/native-imports.mjs');
  return extractNativeImports({ files });
}
const file = (path, content = '') => ({ path, content });
const endpoint = path => ({ id: `file|${path}`, kind: 'file', path });
const source = content => file('src/main.ts', content);
function unresolved(result, reason) {
  assert.equal(result.relations.length, 0);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].reason, reason);
  assert.equal(Object.hasOwn(result.unresolved[0], 'target'), false);
}

test('static named alias imports resolve unique inventory files, not raw target strings', async () => {
  const input = [source("import { run as execute, other } from './dep';"), file('src/dep.ts')];
  const before = JSON.stringify(input);
  const result = await extract(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.relations, [{
    relation: 'imports', source: endpoint('src/main.ts'), target: endpoint('src/dep.ts'),
    specifier: './dep', bindings: [
      { imported: 'run', local: 'execute', typeOnly: false },
      { imported: 'other', local: 'other', typeOnly: false },
    ], typeOnly: false, range: { startLine: 1, endLine: 1 },
  }]);
  assert.deepEqual(result.files, [endpoint('src/dep.ts'), endpoint('src/main.ts')]);
});

test('default, namespace and side-effect imports retain syntax without inventing symbol IDs', async () => {
  const result = await extract([source("import Def from './dep.js';\nimport * as ns from './dep.js';\nimport './dep.js';"), file('src/dep.js')]);
  assert.equal(result.relations.length, 3);
  assert.deepEqual(result.relations.map(e => e.bindings), [
    [{ imported: 'default', local: 'Def', typeOnly: false }],
    [{ imported: '*', local: 'ns', typeOnly: false }], [],
  ]);
  assert.deepEqual(result.relations.map(e => e.range.startLine), [1, 2, 3]);
  assert.ok(result.relations.every(e => e.target.id === 'file|src/dep.js'));
});

test('TypeScript type-only imports and mixed specifiers remain structural file imports', async () => {
  const result = await extract([source("import type { Thing as T } from './dep';\nimport { type Thing as Alias, run } from './dep';"), file('src/dep.ts')]);
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.relations[0].typeOnly, true);
  assert.deepEqual(result.relations[0].bindings, [{ imported: 'Thing', local: 'T', typeOnly: true }]);
  assert.equal(result.relations[1].typeOnly, false);
  assert.deepEqual(result.relations[1].bindings, [
    { imported: 'Thing', local: 'Alias', typeOnly: true },
    { imported: 'run', local: 'run', typeOnly: false },
  ]);
});

test('shipped JS, JSX, MJS and TSX grammars parse static imports', async () => {
  for (const ext of ['js', 'jsx', 'mjs', 'tsx']) {
    const result = await extract([file(`src/main.${ext}`, "import './dep.js';"), file('src/dep.js')]);
    assert.deepEqual(result.unresolved, []);
    assert.equal(result.relations.length, 1);
    assert.deepEqual(result.relations[0].source, endpoint(`src/main.${ext}`));
  }
});

test('normalized relative paths and unique index candidates resolve deterministically', async () => {
  const result = await extract([file('./src\\entry.ts', "import './dir';\nimport './x/../dep.ts';"), file('src/dir/index.ts'), file('src/dep.ts')]);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.relations.map(e => e.target.path), ['src/dir/index.ts', 'src/dep.ts']);
  assert.ok(result.relations.every(e => e.source.path === 'src/entry.ts'));
});

test('extension and index ambiguity never uses precedence or array order', async () => {
  const input = [source("import './dep';"), file('src/dep.ts'), file('src/dep.js'), file('src/dep/index.ts')];
  const a = await extract(input);
  unresolved(a, 'ambiguous-module');
  const b = await extract([...input].reverse());
  assert.deepEqual(a, b);
});

test('explicit supported extension selects only that exact inventory path', async () => {
  const result = await extract([source("import './dep.js';"), file('src/dep.js'), file('src/dep.ts'), file('src/dep.js/index.ts')]);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.relations[0].target, endpoint('src/dep.js'));
});

test('canonical path collisions withhold file identities and target edges', async () => {
  const input = [source("import './dep';"), file('./src/dep.ts'), file('src\\dep.ts')];
  const a = await extract(input);
  assert.equal(a.relations.length, 0);
  assert.deepEqual(a.files, [endpoint('src/main.ts')]);
  assert.deepEqual(a.unresolved.map(u => u.reason).sort(), ['file-collision', 'file-collision']);
  assert.ok(a.unresolved.every(u => !Object.hasOwn(u, 'target')));
  assert.deepEqual(a, await extract([...input].reverse()));
});

test('external, missing and root-escaping module specifiers stay unresolved', async () => {
  for (const [specifier, reason] of [['node:fs','external-module'],['@pkg/name','external-module'],['./missing','missing-module'],['../../outside','outside-project']]) {
    const result = await extract([source(`import '${specifier}';`)]);
    unresolved(result, reason);
    assert.equal(result.unresolved[0].specifier, specifier);
  }
});

test('escaped import specifiers do not resolve by guessed string decoding', async () => {
  const result = await extract([source(String.raw`import './de\u0070';`), file('src/dep.ts')]);
  unresolved(result, 'unsupported-specifier');
});

test('unsupported source languages and unsupported target files remain explicit, not raw-ID edges', async () => {
  unresolved(await extract([file('src/main.py', 'import dep')]), 'unsupported-language');
  const result = await extract([source("import './dep.json';"), file('src/dep.json', '{}')]);
  assert.equal(result.relations.length, 0);
  assert.ok(result.unresolved.some(u => u.source?.path === 'src/main.ts' && u.reason === 'unsupported-language'));
  assert.ok(result.unresolved.every(u => !Object.hasOwn(u, 'target')));
});

test('dynamic imports, CommonJS calls and reexports emit unresolved syntax, never a target', async () => {
  const result = await extract([source("const a=import('./dep');\nconst b=require('./dep');\nexport { run } from './dep';"), file('src/dep.ts')]);
  assert.equal(result.relations.length, 0);
  assert.deepEqual(result.unresolved.map(u => u.reason), ['dynamic-import', 'unsupported-commonjs', 'unsupported-reexport']);
  assert.ok(result.unresolved.every(u => !Object.hasOwn(u, 'target')));
});

test('parser-recovered invalid static imports fail closed', async () => {
  unresolved(await extract([source("import { run as } from './dep';"), file('src/dep.ts')]), 'invalid-syntax');
});

test('invalid inventories reject without input mutation or leaked parser state', async () => {
  for (const input of [null, {}, [file('../escape.ts')], [file('/root.ts')], [file('C:\\abs.ts')], [file('./C:\\abs.ts')], [file('a|b.ts')], [{ path:'ok.ts', content:4 }]]) {
    const before = JSON.stringify(input);
    await assert.rejects(extract(input), TypeError);
    assert.equal(JSON.stringify(input), before);
  }
  const empty = await extract([]);
  assert.deepEqual(empty, { files: [], relations: [], unresolved: [] });
});

test('shared grammar runtime still produces identical existing symbol descriptors after import extraction', async () => {
  const { extractSymbolsForFile } = await import('../src/extractors/tree-sitter/extract.mjs');
  const input = { filePath: 'src/legacy.ts', content: 'export function run(x: number) { return x; }' };
  const before = await extractSymbolsForFile(input);
  assert.equal(before[0].symbolKey, 'ts|src/legacy.ts|function|exported|run|1');
  await extract([file('other.js', "import './dep.js';"), file('dep.js')]);
  assert.deepEqual(await extractSymbolsForFile(input), before);
});

test('layered-app service imports resolve all three canonical file endpoints', async () => {
  const paths = ['src/services/user.service.ts', 'src/repositories/user.repository.ts', 'src/utils/format.ts', 'src/models/user.model.ts'];
  const files = await Promise.all(paths.map(async path => file(path, await readFile(new URL(`./fixtures/layered-app/${path}`, import.meta.url), 'utf8'))));
  const result = await extract(files);
  const service = result.relations.filter(e => e.source.path === paths[0]);
  assert.deepEqual(service.map(e => e.target.path), paths.slice(1));
  assert.ok(service.every(e => e.target.id === `file|${e.target.path}`));
  assert.ok(service.every(e => e.relation === 'imports'));
  // Partial inventory intentionally leaves repository imports outside it unresolved.
  assert.ok(result.unresolved.every(u => !Object.hasOwn(u, 'target')));
});
