import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDepthConfig,
  createQueryEngine,
  focusToEdgeTypes,
} from '../src/retrieval/query-engine.mjs';

test('createDepthConfig returns compact config', () => {
  const config = createDepthConfig('compact');
  assert.deepEqual(config, {
    maxHops: 1,
    includeCommunity: false,
    maxTokens: 2000,
    readSourceFiles: false,
  });
});

test('createDepthConfig returns extended config', () => {
  const config = createDepthConfig('extended');
  assert.deepEqual(config, {
    maxHops: 2,
    includeCommunity: true,
    maxTokens: 5000,
    readSourceFiles: false,
  });
});

test('createDepthConfig returns deep config', () => {
  const config = createDepthConfig('deep');
  assert.deepEqual(config, {
    maxHops: 3,
    includeCommunity: true,
    maxTokens: 10000,
    readSourceFiles: false,
  });
});

test('createDepthConfig returns disk config', () => {
  const config = createDepthConfig('disk');
  assert.deepEqual(config, {
    maxHops: 3,
    includeCommunity: true,
    maxTokens: 15000,
    readSourceFiles: true,
  });
});

test('createDepthConfig defaults unknown to compact', () => {
  const compact = createDepthConfig('compact');
  const unknown = createDepthConfig('bogus');
  assert.deepEqual(unknown, compact);
});

test('createDepthConfig defaults undefined to compact', () => {
  const compact = createDepthConfig('compact');
  const undef = createDepthConfig(undefined);
  assert.deepEqual(undef, compact);
});

test('createQueryEngine builds nodeMap from graph nodes', () => {
  const engine = createQueryEngine({
    graph: {
      nodes: [
        { id: 'node-1', label: 'User' },
        { id: 'node-2', label: 'Post' },
      ],
    },
    symbolIndex: {},
    worklist: [],
    enrichmentDir: '/tmp/enrich',
    projectSlug: 'test',
  });

  assert.equal(engine.graphNodeIdToSymbolKey('node-1'), null);
  assert.equal(engine.graphNodeIdToSymbolKey('node-2'), null);
  assert.equal(engine.graphNodeIdToSymbolKey('node-999'), null);
});

test('createQueryEngine maps graphNodeId to symbolKey via symbolIndex', () => {
  const engine = createQueryEngine({
    graph: { nodes: [{ id: 'n1' }, { id: 'n2' }] },
    symbolIndex: {
      'ts|src/user.ts|class|exported|User|0': {
        graphNodeId: 'n1',
        memoryId: 'mem-1',
        codeHash: 'abc',
        status: 'enriched',
      },
      'ts|src/post.ts|class|exported|Post|0': {
        graphNodeId: 'n2',
        memoryId: 'mem-2',
        codeHash: 'def',
        status: 'enriched',
      },
    },
    worklist: [],
    enrichmentDir: '/tmp/enrich',
    projectSlug: 'test',
  });

  assert.equal(
    engine.graphNodeIdToSymbolKey('n1'),
    'ts|src/user.ts|class|exported|User|0',
  );
  assert.equal(
    engine.graphNodeIdToSymbolKey('n2'),
    'ts|src/post.ts|class|exported|Post|0',
  );
  assert.equal(engine.graphNodeIdToSymbolKey('n-missing'), null);
});

test('createQueryEngine findSymbolKeyByName parses symbol keys', () => {
  const engine = createQueryEngine({
    graph: { nodes: [] },
    symbolIndex: {
      'ts|src/user.ts|class|exported|User|0': { graphNodeId: null },
      'ts|src/user.ts|function|exported|getUser|1': { graphNodeId: null },
      'ts|src/user.ts|function|local|getUser|0': { graphNodeId: null },
    },
    worklist: [],
    enrichmentDir: '/tmp/enrich',
    projectSlug: 'test',
  });

  const userKeys = engine.findSymbolKeyByName('User');
  assert.equal(userKeys.length, 1);
  assert.equal(userKeys[0], 'ts|src/user.ts|class|exported|User|0');

  const getUserKeys = engine.findSymbolKeyByName('getUser');
  assert.equal(getUserKeys.length, 2);

  const missing = engine.findSymbolKeyByName('nonexistent');
  assert.equal(missing.length, 0);
});

