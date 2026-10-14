/**
 * F3 N4 (accepted plan 3.4 / spec S10) — trivial-symbol structural analysis and
 * deterministic template narratives.
 *
 * analyzeTrivialSymbol proves triviality from structure only: the trusted
 * structured getter kind, an actual getter AST form, or a declared range of
 * 1..TRIVIAL_MAX_LINES physical code lines whose parsed syntax contains no
 * branching construct (if/switch/match/loops/try/catch/ternary/short-circuit
 * operators). Names are never heuristics: a method named `getFoo` is not a
 * getter, and template summaries never interpolate symbol names. Comments and
 * string literals never fabricate branches because detection walks the real
 * Tree-sitter AST. Unsupported grammars, syntax errors, unreadable sources and
 * invalid ranges fall back conservatively (not trivial → standard flow).
 * buildTrivialNarrative emits the deterministic N1-schema template whose
 * empty sideEffects/errors/contracts and mentions mean "uninferred", never
 * "proved absent", and whose mentions never leave the caller's authoritative
 * known-key set. Analysis parses with its own owned Parser instance and never
 * mutates or deletes the shared runtime singleton.
 */

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  TRIVIAL_MAX_LINES,
  analyzeTrivialSymbol,
  buildTrivialNarrative,
  tryBuildTrivialNarrative,
} from '../src/cards/trivial-template.mjs';
import { validateNarrative } from '../src/cards/narrative-schema.mjs';

const ownedFixtureRoots = new Set();

afterEach(async () => {
  const failures = [];
  for (const root of ownedFixtureRoots) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  ownedFixtureRoots.clear();
  if (failures.length) throw new AggregateError(failures, 'owned fixture cleanup failed');
});

async function withProject(files, fn) {
  const root = await mkdtemp(join(tmpdir(), 'pmc-trivial-'));
  ownedFixtureRoots.add(root);
  for (const [relPath, content] of Object.entries(files)) {
    await mkdir(join(root, dirname(relPath)), { recursive: true });
    await writeFile(join(root, relPath), content, 'utf8');
  }
  return fn(root);
}

function makeSymbol(overrides = {}) {
  return {
    symbolKey: 'js|src/a.js|function|exported|a|0',
    name: 'a',
    kind: 'function',
    language: 'js',
    filePath: 'src/a.js',
    range: { startLine: 1, endLine: 3 },
    ...overrides,
  };
}

// -------------------------------------------------------------------
// Getter proof: trusted structured kind or actual getter AST, never names
// -------------------------------------------------------------------

test('a trusted structured getter kind proves triviality without parsing, even when the body branches', () => withProject({
  'src/a.ts': [
    'export class User {',
    '  get displayName() {',
    '    if (this.raw) { return this.raw; }',
    '    return "";',
    '  }',
    '}',
    '',
  ].join('\n'),
}, async (root) => {
  const result = await analyzeTrivialSymbol({
    symbol: makeSymbol({
      kind: 'getter',
      name: 'getDisplayName',
      language: 'ts',
      filePath: 'src/a.ts',
      range: { startLine: 2, endLine: 6 },
    }),
    projectRoot: root,
  });

  assert.equal(result.trivial, true);
  assert.equal(result.proof.kind, 'getter');
  assert.equal(result.proof.detection, 'structured-kind');
  assert.equal(result.proof.branchTypes, null, 'a structured-kind proof never claims a branch scan happened');
}));

test('actual JS getter syntax is proven from the AST; a getFoo-named branching method never is', () => withProject({
  'src/a.js': [
    'export class User {',
    '  get name() {',
    '    return this._name;',
    '  }',
    '  getFoo() {',
    '    if (this._flag) { return this._name; }',
    '    return "fallback";',
    '  }',
    '}',
    '',
  ].join('\n'),
}, async (root) => {
  const getter = await analyzeTrivialSymbol({
    symbol: makeSymbol({ kind: 'method', range: { startLine: 2, endLine: 4 } }),
    projectRoot: root,
  });
  assert.equal(getter.trivial, true, 'getter syntax inside the declared range proves a getter');
  assert.equal(getter.proof.kind, 'getter');
  assert.equal(getter.proof.detection, 'ast');

  const method = await analyzeTrivialSymbol({
    symbol: makeSymbol({ kind: 'method', name: 'getFoo', range: { startLine: 5, endLine: 8 } }),
    projectRoot: root,
  });
  assert.equal(method.trivial, false, 'a method whose name starts with get must not prove getter triviality');
  assert.equal(method.reason, 'branching');
  assert.ok(method.branchTypes.includes('if_statement'), JSON.stringify(method.branchTypes));
}));

