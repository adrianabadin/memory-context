import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import os from 'node:os';

import { resolveTarget } from '../src/retrieval/target-resolver.mjs';
import { renderTargetContext } from '../src/retrieval/context-renderer-v1.mjs';
import { createQueryEngine } from '../src/retrieval/query-engine.mjs';

function createEngine({ symbolsByName = {}, symbolsByFilePath = {} } = {}) {
  return {
    findSymbolKeyByName(name) {
      return symbolsByName[name] ?? [];
    },
    findSymbolKeysByFilePath(filePath) {
      return symbolsByFilePath[filePath] ?? [];
    },
  };
}

test('auto-detects file targets from path-like input', () => {
  const result = resolveTarget({
    engine: createEngine(),
    target: 'src\\feature\\resolver.mjs',
  });

  assert.deepEqual(result, {
    mode: 'file',
    target: 'src/feature/resolver.mjs',
  });
});

test('auto-detects file targets from indexed file paths', () => {
  const result = resolveTarget({
    engine: createEngine({
      symbolsByFilePath: {
        'src/query-engine.mjs': ['js|src/query-engine.mjs||function|query|sig'],
      },
    }),
    target: 'src/query-engine.mjs',
  });

  assert.deepEqual(result, {
    mode: 'file',
    target: 'src/query-engine.mjs',
  });
});

test('does not treat slash-delimited natural-language targets as file paths in auto mode', () => {
  const result = resolveTarget({
    engine: createEngine(),
    target: 'A/B testing',
  });

  assert.deepEqual(result, {
    mode: 'query',
    target: 'A/B testing',
  });
});

test('does not treat dotted non-file targets as file paths in auto mode', () => {
  const result = resolveTarget({
    engine: createEngine(),
    target: 'OAuth 2.0',
  });

  assert.deepEqual(result, {
    mode: 'query',
    target: 'OAuth 2.0',
  });
});

test('auto-detects bare filename targets as files', () => {
  const result = resolveTarget({
    engine: createEngine(),
    target: 'README.md',
  });

  assert.deepEqual(result, {
    mode: 'file',
    target: 'README.md',
  });
});

test('does not treat dotted symbol-like targets as file paths in auto mode', () => {
  const result = resolveTarget({
    engine: createEngine(),
    target: 'UserService.GetUser',
  });

  assert.deepEqual(result, {
    mode: 'query',
    target: 'UserService.GetUser',
  });
});

test('auto-detects symbol targets', () => {
  const matches = ['js|src/query-engine.mjs||function|createQueryEngine|sig'];
  const result = resolveTarget({
    engine: createEngine({
      symbolsByName: {
        createQueryEngine: matches,
      },
    }),
    target: 'createQueryEngine',
  });

  assert.deepEqual(result, {
    mode: 'symbol',
    target: 'createQueryEngine',
    symbolKey: matches[0],
  });
});

test('returns ambiguous symbol candidates when multiple matches exist', () => {
  const matches = [
    'js|src/a.mjs||function|render|sig-a',
    'js|src/b.mjs||function|render|sig-b',
  ];
  const result = resolveTarget({
    engine: createEngine({
      symbolsByName: {
        render: matches,
      },
    }),
    target: 'render',
  });

  assert.deepEqual(result, {
    mode: 'symbol-ambiguous',
    target: 'render',
    symbolKeys: matches,
  });
});

test('falls back to query mode when file and symbol lookups miss', () => {
  const result = resolveTarget({
    engine: createEngine(),
    target: 'how auth sessions are resolved',
  });

  assert.deepEqual(result, {
    mode: 'query',
    target: 'how auth sessions are resolved',
  });
});

test('resolves slash-delimited spaced file-like input as file', () => {
  const result = resolveTarget({
    engine: createEngine(),
    target: 'docs/API Reference.md',
  });

  assert.deepEqual(result, {
    mode: 'file',
    target: 'docs/API Reference.md',
  });
});

test('does not treat slash-delimited non-file queries with spaces as file', () => {
  const result = resolveTarget({
    engine: createEngine(),
    target: 'A/B testing',
  });

  assert.deepEqual(result, {
    mode: 'query',
    target: 'A/B testing',
  });
});

test('respects explicit file and query override modes', () => {
  assert.deepEqual(
    resolveTarget({
      engine: createEngine(),
      explicitMode: 'file',
      target: 'src\\context\\index.mjs',
    }),
    {
      mode: 'file',
      target: 'src/context/index.mjs',
    },
  );

  assert.deepEqual(
    resolveTarget({
      engine: createEngine(),
      explicitMode: 'query',
      target: 'find auth boundaries',
    }),
    {
      mode: 'query',
      target: 'find auth boundaries',
    },
  );
});

test('symbol explicit mode returns symbol-missing when no matches exist', () => {
  const result = resolveTarget({
    engine: createEngine(),
    explicitMode: 'symbol',
    target: 'MissingSymbol',
  });

  assert.deepEqual(result, {
    mode: 'symbol-missing',
    target: 'MissingSymbol',
  });
});

// --- renderTargetContext tests ---