test('createQueryEngine findSymbolKeysByFilePath parses symbol keys', () => {
  const engine = createQueryEngine({
    graph: { nodes: [] },
    symbolIndex: {
      'ts|src/user.ts|class|exported|User|0': { graphNodeId: null },
      'ts|src/user.ts|function|exported|getUser|1': { graphNodeId: null },
      'ts|src/post.ts|class|exported|Post|0': { graphNodeId: null },
    },
    worklist: [],
    enrichmentDir: '/tmp/enrich',
    projectSlug: 'test',
  });

  const userKeys = engine.findSymbolKeysByFilePath('src/user.ts');
  assert.equal(userKeys.length, 2);

  const postKeys = engine.findSymbolKeysByFilePath('src/post.ts');
  assert.equal(postKeys.length, 1);
  assert.equal(postKeys[0], 'ts|src/post.ts|class|exported|Post|0');

  const missing = engine.findSymbolKeysByFilePath('src/missing.ts');
  assert.equal(missing.length, 0);
});

test('createQueryEngine findSymbolKeysByFilePath normalizes backslashes', () => {
  const engine = createQueryEngine({
    graph: { nodes: [] },
    symbolIndex: {
      'ts|src/user.ts|class|exported|User|0': { graphNodeId: null },
    },
    worklist: [],
    enrichmentDir: '/tmp/enrich',
    projectSlug: 'test',
  });

  const keys = engine.findSymbolKeysByFilePath('src\\user.ts');
  assert.equal(keys.length, 1);
  assert.equal(keys[0], 'ts|src/user.ts|class|exported|User|0');
});

test('createQueryEngine handles empty graph and symbolIndex', () => {
  const engine = createQueryEngine({
    graph: { nodes: [] },
    symbolIndex: {},
    worklist: [],
    enrichmentDir: '/tmp/enrich',
    projectSlug: 'test',
  });

  assert.equal(engine.graphNodeIdToSymbolKey('anything'), null);
  assert.deepEqual(engine.findSymbolKeyByName('anything'), []);
  assert.deepEqual(engine.findSymbolKeysByFilePath('any/path.ts'), []);
});

test('createQueryEngine handles csharp symbol keys with 7 parts', () => {
  const engine = createQueryEngine({
    graph: { nodes: [] },
    symbolIndex: {
      'csharp|Services/UserService.cs|MyApp|UserService|method|GetUser|(Guid,CancellationToken)':
        { graphNodeId: null },
    },
    worklist: [],
    enrichmentDir: '/tmp/enrich',
    projectSlug: 'test',
  });

  const keys = engine.findSymbolKeyByName('GetUser');
  assert.equal(keys.length, 1);

  const fileKeys = engine.findSymbolKeysByFilePath('Services/UserService.cs');
  assert.equal(fileKeys.length, 1);
});

test('createDepthConfig returns new object each call', () => {
  const a = createDepthConfig('compact');
  const b = createDepthConfig('compact');
  a.maxTokens = 99999;
  assert.equal(b.maxTokens, 2000);
});

test('traverseGraph performs BFS from seed nodes returning neighbors within maxHops', () => {
  const engine = createQueryEngine({
    graph: {
      nodes: [
        { id: 'a', label: 'A', source_file: 'f.ts' },
        { id: 'b', label: 'B', source_file: 'f.ts' },
        { id: 'c', label: 'C', source_file: 'f.ts' },
        { id: 'd', label: 'D', source_file: 'f.ts' },
      ],
      links: [
        { source: 'a', target: 'b', relation: 'calls' },
        { source: 'b', target: 'c', relation: 'calls' },
        { source: 'c', target: 'd', relation: 'calls' },
      ],
    },
    symbolIndex: {},
    worklist: [],
  });

  const result = engine.traverseGraph({ nodeIds: ['a'], maxHops: 1 });
  assert.deepEqual(result.nodes.map((n) => n.id).sort(), ['a', 'b']);
  assert.equal(result.depth_reached, 1);
});

test('traverseGraph respects maxHops=2 reaching 2 hops', () => {
  const engine = createQueryEngine({
    graph: {
      nodes: [
        { id: 'a', label: 'A', source_file: 'f.ts' },
        { id: 'b', label: 'B', source_file: 'f.ts' },
        { id: 'c', label: 'C', source_file: 'f.ts' },
        { id: 'd', label: 'D', source_file: 'f.ts' },
      ],
      links: [
        { source: 'a', target: 'b', relation: 'calls' },
        { source: 'b', target: 'c', relation: 'calls' },
        { source: 'c', target: 'd', relation: 'calls' },
      ],
    },
    symbolIndex: {},
    worklist: [],
  });

  const result = engine.traverseGraph({ nodeIds: ['a'], maxHops: 2 });
  assert.deepEqual(result.nodes.map((n) => n.id).sort(), ['a', 'b', 'c']);
  assert.equal(result.depth_reached, 2);
});