test('Python @property is a getter while an @x.setter body stays branch-analyzed', () => withProject({
  'src/u.py': [
    'class User:',
    '    @property',
    '    def name(self):',
    '        return self._name',
    '',
    '    @name.setter',
    '    def name(self, value):',
    '        if value is None:',
    '            raise ValueError("cannot be None")',
    '        self._name = value',
    '',
  ].join('\n'),
}, async (root) => {
  const getter = await analyzeTrivialSymbol({
    symbol: makeSymbol({
      kind: 'function',
      language: 'py',
      filePath: 'src/u.py',
      symbolKey: 'py|src/u.py|function|member|User.name|1',
      range: { startLine: 2, endLine: 4 },
    }),
    projectRoot: root,
  });
  assert.equal(getter.trivial, true);
  assert.equal(getter.proof.kind, 'getter');
  assert.equal(getter.proof.detection, 'ast');

  const setter = await analyzeTrivialSymbol({
    symbol: makeSymbol({
      kind: 'function',
      language: 'py',
      filePath: 'src/u.py',
      range: { startLine: 6, endLine: 10 },
    }),
    projectRoot: root,
  });
  assert.equal(setter.trivial, false, 'a setter is not a getter and its branch blocks the ordinary path too');
  assert.equal(setter.reason, 'branching');
  assert.ok(setter.branchTypes.includes('if_statement'), JSON.stringify(setter.branchTypes));
}));

test('C# get accessors, expression-bodied properties and indexer getters are getters; PascalCase methods and set-only indexers are not', () => withProject({
  'src/User.cs': [
    'public class User',
    '{',
    '    public string Name { get; set; }',
    '    public string Code => _code;',
    '    public string GetThing(int id)',
    '    {',
    '        if (id < 0) { return null; }',
    '        return _repo.Find(id);',
    '    }',
    '    public int this[int i] { set { _values[i] = value; } }',
    '    public object Plain() { return service.Value; }',
    '}',
    '',
  ].join('\n'),
}, async (root) => {
  const accessor = await analyzeTrivialSymbol({
    symbol: makeSymbol({ kind: 'property', language: 'csharp', filePath: 'src/User.cs', range: { startLine: 3, endLine: 3 } }),
    projectRoot: root,
  });
  assert.equal(accessor.trivial, true);
  assert.equal(accessor.proof.kind, 'getter');
  assert.equal(accessor.proof.detection, 'ast');

  const expressionBodied = await analyzeTrivialSymbol({
    symbol: makeSymbol({ kind: 'property', language: 'csharp', filePath: 'src/User.cs', range: { startLine: 4, endLine: 4 } }),
    projectRoot: root,
  });
  assert.equal(expressionBodied.trivial, true);
  assert.equal(expressionBodied.proof.kind, 'getter');

  const method = await analyzeTrivialSymbol({
    symbol: makeSymbol({ kind: 'method', language: 'csharp', filePath: 'src/User.cs', range: { startLine: 5, endLine: 9 } }),
    projectRoot: root,
  });
  assert.equal(method.trivial, false);
  assert.equal(method.reason, 'branching');
  assert.ok(method.branchTypes.includes('if_statement'), JSON.stringify(method.branchTypes));

  const setOnlyIndexer = await analyzeTrivialSymbol({
    symbol: makeSymbol({ kind: 'property', language: 'csharp', filePath: 'src/User.cs', range: { startLine: 10, endLine: 10 } }),
    projectRoot: root,
  });
  assert.equal(setOnlyIndexer.trivial, true, 'a set-only indexer is not a getter but may still be branch-free');
  assert.equal(setOnlyIndexer.proof.kind, 'branch-free', 'set-only accessors must never claim getter proof');

  const plainMemberAccess = await analyzeTrivialSymbol({
    symbol: makeSymbol({ kind: 'method', language: 'csharp', filePath: 'src/User.cs', range: { startLine: 11, endLine: 11 } }),
    projectRoot: root,
  });
  assert.equal(plainMemberAccess.trivial, true, 'normal member access is not branching');
  assert.deepEqual(plainMemberAccess.proof.branchTypes, []);
}));

// -------------------------------------------------------------------
// Physical line boundary: 1..4 lines, exactly
// -------------------------------------------------------------------