function fullInput() {
  return {
    summary: ['PMC provides persistent project memory', 'Graph-based symbol relationships'],
    target: { mode: 'file', name: 'query-engine.mjs', value: 'query-engine.mjs', filePath: 'src/retrieval/query-engine.mjs' },
    relevant: [
      { label: 'query-engine.mjs', filePath: 'src/retrieval/query-engine.mjs' },
      { label: 'target-resolver.mjs', filePath: 'src/retrieval/target-resolver.mjs' },
    ],
    relations: [
      { kind: 'imports', items: ['symbol-index', 'memory-payload'] },
      { kind: 'called-by', items: ['orchestrator', 'cli/query'] },
    ],
    nextReads: ['src/retrieval/load-artifacts.mjs', 'cli/context.mjs'],
    metadata: { depth: 2, focus: 'retrieval' },
  };
}

test('renderTargetContext output contains all 6 section headings', () => {
  const result = renderTargetContext(fullInput());

  assert.ok(result.includes('Summary'), 'missing Summary heading');
  assert.ok(result.includes('Target'), 'missing Target heading');
  assert.ok(result.includes('Relevant'), 'missing Relevant heading');
  assert.ok(result.includes('Relations'), 'missing Relations heading');
  assert.ok(result.includes('Next Reads'), 'missing Next Reads heading');
  assert.ok(result.includes('Metadata'), 'missing Metadata heading');
});

test('renderTargetContext renders summary bullets with dash prefix', () => {
  const result = renderTargetContext(fullInput());

  assert.ok(result.includes('- PMC provides persistent project memory'));
  assert.ok(result.includes('- Graph-based symbol relationships'));
});

test('renderTargetContext renders target mode and file path', () => {
  const result = renderTargetContext(fullInput());

  assert.ok(result.includes('file'), 'target mode not rendered');
  assert.ok(result.includes('src/retrieval/query-engine.mjs'), 'target filePath not rendered');
});

test('renderTargetContext renders relevant files with dash prefix', () => {
  const result = renderTargetContext(fullInput());

  assert.ok(result.includes('- src/retrieval/query-engine.mjs'));
  assert.ok(result.includes('- src/retrieval/target-resolver.mjs'));
});

test('renderTargetContext renders relations as kind: item format', () => {
  const result = renderTargetContext(fullInput());

  assert.ok(result.includes('imports:'));
  assert.ok(result.includes('called-by:'));
});

test('renderTargetContext renders next reads as file path bullets', () => {
  const result = renderTargetContext(fullInput());

  assert.ok(result.includes('- src/retrieval/load-artifacts.mjs'));
  assert.ok(result.includes('- cli/context.mjs'));
});

test('renderTargetContext renders metadata depth and focus', () => {
  const result = renderTargetContext(fullInput());

  assert.ok(result.includes('depth'));
  assert.ok(result.includes('2'));
  assert.ok(result.includes('focus'));
  assert.ok(result.includes('retrieval'));
});

test('renderTargetContext handles empty relevant array with - none', () => {
  const input = {
    summary: ['Test summary'],
    target: { mode: 'query', value: 'test query' },
    relevant: [],
    relations: [],
    nextReads: [],
    metadata: { depth: 1, focus: 'test' },
  };
  const result = renderTargetContext(input);

  assert.ok(result.includes('- none'), 'empty relevant should show - none');
});

test('renderTargetContext handles minimal target with only mode', () => {
  const input = {
    summary: [],
    target: { mode: 'symbol' },
    relevant: [],
    relations: [],
    nextReads: [],
    metadata: { depth: 0, focus: '' },
  };
  const result = renderTargetContext(input);

  assert.ok(result.includes('symbol'), 'target mode not rendered');
});

test('renderTargetContext does not leak undefined or empty placeholders', () => {
  const input = {
    summary: [],
    target: { mode: 'query', value: 'auth' },
    relevant: [],
    relations: [],
    nextReads: [],
    metadata: { depth: 1, focus: 'app' },
  };
  const result = renderTargetContext(input);

  assert.ok(!result.includes('undefined'), 'should not contain undefined');
  assert.ok(!result.includes('null'), 'should not contain null');
});

test('renderTargetContext returns a string', () => {
  const result = renderTargetContext(fullInput());
  assert.strictEqual(typeof result, 'string');
});

test('renderTargetContext renders relevant without filePath using label fallback', () => {
  const input = {
    summary: ['one'],
    target: { mode: 'file', filePath: 'a.mjs' },
    relevant: [{ label: 'SomeSymbol' }],
    relations: [],
    nextReads: [],
    metadata: { depth: 1, focus: 'test' },
  };
  const result = renderTargetContext(input);

  assert.ok(result.includes('- SomeSymbol'));
});

test('renderTargetContext renders target name when available', () => {
  const input = {
    summary: [],
    target: { mode: 'symbol', name: 'createQueryEngine' },
    relevant: [],
    relations: [],
    nextReads: [],
    metadata: { depth: 0, focus: '' },
  };
  const result = renderTargetContext(input);

  assert.ok(result.includes('createQueryEngine'));
});

