import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { Parser, Tree } from 'web-tree-sitter';
import { buildSymbolKey } from '../src/symbol-keys.mjs';
import { initParser } from '../src/extractors/tree-sitter/runtime.mjs';
import { analyzeTrivialSymbol } from '../src/cards/trivial-template.mjs';
import { main } from '../cli/enrich-queue.mjs';

const cases = [
  {
    label: 'B1 decorator argument is not a Python getter',
    language: 'py', filePath: 'src/a.py', kind: 'function', name: 'value',
    code: '@decorate(property)\ndef value(self):\n    if self.x:\n        return 1\n    return 2',
    expected: false,
  },
  {
    label: 'B2 C# conditional access is branching',
    language: 'csharp', filePath: 'src/A.cs', kind: 'method', name: 'Value',
    code: 'public object Value() { return service?.Value; }',
    expected: false,
  },
  {
    label: 'B3 C# indexer get accessor qualifies regardless of length or branch',
    language: 'csharp', filePath: 'src/A.cs', kind: 'property', name: 'Item',
    code: 'public int this[int i] {\nget {\nif(i<0)return 0;\nreturn values[i];\n}\n}',
    expected: true,
  },
];

function symbolFor(input) {
  const symbol = {
    language: input.language, filePath: input.filePath,
    kind: input.kind, name: input.name,
    range: { startLine: 1, endLine: input.code.split('\n').length },
    status: 'pending', codeHash: 'fixture',
  };
  symbol.symbolKey = buildSymbolKey(symbol);
  return symbol;
}

async function fixture(input, fn) {
  const root = await mkdtemp(join(tmpdir(), 'n4-blocker-'));
  try {
    const dir = join(root, '.planning/project-memory-context/enrichment');
    const symbol = symbolFor(input);
    await mkdir(dir, { recursive: true });
    await mkdir(dirname(join(root, symbol.filePath)), { recursive: true });
    await writeFile(join(root, symbol.filePath), input.code);
    await writeFile(join(dir, 'worklist.json'), JSON.stringify([symbol]));
    await writeFile(join(dir, 'symbol-index.json'), '{}');
    return await fn(root, symbol);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withoutExternalEffects(fn) {
  const cp = createRequire(import.meta.url)('node:child_process');
  const spawn = cp.spawn;
  const fetch = globalThis.fetch;
  const log = console.log;
  const error = console.error;
  cp.spawn = () => { throw new Error('Denied subprocess'); };
  syncBuiltinESMExports();
  globalThis.fetch = () => { throw new Error('Denied network'); };
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    cp.spawn = spawn;
    syncBuiltinESMExports();
    globalThis.fetch = fetch;
    console.log = log;
    console.error = error;
  }
}

for (const input of cases) {
  test(`S10 ${input.label}: analysis`, async () => {
    const result = await analyzeTrivialSymbol({
      symbol: symbolFor(input), source: input.code,
    });
    assert.equal(result.trivial, input.expected, JSON.stringify(result));
  });

  test(`S10 ${input.label}: actual main`, () => fixture(input, async (root, symbol) => {
    const calls = { tokenizer: 0, provider: 0 };
    await withoutExternalEffects(() => main({
      projectRoot: root,
      config: {
        preferredModes: ['local-model'],
        localModel: { baseUrl: 'http://127.0.0.1:0', model: 'fake' },
        fileCoverageThreshold: 2,
        subagentTokenThreshold: 5000,
      },
      providers: [],
      narrativeResolver: () => ({ symbolKeys: [symbol.symbolKey] }),
      countPromptTokensImpl: async () => {
        calls.tokenizer++;
        return 1;
      },
      runEnrichmentWithFallbackImpl: async () => {
        calls.provider++;
        return {
          status: 'succeeded', mode: 'local-model', attempts: [],
          content: JSON.stringify({
            summary: 'Provider result.', behavior: [], sideEffects: [],
            errors: [], contracts: [], changeNotes: 'Check behavior.', mentions: [],
          }),
        };
      },
    }));
    const expected = input.expected ? 0 : 1;
    assert.deepEqual(calls, { tokenizer: expected, provider: expected });
  }));
}

test('S10 B4 successful analysis releases owned parser/tree without altering singleton', async () => {
  const shared = await initParser();
  const language = shared.language;
  const parserDelete = Parser.prototype.delete;
  const treeDelete = Tree.prototype.delete;
  const counts = { parser: 0, tree: 0 };
  Parser.prototype.delete = function () {
    assert.notEqual(this, shared);
    counts.parser++;
    return parserDelete.call(this);
  };
  Tree.prototype.delete = function () {
    counts.tree++;
    return treeDelete.call(this);
  };
  try {
    const input = {
      language: 'js', filePath: 'src/a.js', kind: 'function', name: 'a',
      code: 'function a(){return 1;}',
    };
    const result = await analyzeTrivialSymbol({
      symbol: symbolFor(input), source: input.code,
    });
    assert.equal(result.trivial, true);
    assert.equal(shared.language, language);
    assert.deepEqual(counts, { parser: 1, tree: 1 });
  } finally {
    Parser.prototype.delete = parserDelete;
    Tree.prototype.delete = treeDelete;
  }
});