test('branch-free triviality flips exactly between four and five declared physical lines', () => withProject({
  'src/four.js': [
    'export function four(a) {',
    '  const doubled = a * 2;',
    '  return doubled;',
    '}',
    '',
  ].join('\n'),
  'src/five.js': [
    'export function five(a) {',
    '  const doubled = a * 2;',
    '  const negated = -doubled;',
    '  return negated;',
    '}',
    '',
  ].join('\n'),
}, async (root) => {
  const four = await analyzeTrivialSymbol({
    symbol: makeSymbol({ filePath: 'src/four.js', range: { startLine: 1, endLine: TRIVIAL_MAX_LINES } }),
    projectRoot: root,
  });
  assert.equal(four.trivial, true);
  assert.equal(four.proof.kind, 'branch-free');
  assert.equal(four.proof.lineCount, 4);
  assert.deepEqual(four.proof.branchTypes, []);

  const five = await analyzeTrivialSymbol({
    symbol: makeSymbol({ filePath: 'src/five.js', range: { startLine: 1, endLine: 5 } }),
    projectRoot: root,
  });
  assert.equal(five.trivial, false, 'a five-line symbol is never trivial');
  assert.equal(five.reason, 'line-count');
  assert.equal(five.lineCount, 5);
}));

// -------------------------------------------------------------------
// Branch vocabulary (verified node types per shipped grammar)
// -------------------------------------------------------------------

test('every supported JS/TS branch construct blocks the branch-free proof', async () => {
  const cases = [
    { label: 'if', code: 'function a() {\n  if (ready) { return 1; }\n  return 2;\n}\n', expect: 'if_statement' },
    { label: 'switch', code: 'function a() {\n  switch (mode) { case 1: break; default: break; }\n}\n', expect: 'switch_statement' },
    { label: 'ternary', code: 'function a() {\n  return ready ? 1 : 2;\n}\n', expect: 'ternary_expression' },
    { label: 'loop', code: 'function a() {\n  for (const item of items) { take(item); }\n}\n', expect: 'for_in_statement' },
    { label: 'while', code: 'function a() {\n  while (ready) { tick(); }\n}\n', expect: 'while_statement' },
    { label: 'catch', code: 'function a() {\n  try { run(); } catch (error) { fail(error); }\n}\n', expect: 'catch_clause' },
    { label: 'logical-and', code: 'function a() {\n  return ready && check();\n}\n', expect: 'binary_expression:&&' },
    { label: 'nullish', code: 'function a() {\n  return config ?? defaults;\n}\n', expect: 'binary_expression:??' },
    { label: 'optional-chain', code: 'function a() {\n  return service?.run();\n}\n', expect: 'optional_chain' },
    { label: 'compound-logical-assignment', code: 'function a() {\n  enabled ||= true;\n}\n', expect: 'augmented_assignment_expression:||=' },
  ];

  for (const { label, code, expect } of cases) {
    await withProject({ 'src/a.js': code }, async (root) => {
      const result = await analyzeTrivialSymbol({
        symbol: makeSymbol({ range: { startLine: 1, endLine: code.split('\n').length - 1 } }),
        projectRoot: root,
      });
      assert.equal(result.trivial, false, `${label} must block the branch-free proof`);
      assert.equal(result.reason, 'branching', label);
      assert.ok(result.branchTypes.includes(expect), `${label} recorded ${JSON.stringify(result.branchTypes)}`);
    });
  }
});

test('Python and C# branch constructs block the proof with their own grammar node types', async () => {
  const cases = [
    {
      label: 'python-match',
      language: 'py',
      filePath: 'src/a.py',
      code: 'def a(x):\n    match x:\n        case 1:\n            return 1\n',
      expect: 'match_statement',
    },
    {
      label: 'python-boolean',
      language: 'py',
      filePath: 'src/a.py',
      code: 'def a(x):\n    return x and x.ok\n',
      expect: 'boolean_operator',
    },
    {
      label: 'python-comprehension',
      language: 'py',
      filePath: 'src/a.py',
      code: 'def a(xs):\n    return [x for x in xs]\n',
      expect: 'list_comprehension',
    },
    {
      label: 'csharp-if',
      language: 'csharp',
      filePath: 'src/A.cs',
      code: 'public void Run(int id)\n{\n    if (id < 0) { return; }\n}\n',
      expect: 'if_statement',
    },
    {
      label: 'csharp-switch-expression',
      language: 'csharp',
      filePath: 'src/A.cs',
      code: 'public int Run(object o)\n{\n    return o switch { _ => 1 };\n}\n',
      expect: 'switch_expression',
    },
    {
      label: 'csharp-null-coalescing-assign',
      language: 'csharp',
      filePath: 'src/A.cs',
      code: 'public void Run()\n{\n    _name ??= "default";\n}\n',
      expect: 'assignment_expression:??=',
    },
  ];

  for (const { label, language, filePath, code, expect } of cases) {
    await withProject({ [filePath]: code }, async (root) => {
      const result = await analyzeTrivialSymbol({
        symbol: makeSymbol({ language, filePath, range: { startLine: 1, endLine: code.split('\n').length - 1 } }),
        projectRoot: root,
      });
      assert.equal(result.trivial, false, `${label} must block the branch-free proof`);
      assert.equal(result.reason, 'branching', label);
      assert.ok(result.branchTypes.includes(expect), `${label} recorded ${JSON.stringify(result.branchTypes)}`);
    });
  }
});