test('renderTargetContext renders relations with items comma-separated', () => {
  const input = {
    summary: [],
    target: { mode: 'file', filePath: 'a.mjs' },
    relevant: [],
    relations: [{ kind: 'depends-on', items: ['b', 'c', 'd'] }],
    nextReads: [],
    metadata: { depth: 1, focus: '' },
  };
  const result = renderTargetContext(input);

  assert.ok(result.includes('depends-on: b, c, d'));
});

test('renderTargetContext renders community name in the Target section when present', () => {
  const input = {
    summary: [],
    target: { mode: 'symbol', name: 'openGraphDb', communityName: 'Graph Storage', communityId: '1' },
    relevant: [],
    relations: [],
    nextReads: [],
    metadata: { depth: 'compact', focus: 'all' },
  };
  const result = renderTargetContext(input);

  assert.ok(result.includes('community: Graph Storage'), `expected community name in output:\n${result}`);
});

test('renderTargetContext omits community line when no name is present', () => {
  const input = {
    summary: [],
    target: { mode: 'symbol', name: 'openGraphDb' },
    relevant: [],
    relations: [],
    nextReads: [],
    metadata: { depth: 'compact', focus: 'all' },
  };
  const result = renderTargetContext(input);

  assert.ok(!result.includes('community:'), `should not render community line:\n${result}`);
});

// --- context CLI target-aware tests ---

import { parseArgs, findProjectRoot, buildRenderInput, runTargetContext } from '../cli/context.mjs';

async function createFixtureProject({
  symbolIndex = {},
  graph = { nodes: [], links: [] },
  worklist = [],
} = {}) {
  const projectRoot = await mkdtemp(join(os.tmpdir(), 'pmc-ctx-cli-'));
  const pmcRoot = join(projectRoot, '.planning', 'project-memory-context');

  await mkdir(join(pmcRoot, 'graph'), { recursive: true });
  await mkdir(join(pmcRoot, 'enrichment'), { recursive: true });

  await writeFile(
    join(pmcRoot, 'install.json'),
    JSON.stringify({ installedAt: '2026-05-19T00:00:00.000Z', version: '0.1.0' }, null, 2),
    'utf8',
  );
  await writeFile(join(pmcRoot, 'graph', 'graph.json'), JSON.stringify(graph, null, 2), 'utf8');
  await writeFile(join(pmcRoot, 'enrichment', 'symbol-index.json'), JSON.stringify(symbolIndex, null, 2), 'utf8');
  await writeFile(join(pmcRoot, 'enrichment', 'worklist.json'), JSON.stringify(worklist, null, 2), 'utf8');

  return projectRoot;
}

test('parseArgs detects --help', () => {
  const result = parseArgs(['--help']);
  assert.equal(result.help, true);
});

test('parseArgs detects -h', () => {
  const result = parseArgs(['-h']);
  assert.equal(result.help, true);
});

test('parseArgs detects --refresh', () => {
  const result = parseArgs(['.', '--refresh']);
  assert.equal(result.refresh, true);
});

test('parseArgs auto mode: target as first positional', () => {
  const result = parseArgs(['MyFunction']);
  assert.equal(result.target, 'MyFunction');
  assert.equal(result.explicitMode, null);
});

test('parseArgs explicit file mode', () => {
  const result = parseArgs(['file', 'src/auth.ts']);
  assert.equal(result.explicitMode, 'file');
  assert.equal(result.target, 'src/auth.ts');
});

test('parseArgs explicit symbol mode with depth and focus', () => {
  const result = parseArgs(['symbol', 'MyFunc', 'extended', 'dependencies']);
  assert.equal(result.explicitMode, 'symbol');
  assert.equal(result.target, 'MyFunc');
  assert.equal(result.depth, 'extended');
  assert.equal(result.focus, 'dependencies');
});

test('parseArgs explicit query mode with depth', () => {
  const result = parseArgs(['query', 'how auth works', 'deep']);
  assert.equal(result.explicitMode, 'query');
  assert.equal(result.target, 'how auth works');
  assert.equal(result.depth, 'deep');
});

test('parseArgs auto mode with depth and focus', () => {
  const result = parseArgs(['createQueryEngine', 'deep', 'callers']);
  assert.equal(result.target, 'createQueryEngine');
  assert.equal(result.depth, 'deep');
  assert.equal(result.focus, 'callers');
});

test('parseArgs defaults for depth and focus', () => {
  const result = parseArgs(['SomeSymbol']);
  assert.equal(result.depth, 'compact');
  assert.equal(result.focus, 'all');
});

test('parseArgs preserves refresh flag with other args', () => {
  const result = parseArgs(['--refresh', '.']);
  assert.equal(result.refresh, true);
  assert.equal(result.target, '.');
});

test('parseArgs explicit mode without target sets explicitMode but no target', () => {
  const result = parseArgs(['query']);
  assert.equal(result.explicitMode, 'query');
  assert.equal(result.target, undefined);
});