test('traverseGraph filters by edgeTypes', () => {
  const engine = createQueryEngine({
    graph: {
      nodes: [
        { id: 'a', label: 'A', source_file: 'f.ts' },
        { id: 'b', label: 'B', source_file: 'f.ts' },
        { id: 'c', label: 'C', source_file: 'f.ts' },
      ],
      links: [
        { source: 'a', target: 'b', relation: 'calls' },
        { source: 'a', target: 'c', relation: 'imports' },
      ],
    },
    symbolIndex: {},
    worklist: [],
  });

  const result = engine.traverseGraph({ nodeIds: ['a'], maxHops: 1, edgeTypes: ['calls'] });
  assert.deepEqual(result.nodes.map((n) => n.id).sort(), ['a', 'b']);
});

test('traverseGraph traverses inbound edges when direction is inbound', () => {
  const engine = createQueryEngine({
    graph: {
      nodes: [
        { id: 'a', label: 'A', source_file: 'f.ts' },
        { id: 'b', label: 'B', source_file: 'f.ts' },
        { id: 'c', label: 'C', source_file: 'f.ts' },
      ],
      links: [
        { source: 'b', target: 'a', relation: 'calls' },
        { source: 'c', target: 'a', relation: 'calls' },
      ],
    },
    symbolIndex: {},
    worklist: [],
  });

  const result = engine.traverseGraph({ nodeIds: ['a'], maxHops: 1, direction: 'inbound' });
  assert.deepEqual(result.nodes.map((n) => n.id).sort(), ['a', 'b', 'c']);
});

test('traverseGraph returns empty for unknown seed nodes', () => {
  const engine = createQueryEngine({
    graph: { nodes: [], links: [] },
    symbolIndex: {},
    worklist: [],
  });

  const result = engine.traverseGraph({ nodeIds: ['nonexistent'], maxHops: 3 });
  assert.deepEqual(result.nodes, []);
  assert.equal(result.depth_reached, 0);
});

test('querySymbolContext returns enrichment and structural neighbors for a symbol', () => {
  const engine = createQueryEngine({
    graph: {
      nodes: [
        { id: 'n_class', label: 'MyClass', source_file: 'src/mod.ts' },
        { id: 'n_method', label: '.run()', source_file: 'src/mod.ts' },
        { id: 'n_import', label: 'helper', source_file: 'src/helper.ts' },
      ],
      links: [
        { source: 'n_class', target: 'n_method', relation: 'method' },
        { source: 'n_class', target: 'n_import', relation: 'imports' },
      ],
    },
    symbolIndex: {
      'ts|src/mod.ts|class|exported|MyClass|0': { memoryId: 'mem-1', graphNodeId: 'n_class', codeHash: 'h1', status: 'enriched', lastEnrichedAt: '2026-01-01' },
      'ts|src/mod.ts|method|MyClass|run|0': { memoryId: 'mem-2', graphNodeId: 'n_method', codeHash: 'h2', status: 'enriched', lastEnrichedAt: '2026-01-01' },
      'ts|src/helper.ts|function|exported|helper|0': { memoryId: 'mem-3', graphNodeId: 'n_import', codeHash: 'h3', status: 'enriched', lastEnrichedAt: '2026-01-01' },
    },
    worklist: [
      { symbolKey: 'ts|src/mod.ts|class|exported|MyClass|0', name: 'MyClass', filePath: 'src/mod.ts', kind: 'class', range: { startLine: 1, endLine: 20 } },
      { symbolKey: 'ts|src/mod.ts|method|MyClass|run|0', name: 'run', filePath: 'src/mod.ts', kind: 'method', range: { startLine: 5, endLine: 10 } },
      { symbolKey: 'ts|src/helper.ts|function|exported|helper|0', name: 'helper', filePath: 'src/helper.ts', kind: 'function', range: { startLine: 1, endLine: 5 } },
    ],
  });

  const result = engine.querySymbolContext({ symbolKey: 'ts|src/mod.ts|class|exported|MyClass|0', depth: 'compact' });
  assert.equal(result.target.symbolKey, 'ts|src/mod.ts|class|exported|MyClass|0');
  assert.equal(result.target.graphNodeId, 'n_class');
  assert.ok(result.neighbors.length >= 1);
  assert.ok(result.neighbors.some((n) => n.graphNodeId === 'n_method'));
  assert.ok(result.neighbors.some((n) => n.graphNodeId === 'n_import'));
});