// -------------------------------------------------------------------
// Comments and strings never fabricate branches
// -------------------------------------------------------------------

test('comment and string content never fabricates branches', () => withProject({
  'src/a.js': [
    'export function a() {',
    '  // if (ready) switch (mode) { case 1: }',
    "  const note = 'try { while (true) {} }';",
    '}',
    '',
  ].join('\n'),
}, async (root) => {
  const result = await analyzeTrivialSymbol({
    symbol: makeSymbol({ range: { startLine: 1, endLine: 4 } }),
    projectRoot: root,
  });
  assert.equal(result.trivial, true, `keywords inside comments and strings are not branches (${JSON.stringify(result)})`);
  assert.deepEqual(result.proof.branchTypes, []);
}));

// -------------------------------------------------------------------
// Conservative fallbacks: unsupported grammar, parse errors, missing or
// invalid source ranges never claim triviality
// -------------------------------------------------------------------

test('unsupported grammars, syntax errors, missing sources and invalid ranges fall back conservatively', async () => {
  await withProject({ 'src/a.go': 'package main\n\nfunc a() int {\n\treturn 1\n}\n' }, async (root) => {
    const result = await analyzeTrivialSymbol({
      symbol: makeSymbol({ language: 'go', filePath: 'src/a.go', range: { startLine: 3, endLine: 5 } }),
      projectRoot: root,
    });
    assert.deepEqual(result, { trivial: false, reason: 'unsupported-language' });
  });

  await withProject({ 'src/broken.js': 'export function a( {\n' }, async (root) => {
    const result = await analyzeTrivialSymbol({
      symbol: makeSymbol({ filePath: 'src/broken.js', range: { startLine: 1, endLine: 1 } }),
      projectRoot: root,
    });
    assert.equal(result.trivial, false);
    assert.equal(result.reason, 'parse-error');
  });

  await withProject({ 'src/a.js': 'export function a() {\n  return 1;\n}\n' }, async (root) => {
    const missing = await analyzeTrivialSymbol({
      symbol: makeSymbol({ filePath: 'src/missing.js', range: { startLine: 1, endLine: 1 } }),
      projectRoot: root,
    });
    assert.deepEqual(missing, { trivial: false, reason: 'source-unavailable' });

    const reversed = await analyzeTrivialSymbol({
      symbol: makeSymbol({ range: { startLine: 3, endLine: 1 } }),
      projectRoot: root,
    });
    assert.deepEqual(reversed, { trivial: false, reason: 'invalid-range' });

    const beyond = await analyzeTrivialSymbol({
      symbol: makeSymbol({ range: { startLine: 1, endLine: 9 } }),
      projectRoot: root,
    });
    assert.equal(beyond.trivial, false, 'a range beyond the file never pretends the missing lines are trivial');
    assert.equal(beyond.reason, 'invalid-range');
  });
});

// -------------------------------------------------------------------
// Owned-parser isolation (guards future N6 concurrency)
// -------------------------------------------------------------------

test('interleaved analyses of different languages stay isolated on owned parser instances', () => withProject({
  'src/a.js': 'export function a() {\n  return 1;\n}\n',
  'src/b.py': 'def b(x):\n    return x\n',
}, async (root) => {
  const [js, py, jsAgain] = await Promise.all([
    analyzeTrivialSymbol({ symbol: makeSymbol({ filePath: 'src/a.js', range: { startLine: 1, endLine: 3 } }), projectRoot: root }),
    analyzeTrivialSymbol({ symbol: makeSymbol({ language: 'py', filePath: 'src/b.py', range: { startLine: 1, endLine: 2 } }), projectRoot: root }),
    analyzeTrivialSymbol({ symbol: makeSymbol({ filePath: 'src/a.js', range: { startLine: 1, endLine: 3 } }), projectRoot: root }),
  ]);

  assert.equal(js.proof?.language, 'javascript');
  assert.equal(jsAgain.proof?.language, 'javascript');
  assert.equal(py.proof?.language, 'python');
  assert.deepEqual(js.proof.branchTypes, []);
  assert.deepEqual(py.proof.branchTypes, []);
}));