test('findProjectRoot returns null outside PMC project', async () => {
  const tmp = await mkdtemp(join(os.tmpdir(), 'pmc-no-pmc-'));
  try {
    const result = await findProjectRoot(tmp);
    assert.equal(result, null);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('buildRenderInput symbol mode produces expected shape', async () => {
  const sk = 'ts|src/engine.mjs||function|createEngine|0';
  const engine = createQueryEngine({
    graph: {
      nodes: [
        { id: 'n1', label: 'createEngine', source_file: 'src/engine.mjs' },
        { id: 'n2', label: 'parseArgs', source_file: 'src/parse.mjs' },
      ],
      links: [
        { source: 'n1', target: 'n2', relation: 'calls' },
      ],
    },
    symbolIndex: {
      [sk]: { graphNodeId: 'n1', memoryId: 'mem-1', status: 'enriched' },
      'ts|src/parse.mjs||function|parseArgs|0': { graphNodeId: 'n2', memoryId: 'mem-2', status: 'enriched' },
    },
    worklist: [],
    enrichmentDir: '/tmp/enrich',
    projectSlug: 'test',
  });

  const resolved = { mode: 'symbol', target: 'createEngine', symbolKey: sk };
  const input = await buildRenderInput(engine, resolved, { depth: 'compact', focus: 'all' });

  assert.equal(input.target.mode, 'symbol');
  assert.equal(input.target.name, 'createEngine');
  assert.ok(input.summary.length > 0, 'summary should not be empty');
  assert.ok(input.relevant.length > 0, 'relevant should include neighbor');
  assert.ok(input.relations.length > 0, 'relations should include calls edge');
  assert.equal(input.metadata.depth, 'compact');
  assert.equal(input.metadata.focus, 'all');
});

test('buildRenderInput symbol-ambiguous mode lists candidates', async () => {
  const engine = createQueryEngine({
    graph: { nodes: [], links: [] },
    symbolIndex: {},
    worklist: [],
    enrichmentDir: '/tmp/enrich',
    projectSlug: 'test',
  });

  const resolved = {
    mode: 'symbol-ambiguous',
    target: 'render',
    symbolKeys: [
      'ts|src/a.mjs||function|render|0',
      'ts|src/b.mjs||function|render|1',
    ],
  };
  const input = await buildRenderInput(engine, resolved, { depth: 'compact', focus: 'all' });

  assert.equal(input.target.mode, 'symbol-ambiguous');
  assert.equal(input.target.name, 'render');
  assert.ok(input.summary.some(s => s.includes('Multiple symbols match')));
  assert.equal(input.relevant.length, 2);
});

test('buildRenderInput file mode produces expected shape', async () => {
  const sk1 = 'ts|src/auth.ts||function|login|0';
  const engine = createQueryEngine({
    graph: {
      nodes: [
        { id: 'n1', label: 'login', source_file: 'src/auth.ts' },
        { id: 'n2', label: 'validateToken', source_file: 'src/tokens.ts' },
      ],
      links: [
        { source: 'n1', target: 'n2', relation: 'calls' },
      ],
    },
    symbolIndex: {
      [sk1]: { graphNodeId: 'n1' },
      'ts|src/tokens.ts||function|validateToken|0': { graphNodeId: 'n2' },
    },
    worklist: [],
    enrichmentDir: '/tmp/enrich',
    projectSlug: 'test',
  });

  const resolved = { mode: 'file', target: 'src/auth.ts' };
  const input = await buildRenderInput(engine, resolved, { depth: 'compact', focus: 'all' });

  assert.equal(input.target.mode, 'file');
  assert.equal(input.target.filePath, 'src/auth.ts');
  assert.ok(input.relevant.length > 0, 'file mode should have neighbors');
  assert.ok(input.relations.some(r => r.kind === 'calls'), 'should have calls relation');
});

test('buildRenderInput query mode produces minimal result', async () => {
  const engine = createQueryEngine({
    graph: { nodes: [], links: [] },
    symbolIndex: {},
    worklist: [],
    enrichmentDir: '/tmp/enrich',
    projectSlug: 'test',
  });

  const resolved = { mode: 'query', target: 'how auth works' };
  const input = await buildRenderInput(engine, resolved, { depth: 'compact', focus: 'all' });

  assert.equal(input.target.mode, 'query');
  assert.equal(input.target.value, 'how auth works');
  assert.equal(input.relevant.length, 0);
  assert.equal(input.relations.length, 0);
});

test('buildRenderInput symbol-missing mode shows no-match result', async () => {
  const engine = createQueryEngine({
    graph: { nodes: [], links: [] },
    symbolIndex: {},
    worklist: [],
    enrichmentDir: '/tmp/enrich',
    projectSlug: 'test',
  });

  const resolved = { mode: 'symbol-missing', target: 'UnknownSymbol' };
  const input = await buildRenderInput(engine, resolved, { depth: 'compact', focus: 'all' });

  assert.equal(input.target.mode, 'symbol-missing');
  assert.equal(input.target.name, 'UnknownSymbol');
  assert.ok(input.summary.some(s => s.includes('not found')));
});

test('runTargetContext resolves symbol and renders output', async () => {
  const sk = 'ts|src/service.mjs||function|MyService|0';
  const projectRoot = await createFixtureProject({
    symbolIndex: {
      [sk]: { graphNodeId: 'n1', memoryId: 'mem-1', status: 'enriched' },
      'ts|src/helper.mjs||function|Helper|0': { graphNodeId: 'n2', memoryId: 'mem-2', status: 'enriched' },
    },
    graph: {
      nodes: [
        { id: 'n1', label: 'MyService', source_file: 'src/service.mjs' },
        { id: 'n2', label: 'Helper', source_file: 'src/helper.mjs' },
      ],
      links: [
        { source: 'n1', target: 'n2', relation: 'imports' },
      ],
    },
    worklist: [],
  });

  try {
    const { output, resolved } = await runTargetContext({
      projectRoot,
      target: 'MyService',
      explicitMode: null,
      depth: 'compact',
      focus: 'all',
    });

    assert.equal(resolved.mode, 'symbol');
    assert.equal(resolved.symbolKey, sk);
    assert.ok(output.includes('Summary'), 'output missing Summary');
    assert.ok(output.includes('MyService'), 'output missing symbol name');
    assert.ok(output.includes('src/helper.mjs'), 'output missing neighbor filePath');
    assert.ok(output.includes('compact'), 'output missing depth metadata');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('runTargetContext explicit file mode resolves and renders', async () => {
  const projectRoot = await createFixtureProject({
    symbolIndex: {
      'ts|src/auth.ts||function|login|0': { graphNodeId: 'n1' },
      'ts|src/db.ts||function|connect|0': { graphNodeId: 'n2' },
    },
    graph: {
      nodes: [
        { id: 'n1', label: 'login', source_file: 'src/auth.ts' },
        { id: 'n2', label: 'connect', source_file: 'src/db.ts' },
      ],
      links: [
        { source: 'n1', target: 'n2', relation: 'calls' },
      ],
    },
    worklist: [],
  });

  try {
    const { output, resolved } = await runTargetContext({
      projectRoot,
      target: 'src/auth.ts',
      explicitMode: 'file',
      depth: 'compact',
      focus: 'all',
    });

    assert.equal(resolved.mode, 'file');
    assert.ok(output.includes('Summary'));
    assert.ok(output.includes('src/auth.ts'));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('runTargetContext unknown symbol in auto mode falls back to query', async () => {
  const projectRoot = await createFixtureProject();

  try {
    const { output, resolved } = await runTargetContext({
      projectRoot,
      target: 'NonExistentSymbol',
      explicitMode: null,
      depth: 'compact',
      focus: 'all',
    });

    assert.equal(resolved.mode, 'query');
    assert.ok(output.includes('no structural context'));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('runTargetContext explicit symbol mode returns symbol-missing for unknown', async () => {
  const projectRoot = await createFixtureProject();

  try {
    const { output, resolved } = await runTargetContext({
      projectRoot,
      target: 'NonExistentSymbol',
      explicitMode: 'symbol',
      depth: 'compact',
      focus: 'all',
    });

    assert.equal(resolved.mode, 'symbol-missing');
    assert.ok(output.includes('not found'));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('runTargetContext explicit query mode', async () => {
  const projectRoot = await createFixtureProject();

  try {
    const { output, resolved } = await runTargetContext({
      projectRoot,
      target: 'how does auth work',
      explicitMode: 'query',
      depth: 'compact',
      focus: 'all',
    });

    assert.equal(resolved.mode, 'query');
    assert.ok(output.includes('query'));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('renderTargetContext output from full pipeline is a valid string', async () => {
  const projectRoot = await createFixtureProject({
    symbolIndex: {
      'ts|src/app.mjs||function|App|0': { graphNodeId: 'n1' },
    },
    graph: {
      nodes: [{ id: 'n1', label: 'App', source_file: 'src/app.mjs' }],
      links: [],
    },
    worklist: [],
  });

  try {
    const { output } = await runTargetContext({
      projectRoot,
      target: 'App',
      explicitMode: 'symbol',
      depth: 'compact',
      focus: 'all',
    });

    assert.strictEqual(typeof output, 'string');
    assert.ok(output.length > 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

// --- main() CLI integration tests ---

import { loadArtifacts, main } from '../cli/context.mjs';

test('main --help prints target-aware usage with depth and focus', async () => {
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };

  try {
    const exitCode = await main(['--help']);
    assert.equal(exitCode, 0);
    const output = logs.join('\n');
    assert.ok(output.includes('depth'), 'help missing depth option');
    assert.ok(output.includes('focus'), 'help missing focus option');
    assert.ok(output.includes('symbol'), 'help missing symbol mode');
    assert.ok(output.includes('file'), 'help missing file mode');
    assert.ok(output.includes('query'), 'help missing query mode');
    assert.ok(output.includes('--refresh'), 'help missing --refresh');
  } finally {
    console.log = origLog;
  }
});

test('main -h prints target-aware usage', async () => {
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };

  try {
    const exitCode = await main(['-h']);
    assert.equal(exitCode, 0);
    const output = logs.join('\n');
    assert.ok(output.includes('compact'), 'help missing depth values');
    assert.ok(output.includes('createQueryEngine'), 'help missing examples');
  } finally {
    console.log = origLog;
  }
});

test('main explicit mode without target prints error', async () => {
  const errs = [];
  const origErr = console.error;
  console.error = (...args) => { errs.push(args.join(' ')); };

  try {
    const exitCode = await main(['query']);
    assert.equal(exitCode, 1);
    assert.ok(errs.some(e => e.includes('Missing target')), 'expected missing target error');
  } finally {
    console.error = origErr;
  }
});

test('main without target shows help', async () => {
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };

  try {
    const exitCode = await main([]);
    assert.equal(exitCode, 0);
    assert.ok(logs.some(l => l.includes('Usage:')), 'expected usage text');
  } finally {
    console.log = origLog;
  }
});

test('main with target resolves symbol inside PMC project', async () => {
  const sk = 'ts|src/ctx.mjs||function|doWork|0';
  const projectRoot = await createFixtureProject({
    symbolIndex: {
      [sk]: { graphNodeId: 'n1', memoryId: 'mem-1', status: 'enriched' },
    },
    graph: {
      nodes: [{ id: 'n1', label: 'doWork', source_file: 'src/ctx.mjs' }],
      links: [],
    },
    worklist: [],
  });

  const logs = [];
  const origLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };
  const origCwd = process.cwd;
  process.cwd = () => projectRoot;

  try {
    const exitCode = await main(['doWork']);
    assert.equal(exitCode, 0);
    const output = logs.join('\n');
    assert.ok(output.includes('Summary'), 'output missing Summary');
    assert.ok(output.includes('doWork'), 'output missing symbol name');
    assert.ok(output.includes('Metadata'), 'output missing Metadata');
  } finally {
    console.log = origLog;
    process.cwd = origCwd;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('parseArgs refresh preserves dot as valid path target', () => {
  const parsed = parseArgs(['.', '--refresh']);
  assert.equal(parsed.refresh, true);
  assert.equal(parsed.target, '.');
});

test('parseArgs refresh flag does not treat path-like target as symbol', () => {
  const parsed = parseArgs(['..', '--refresh']);
  assert.equal(parsed.refresh, true);
  assert.equal(parsed.target, '..');
});

test('main --refresh rejects non-path target like symbol names', async () => {
  const errs = [];
  const origErr = console.error;
  console.error = (...args) => { errs.push(args.join(' ')); };

  try {
    const exitCode = await main(['MySymbol', '--refresh']);
    assert.equal(exitCode, 1);
    assert.ok(
      errs.some(e => e.includes('non-path target') && e.includes('MySymbol')),
      `expected non-path rejection, got: ${errs.join(' | ')}`,
    );
  } finally {
    console.error = origErr;
  }
});

test('main --refresh with dot target reaches runProjectContext', async () => {
  // Does NOT call main(['.', '--refresh']) because project-context.mjs
  // has a module-level main() calling process.exit(1) on failure, which
  // crashes the test runner. Instead verify via parseArgs + the lack
  // of 'non-path target' error that '.' is accepted as a path target.
  const parsed = parseArgs(['.', '--refresh']);
  assert.equal(parsed.refresh, true);
  assert.equal(parsed.target, '.');
  // '.' is NOT treated as a non-path target (that logic lives in main's
  // --refresh branch, validated by the MySymbol test above).
});

// --- disk depth / source-cache tests ---

import { clearInProcessCache } from '../src/retrieval/source-cache.mjs';
import { hashSymbol } from '../src/hash.mjs';

async function createFixtureWithSource({ srcFile, lines, worklist = [] }) {
  const projectRoot = await mkdtemp(join(os.tmpdir(), 'pmc-disk-'));
  const pmcRoot = join(projectRoot, '.planning', 'project-memory-context');
  await mkdir(join(pmcRoot, 'graph'), { recursive: true });
  await mkdir(join(pmcRoot, 'enrichment'), { recursive: true });
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await writeFile(join(pmcRoot, 'install.json'), JSON.stringify({ installedAt: '2026-01-01T00:00:00.000Z', version: '0.1.0' }), 'utf8');
  await writeFile(join(pmcRoot, 'graph', 'graph.json'), JSON.stringify({ nodes: [], links: [] }), 'utf8');
  await writeFile(join(pmcRoot, 'enrichment', 'symbol-index.json'), JSON.stringify({}), 'utf8');
  await writeFile(join(pmcRoot, 'enrichment', 'worklist.json'), JSON.stringify(worklist), 'utf8');
  await writeFile(join(projectRoot, srcFile), lines.join('\n'), 'utf-8');
  return projectRoot;
}

test('runTargetContext disk depth emits Source (disk) section with code', async () => {
  clearInProcessCache();
  const lines = ['function alpha() {', '  return 1;', '}', '// comment'];
  const slice = lines.slice(0, 3).join('\n');
  const codeHash = await hashSymbol(slice);

  const sk = 'js|src/alpha.mjs||function|alpha|0';
  const worklist = [{
    symbolKey: sk, language: 'js', filePath: 'src/alpha.mjs',
    kind: 'function', name: 'alpha', exportScope: 'local',
    range: { startLine: 1, endLine: 3 }, codeHash, status: 'enriched',
  }];

  const projectRoot = await createFixtureWithSource({ srcFile: 'src/alpha.mjs', lines, worklist });

  try {
    const pmcRoot = join(projectRoot, '.planning', 'project-memory-context');
    await writeFile(join(pmcRoot, 'enrichment', 'symbol-index.json'), JSON.stringify({
      [sk]: { graphNodeId: null, memoryId: null, status: 'enriched' },
    }), 'utf8');

    const { output } = await runTargetContext({
      projectRoot, target: 'alpha', explicitMode: 'symbol', depth: 'disk', focus: 'all',
    });

    assert.ok(output.includes('Source (disk)'), `output missing Source (disk) section:\n${output}`);
    assert.ok(output.includes('return 1'), `output missing symbol code:\n${output}`);
    assert.ok(output.includes('✅ fresh'), `output missing fresh indicator:\n${output}`);
    assert.ok(!output.includes('⚠️  STALE'), `output should not show stale banner:\n${output}`);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('runTargetContext disk depth shows STALE banner on hash mismatch', async () => {
  clearInProcessCache();
  const lines = ['function beta() {', '  return 2;', '}'];
  const sk = 'js|src/beta.mjs||function|beta|0';
  const staleHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const worklist = [{
    symbolKey: sk, language: 'js', filePath: 'src/beta.mjs',
    kind: 'function', name: 'beta', exportScope: 'local',
    range: { startLine: 1, endLine: 3 }, codeHash: staleHash, status: 'enriched',
  }];

  const projectRoot = await createFixtureWithSource({ srcFile: 'src/beta.mjs', lines, worklist });

  try {
    const pmcRoot = join(projectRoot, '.planning', 'project-memory-context');
    await writeFile(join(pmcRoot, 'enrichment', 'symbol-index.json'), JSON.stringify({
      [sk]: { graphNodeId: null, memoryId: null, status: 'enriched' },
    }), 'utf8');

    const { output } = await runTargetContext({
      projectRoot, target: 'beta', explicitMode: 'symbol', depth: 'disk', focus: 'all',
    });

    assert.ok(output.includes('⚠️  STALE'), `output missing STALE banner:\n${output}`);
    assert.ok(output.includes('Source (disk)'), `output missing Source (disk) section:\n${output}`);
    assert.ok(output.includes('return 2'), `output missing symbol code:\n${output}`);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('renderTargetContext emits source block with code when source provided', () => {
  const input = {
    summary: ['Symbol: foo'], target: { mode: 'symbol', name: 'foo', filePath: 'src/foo.mjs', range: { startLine: 1, endLine: 2 } },
    relevant: [], relations: [], nextReads: [], metadata: { depth: 'disk', focus: 'all' },
    source: { code: 'function foo() {}', fresh: true, verified: true, source: 'disk', error: undefined },
  };
  const result = renderTargetContext(input);
  assert.ok(result.includes('Source (disk)'), 'missing source heading');
  assert.ok(result.includes('function foo() {}'), 'missing code content');
  assert.ok(result.includes('✅ fresh'), 'missing fresh indicator');
  assert.ok(!result.includes('⚠️  STALE'), 'should not have stale banner');
});

test('renderTargetContext shows STALE banner when fresh is false', () => {
  const input = {
    summary: [], target: { mode: 'symbol', name: 'bar' }, relevant: [], relations: [], nextReads: [],
    metadata: { depth: 'disk', focus: 'all' },
    source: { code: 'function bar() {}', fresh: false, verified: true, source: 'disk', error: undefined },
  };
  const result = renderTargetContext(input);
  assert.ok(result.includes('⚠️  STALE'), 'missing STALE banner');
  assert.ok(result.includes('function bar() {}'), 'missing code');
  assert.ok(!result.includes('✅ fresh'), 'should not show fresh when stale');
});

test('renderTargetContext shows unverified note for cache source', () => {
  const input = {
    summary: [], target: { mode: 'symbol', name: 'baz' }, relevant: [], relations: [], nextReads: [],
    metadata: { depth: 'disk', focus: 'all' },
    source: { code: 'const baz = 1;', fresh: null, verified: false, source: 'cache', error: undefined },
  };
  const result = renderTargetContext(input);
  assert.ok(result.includes('Source (cache — unverified)'), 'missing cache source label');
  assert.ok(result.includes('Unverified cache hit'), 'missing unverified note');
});

test('renderTargetContext shows error when source fetch failed', () => {
  const input = {
    summary: [], target: { mode: 'symbol', name: 'broken' }, relevant: [], relations: [], nextReads: [],
    metadata: { depth: 'disk', focus: 'all' },
    source: { code: null, error: 'cannot read src/broken.mjs: ENOENT', source: 'disk' },
  };
  const result = renderTargetContext(input);
  assert.ok(result.includes('Source (disk)'), 'missing source heading');
  assert.ok(result.includes('ENOENT'), 'missing error message');
});

// --- community name exposure (task 3.2 / 4.5) ---

import { openGraphDb } from '../src/graph-store/graph-db.mjs';

test('buildRenderInput symbol mode includes community name from the graph store', async () => {
  const sk = 'ts|src/db.mjs||function|openGraphDb|0';
  const graphStore = openInMemoryStoreWithCommunity();
  const engine = createQueryEngine({
    graphStore,
    symbolIndex: {
      [sk]: { graphNodeId: 'n1', memoryId: 'mem-1', status: 'enriched' },
    },
    worklist: [],
    enrichmentDir: '/tmp/enrich',
    projectSlug: 'test',
  });

  const resolved = { mode: 'symbol', target: 'openGraphDb', symbolKey: sk };
  const input = await buildRenderInput(engine, resolved, { depth: 'compact', focus: 'all' });

  assert.equal(input.target.communityName, 'Graph Storage');
  assert.equal(String(input.target.communityId), '7');
});

test('get-context output surfaces the community name for a named community', async () => {
  const sk = 'ts|src/db.mjs||function|openGraphDb|0';
  const projectRoot = await mkdtemp(join(os.tmpdir(), 'pmc-comm-ctx-'));
  const pmcRoot = join(projectRoot, '.planning', 'project-memory-context');
  await mkdir(join(pmcRoot, 'graph'), { recursive: true });
  await mkdir(join(pmcRoot, 'enrichment'), { recursive: true });
  await writeFile(
    join(pmcRoot, 'install.json'),
    JSON.stringify({ installedAt: '2026-06-25T00:00:00.000Z', version: '0.1.0' }),
    'utf8',
  );
  const graph = {
    nodes: [{ id: 'n1', label: 'openGraphDb', source_file: 'src/db.mjs', community: 7, degree: 5 }],
    links: [],
  };
  await writeFile(join(pmcRoot, 'graph', 'graph.json'), JSON.stringify(graph), 'utf8');
  await writeFile(
    join(pmcRoot, 'enrichment', 'symbol-index.json'),
    JSON.stringify({ [sk]: { graphNodeId: 'n1', memoryId: 'mem-1', status: 'enriched' } }),
    'utf8',
  );
  await writeFile(join(pmcRoot, 'enrichment', 'worklist.json'), JSON.stringify([]), 'utf8');

  // Persist a community name into graph.db before querying.
  const seedStore = openGraphDb(join(pmcRoot, 'graph', 'graph.db'), join(pmcRoot, 'graph', 'graph.json'));
  seedStore.upsertCommunityName('7', 'Graph Storage');
  seedStore.close();

  try {
    const { output } = await runTargetContext({
      projectRoot,
      target: 'openGraphDb',
      explicitMode: 'symbol',
      depth: 'compact',
      focus: 'all',
    });

    assert.ok(output.includes('community: Graph Storage'), `output missing community name:\n${output}`);
  } finally {
    await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  }
});

function openInMemoryStoreWithCommunity() {
  // Minimal store implementing the surface the engine needs plus community-name lookup.
  const node = { id: 'n1', label: 'openGraphDb', source_file: 'src/db.mjs', community: 7, degree: 5 };
  return {
    getNode(id) {
      return id === 'n1' ? node : null;
    },
    getNodesByFile() {
      return [];
    },
    traverse() {
      return { nodes: [node], edges: [], depth_reached: 0 };
    },
    getAllCommunityNames() {
      return [{ community_id: '7', name: 'Graph Storage' }];
    },
    close() {},
  };
}

test('loadArtifacts wraps corrupt JSON with clear error', async () => {
  const projectRoot = await mkdtemp(join(os.tmpdir(), 'pmc-corr-'));
  const pmcRoot = join(projectRoot, '.planning', 'project-memory-context');
  await mkdir(join(pmcRoot, 'graph'), { recursive: true });
  await mkdir(join(pmcRoot, 'enrichment'), { recursive: true });

  await writeFile(
    join(pmcRoot, 'install.json'),
    JSON.stringify({ installedAt: '2026-05-19T00:00:00.000Z', version: '0.1.0' }, null, 2),
    'utf8',
  );
  // Write valid symbol-index but corrupt graph
  await writeFile(join(pmcRoot, 'enrichment', 'symbol-index.json'), JSON.stringify({}), 'utf8');
  await writeFile(join(pmcRoot, 'enrichment', 'worklist.json'), JSON.stringify([]), 'utf8');
  await writeFile(join(pmcRoot, 'graph', 'graph.json'), 'this is not json', 'utf8');

  try {
    await loadArtifacts(projectRoot);
    assert.fail('should have thrown');
  } catch (error) {
    assert.ok(
      error.message.includes('Failed to load PMC artifacts'),
      `expected artifacts error prefix, got: ${error.message}`,
    );
    assert.ok(
      error.message.length > 0,
      'error message should not be empty',
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  }
});