test('queryFileContext returns all symbols in a file with neighbors', () => {
  const engine = createQueryEngine({
    graph: {
      nodes: [
        { id: 'n_class', label: 'MyClass', source_file: 'src/mod.ts' },
        { id: 'n_method', label: '.run()', source_file: 'src/mod.ts' },
        { id: 'n_other', label: 'OtherClass', source_file: 'src/other.ts' },
      ],
      links: [
        { source: 'n_class', target: 'n_method', relation: 'method' },
        { source: 'n_other', target: 'n_class', relation: 'imports' },
      ],
    },
    symbolIndex: {
      'ts|src/mod.ts|class|exported|MyClass|0': { memoryId: 'mem-1', graphNodeId: 'n_class', codeHash: 'h1', status: 'enriched', lastEnrichedAt: '2026-01-01' },
      'ts|src/mod.ts|method|MyClass|run|0': { memoryId: 'mem-2', graphNodeId: 'n_method', codeHash: 'h2', status: 'enriched', lastEnrichedAt: '2026-01-01' },
    },
    worklist: [
      { symbolKey: 'ts|src/mod.ts|class|exported|MyClass|0', name: 'MyClass', filePath: 'src/mod.ts', kind: 'class', range: { startLine: 1, endLine: 20 } },
      { symbolKey: 'ts|src/mod.ts|method|MyClass|run|0', name: 'run', filePath: 'src/mod.ts', kind: 'method', range: { startLine: 5, endLine: 10 } },
    ],
  });

  const result = engine.queryFileContext({ filePath: 'src/mod.ts', depth: 'compact' });
  assert.equal(result.symbols.length, 2);
  assert.ok(result.symbols.some((s) => s.name === 'MyClass'));
  assert.ok(result.symbols.some((s) => s.name === 'run'));
  assert.ok(result.neighbors.length >= 1);
});

test('queryImpactScope returns inbound dependents', () => {
  const engine = createQueryEngine({
    graph: {
      nodes: [
        { id: 'n_target', label: 'target', source_file: 'src/a.ts' },
        { id: 'n_caller1', label: 'caller1', source_file: 'src/b.ts' },
        { id: 'n_caller2', label: 'caller2', source_file: 'src/c.ts' },
      ],
      links: [
        { source: 'n_caller1', target: 'n_target', relation: 'calls' },
        { source: 'n_caller2', target: 'n_target', relation: 'imports' },
      ],
    },
    symbolIndex: {
      'ts|src/a.ts|function|exported|target|0': { memoryId: 'mem-1', graphNodeId: 'n_target', codeHash: 'h1', status: 'enriched', lastEnrichedAt: '2026-01-01' },
      'ts|src/b.ts|function|exported|caller1|0': { memoryId: 'mem-2', graphNodeId: 'n_caller1', codeHash: 'h2', status: 'enriched', lastEnrichedAt: '2026-01-01' },
      'ts|src/c.ts|function|exported|caller2|0': { memoryId: 'mem-3', graphNodeId: 'n_caller2', codeHash: 'h3', status: 'enriched', lastEnrichedAt: '2026-01-01' },
    },
    worklist: [],
  });

  const result = engine.queryImpactScope({ symbolKeys: ['ts|src/a.ts|function|exported|target|0'], depth: 'compact' });
  assert.equal(result.target.symbolKey, 'ts|src/a.ts|function|exported|target|0');
  assert.equal(result.dependents.length, 2);
  assert.ok(result.dependents.some((d) => d.graphNodeId === 'n_caller1'));
  assert.ok(result.dependents.some((d) => d.graphNodeId === 'n_caller2'));
});

test('focusToEdgeTypes maps focus keywords to edge types', () => {
  assert.deepEqual(focusToEdgeTypes('dependencies'), ['imports', 'imports_from']);
  assert.deepEqual(focusToEdgeTypes('callers'), ['calls']);
  assert.deepEqual(focusToEdgeTypes('containment'), ['contains', 'method']);
  assert.deepEqual(focusToEdgeTypes('all'), ['calls', 'imports', 'imports_from', 'contains', 'method']);
});
