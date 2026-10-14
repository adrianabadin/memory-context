import test from 'node:test';
import assert from 'node:assert/strict';
import { Parser, Tree } from 'web-tree-sitter';
import { analyzeTrivialSymbol } from '../src/cards/trivial-template.mjs';
import { initParser } from '../src/extractors/tree-sitter/runtime.mjs';

const cases = [
  ['B1 genuine Python getter', 'py',
    '@property\ndef value(self):\n    if self.x:\n        return 1\n    return 2', true],
  ['B1 Python setter', 'py',
    '@value.setter\ndef value(self,x):\n    if x:\n        self.x=x\n    return None', false],
  ['B2 C# plain member access', 'csharp',
    'public object Value() { return service.Value; }', true],
  ['B3 C# set-only indexer', 'csharp',
    'public int this[int i] {\nset {\nif(i<0)return;\nvalues[i]=value;\n}\n}', false],
];

function symbol(language, code) {
  return {
    language,
    kind: 'method',
    name: 'value',
    filePath: language === 'py' ? 'src/a.py' : 'src/A.cs',
    range: { startLine: 1, endLine: code.split('\n').length },
  };
}

for (const [label, language, code, expected] of cases) {
  test('S10 direct preservation: ' + label, async () => {
    const result = await analyzeTrivialSymbol({
      symbol: symbol(language, code),
      source: code,
    });
    assert.equal(result.trivial, expected);
  });
}

test('S10 B4 wrapped getter deletes every owned tree and parser once', async () => {
  const shared = await initParser();
  const language = shared.language;
  const parse = Parser.prototype.parse;
  const parserDelete = Parser.prototype.delete;
  const treeDelete = Tree.prototype.delete;
  const trees = new Set();
  const deleted = new Set();
  let parserDeletes = 0;

  Parser.prototype.parse = function (...args) {
    assert.notEqual(this, shared);
    const tree = parse.apply(this, args);
    if (tree) trees.add(tree);
    return tree;
  };
  Parser.prototype.delete = function () {
    assert.notEqual(this, shared);
    parserDeletes++;
    return parserDelete.call(this);
  };
  Tree.prototype.delete = function () {
    assert.ok(!deleted.has(this), 'tree must not be deleted twice');
    deleted.add(this);
    return treeDelete.call(this);
  };

  try {
    const code = 'get value(){ return this.x; }';
    const result = await analyzeTrivialSymbol({
      symbol: symbol('js', code),
      source: code,
    });
    assert.equal(result.trivial, true);
    assert.equal(parserDeletes, 1);
    assert.ok(trees.size > 0);
    assert.deepEqual(deleted, trees);
    assert.equal(shared.language, language);
  } finally {
    Parser.prototype.parse = parse;
    Parser.prototype.delete = parserDelete;
    Tree.prototype.delete = treeDelete;
  }
});