// -------------------------------------------------------------------
// Deterministic N1-schema template narrative
// -------------------------------------------------------------------

test('the template narrative is deterministic, N1-valid and invents no facts', () => {
  const symbolKey = 'js|src/a.js|function|exported|analyzeThing|0';
  const known = new Set([symbolKey]);
  const symbol = makeSymbol({ name: 'analyzeThing', symbolKey });
  const proof = { kind: 'branch-free', detection: 'ast', language: 'javascript', lineCount: 3, branchTypes: [] };

  const narrative = buildTrivialNarrative({ symbol, proof, knownKeys: known });
  assert.deepEqual(validateNarrative(narrative, { symbolKeys: known }), { valid: true, errors: [] });
  assert.deepEqual(buildTrivialNarrative({ symbol, proof, knownKeys: known }), narrative, 'templates are deterministic');

  assert.deepEqual(narrative.sideEffects, [], 'empty side effects mean uninferred, never proved absent');
  assert.deepEqual(narrative.errors, []);
  assert.deepEqual(narrative.contracts, []);
  assert.deepEqual(narrative.mentions, [symbolKey], 'the own canonical key is mentioned only because the known set contains it');
  assert.ok(!narrative.summary.includes('analyzeThing'), 'summaries never interpolate symbol names');
  assert.ok(
    !/no side effects|no side-effect|never throws|does not spawn/i.test([narrative.summary, narrative.changeNotes, ...narrative.behavior].join(' ')),
    'the template never claims absence of effects, errors or contracts',
  );

  const unknown = buildTrivialNarrative({ symbol, proof, knownKeys: new Set() });
  assert.deepEqual(unknown.mentions, [], 'mentions never leave the authoritative known-key set');
  assert.deepEqual(validateNarrative(unknown, { symbolKeys: new Set() }), { valid: true, errors: [] });

  const getterProof = { kind: 'getter', detection: 'ast', language: 'javascript', lineCount: 3, branchTypes: [] };
  const getter = buildTrivialNarrative({ symbol: makeSymbol({ kind: 'getter', name: 'analyzeThing', symbolKey }), proof: getterProof, knownKeys: known });
  assert.deepEqual(validateNarrative(getter, { symbolKeys: known }), { valid: true, errors: [] });
  assert.notEqual(getter.summary, narrative.summary, 'getter and branch-free templates are distinguishable');

  assert.throws(() => buildTrivialNarrative({ symbol, proof: { kind: 'branchy' }, knownKeys: known }), TypeError);
  assert.throws(() => buildTrivialNarrative({ symbol, proof, knownKeys: [symbolKey] }), TypeError);
});

test('tryBuildTrivialNarrative returns the validated template only for proven trivial symbols and never throws', () => withProject({
  'src/trivial.js': 'export function trivial(a, b) {\n  return a + b;\n}\n',
  'src/busy.js': 'export function busy(a) {\n  if (!a) { throw new TypeError("required"); }\n  return a;\n}\n',
}, async (root) => {
  const key = 'js|src/trivial.js|function|exported|trivial|2';
  const built = await tryBuildTrivialNarrative({
    symbol: makeSymbol({ name: 'trivial', symbolKey: key, filePath: 'src/trivial.js', range: { startLine: 1, endLine: 3 } }),
    projectRoot: root,
    knownKeys: new Set([key]),
  });
  assert.equal(built.proof.kind, 'branch-free');
  assert.deepEqual(built.narrative.mentions, [key]);
  assert.deepEqual(validateNarrative(built.narrative, { symbolKeys: new Set([key]) }), { valid: true, errors: [] });

  const busy = await tryBuildTrivialNarrative({
    symbol: makeSymbol({ name: 'busy', symbolKey: 'js|src/busy.js|function|exported|busy|1', filePath: 'src/busy.js', range: { startLine: 1, endLine: 4 } }),
    projectRoot: root,
    knownKeys: new Set(),
  });
  assert.equal(busy, null, 'non-trivial symbols never receive a template');

  assert.equal(
    await tryBuildTrivialNarrative({ symbol: null, projectRoot: root, knownKeys: new Set() }),
    null,
    'analysis failures resolve to null instead of throwing',
  );
}));
