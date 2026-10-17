import test from 'node:test';
import assert from 'node:assert/strict';

import { attachGraphNodeIds } from '../src/graph-node-resolver.mjs';
import { buildEnrichmentWorklist } from '../src/symbol-extractor.mjs';

test('attachGraphNodeIds matches symbols to graph nodes by symbol key', () => {
  const symbols = [
    {
      symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
      name: 'getUser',
      filePath: 'src/user.ts',
      kind: 'function',
    },
  ];

  const graph = {
    nodes: [
      {
        id: 'node-1',
        metadata: {
          symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
        },
      },
    ],
  };

  const resolved = attachGraphNodeIds({ symbols, graph });
  assert.equal(resolved[0].graphNodeId, 'node-1');
});

test('attachGraphNodeIds matches graphify node with source_file and exact label (class)', () => {
  const symbols = [
    {
      symbolKey: 'ts|agent-memory-mcp/src/embedder.ts|class|exported|TransformersEmbedder|0',
      name: 'TransformersEmbedder',
      filePath: 'agent-memory-mcp/src/embedder.ts',
      kind: 'class',
    },
  ];

  const graph = {
    nodes: [
      {
        label: 'TransformersEmbedder',
        file_type: 'code',
        source_file: 'agent-memory-mcp/src/embedder.ts',
        source_location: 'L5',
        id: 'src_embedder_transformersembedder',
        community: 2,
        norm_label: 'transformersembedder',
      },
    ],
  };

  const resolved = attachGraphNodeIds({ symbols, graph });
  assert.equal(resolved[0].graphNodeId, 'src_embedder_transformersembedder');
});

test('attachGraphNodeIds matches graphify method node (.methodName() label)', () => {
  const symbols = [
    {
      symbolKey: 'ts|agent-memory-mcp/src/embedder.ts|method|TransformersEmbedder|embed|0',
      name: 'embed',
      filePath: 'agent-memory-mcp/src/embedder.ts',
      kind: 'method',
    },
  ];

  const graph = {
    nodes: [
      {
        label: '.embed()',
        file_type: 'code',
        source_file: 'agent-memory-mcp/src/embedder.ts',
        source_location: 'L18',
        id: 'src_embedder_transformersembedder_embed',
        community: 2,
        norm_label: '.embed()',
      },
    ],
  };

  const resolved = attachGraphNodeIds({ symbols, graph });
  assert.equal(resolved[0].graphNodeId, 'src_embedder_transformersembedder_embed');
});

test('attachGraphNodeIds matches graphify function node with kind=function', () => {
  const symbols = [
    {
      symbolKey: 'ts|src/utils.ts|function|exported|formatDate|1',
      name: 'formatDate',
      filePath: 'src/utils.ts',
      kind: 'function',
    },
  ];

  const graph = {
    nodes: [
      {
        label: '.formatDate()',
        file_type: 'code',
        source_file: 'src/utils.ts',
        source_location: 'L10',
        id: 'src_utils_formatdate',
        community: 1,
        norm_label: '.formatdate()',
      },
    ],
  };

  const resolved = attachGraphNodeIds({ symbols, graph });
  assert.equal(resolved[0].graphNodeId, 'src_utils_formatdate');
});

test('attachGraphNodeIds does not use norm_label when the exact label differs', () => {
  const symbols = [
    {
      symbolKey: 'ts|src/app.ts|class|exported|MyComponent|0',
      name: 'MyComponent',
      filePath: 'src/app.ts',
      kind: 'class',
    },
  ];

  const graph = {
    nodes: [
      {
        label: 'mycomponent',
        file_type: 'code',
        source_file: 'src/app.ts',
        source_location: 'L1',
        id: 'src_app_mycomponent',
        community: 1,
        norm_label: 'mycomponent',
      },
    ],
  };

  const resolved = attachGraphNodeIds({ symbols, graph });
  assert.equal(resolved[0].graphNodeId, null);
});

test('attachGraphNodeIds returns null when no match found', () => {
  const symbols = [
    {
      symbolKey: 'ts|src/missing.ts|function|exported|noExist|0',
      name: 'noExist',
      filePath: 'src/missing.ts',
      kind: 'function',
    },
  ];

  const graph = {
    nodes: [
      {
        label: 'SomethingElse',
        source_file: 'src/other.ts',
        id: 'node-x',
      },
    ],
  };

  const resolved = attachGraphNodeIds({ symbols, graph });
  assert.equal(resolved[0].graphNodeId, null);
});

test('attachGraphNodeIds clears stale graphNodeId when no graph match', () => {
  const symbols = [
    {
      symbolKey: 'ts|src/orphan.ts|function|exported|orphan|0',
      name: 'orphan',
      filePath: 'src/orphan.ts',
      kind: 'function',
      graphNodeId: 'pre-existing-id',
    },
  ];

  const graph = { nodes: [] };

  const resolved = attachGraphNodeIds({ symbols, graph });
  assert.equal(resolved[0].graphNodeId, null);
});

test('attachGraphNodeIds resolves multiple symbols to different nodes', () => {
  const symbols = [
    {
      symbolKey: 'ts|src/embedder.ts|class|exported|Embedder|0',
      name: 'Embedder',
      filePath: 'src/embedder.ts',
      kind: 'class',
    },
    {
      symbolKey: 'ts|src/embedder.ts|method|Embedder|embed|0',
      name: 'embed',
      filePath: 'src/embedder.ts',
      kind: 'method',
    },
  ];

  const graph = {
    nodes: [
      {
        label: 'Embedder',
        source_file: 'src/embedder.ts',
        id: 'class-node',
      },
      {
        label: '.embed()',
        source_file: 'src/embedder.ts',
        id: 'method-node',
      },
    ],
  };

  const resolved = attachGraphNodeIds({ symbols, graph });
  assert.equal(resolved[0].graphNodeId, 'class-node');
  assert.equal(resolved[1].graphNodeId, 'method-node');
});

test('conflicting metadata and legacy keys fail closed independent of node order', () => {
  const symbols = [{ symbolKey: 'wanted', name: 'Thing', filePath: 'src/a.ts', kind: 'class' }];
  const nodes = [
    { id: 'conflict', symbolKey: 'wanted', metadata: { symbolKey: 'other' }, label: 'Thing', source_file: 'src/a.ts' },
    { id: 'right', metadata: { symbolKey: 'wanted' } },
  ];
  for (const orderedNodes of [nodes, [...nodes].reverse()]) {
    const [resolved] = attachGraphNodeIds({ symbols, graph: { nodes: orderedNodes } });
    assert.equal(resolved.graphNodeId, null);
    assert.equal(resolved.resolutionReason, 'ambiguous');
  }
});

test('a mismatched explicit candidate key cannot resolve by same-file/name fallback', () => {
  const symbols = [{ symbolKey: 'wanted', name: 'Thing', filePath: 'src/a.ts', kind: 'class' }];
  const nodes = [
    { id: 'wrong', metadata: { symbolKey: 'other' }, label: 'Thing', source_file: 'src/a.ts' },
    { id: 'right', metadata: { symbolKey: 'wanted' } },
  ];
  for (const orderedNodes of [nodes, [...nodes].reverse()]) {
    const [resolved] = attachGraphNodeIds({ symbols, graph: { nodes: orderedNodes } });
    assert.equal(resolved.graphNodeId, 'right');
  }
  const [mismatchedOnly] = attachGraphNodeIds({ symbols, graph: { nodes: [nodes[0]] } });
  assert.equal(mismatchedOnly.graphNodeId, null);
});

test('duplicate exact keys with distinct ids are ambiguous independent of order', () => {
  const symbols = [{ symbolKey: 'same', name: 'A', filePath: 'a.ts', kind: 'class' }];
  for (const nodes of [
    [{ id: 'one', metadata: { symbolKey: 'same' } }, { id: 'two', metadata: { symbolKey: 'same' } }],
    [{ id: 'two', metadata: { symbolKey: 'same' } }, { id: 'one', metadata: { symbolKey: 'same' } }],
  ]) {
    const [resolved] = attachGraphNodeIds({ symbols, graph: { nodes } });
    assert.equal(resolved.graphNodeId, null);
    assert.equal(resolved.resolutionReason, 'ambiguous');
  }
});

test('fallback chooses unique nearest source line and normalizes paths and Graphify labels', () => {
  const symbols = [{ symbolKey: 'key', name: 'work', filePath: './src\\a.ts', kind: 'function', range: { startLine: 20 } }];
  const graph = { nodes: [
    { id: 'far', source_file: 'src/a.ts', source_location: 'L4', label: '.work()' },
    { id: 'near', source_file: 'src/a.ts', source_location: 'L18', label: 'work()' },
  ] };
  assert.equal(attachGraphNodeIds({ symbols, graph })[0].graphNodeId, 'near');
});

test('reversed source ranges are invalid evidence and cannot win a nearest-line match', () => {
  const symbol = { symbolKey: 'k', name: 'run', filePath: 'src/a.ts', range: { startLine: 5 } };
  const graph = { nodes: [
    { id: 'reversed', source_file: 'src/a.ts', source_location: 'L9-L3', label: '.run()' },
    { id: 'valid', source_file: 'src/a.ts', source_location: 'L4-L7', label: 'run()' },
  ] };
  const [resolved] = attachGraphNodeIds({ symbols: [symbol], graph });
  assert.equal(resolved.graphNodeId, null);
  assert.equal(resolved.resolutionReason, 'ambiguous');
});

test('fallback ties and missing or invalid lines fail closed', () => {
  const symbol = { symbolKey: 'k', name: 'run', filePath: 'src/a.ts', range: { startLine: 10 } };
  const nodes = [
    { id: 'a', source_file: 'src/a.ts', source_location: 'L8', label: '.run()' },
    { id: 'b', source_file: 'src/a.ts', metadata: { source_location: 'L12' }, label: 'run()' },
  ];
  for (const line of [10, undefined, 'L10bad']) {
    const [resolved] = attachGraphNodeIds({ symbols: [{ ...symbol, range: { startLine: line } }], graph: { nodes } });
    assert.equal(resolved.graphNodeId, null);
    assert.equal(resolved.resolutionReason, 'ambiguous');
  }
});

test('single fallback candidate resolves without source lines; identical ids deduplicate', () => {
  const symbol = { symbolKey: 'k', name: 'A', filePath: 'a.ts', kind: 'class' };
  const graph = { nodes: [
    { id: 'same', source_file: 'a.ts', label: 'A' },
    { id: 'same', source_file: 'a.ts', label: 'A' },
  ] };
  assert.equal(attachGraphNodeIds({ symbols: [symbol], graph })[0].graphNodeId, 'same');
});

test('resolverReport returns counts, zero empty null rate, and ephemeral per-symbol reasons', async () => {
  const { resolverReport } = await import('../src/graph-node-resolver.mjs');
  const symbols = [
    { symbolKey: 'hit', name: 'A', filePath: 'a.ts', kind: 'class' },
    { symbolKey: 'miss', name: 'B', filePath: 'b.ts', kind: 'class' },
  ];
  const report = resolverReport({ symbols, graph: { nodes: [
    { id: 'a', metadata: { symbolKey: 'hit' } },
    { id: 'wrong', source_file: 'different.ts', label: 'Elsewhere' },
  ] } });
  assert.equal(report.total, 2);
  assert.equal(report.resolved, 1);
  assert.equal(report.unresolved, 1);
  assert.equal(report.nullRate, 0.5);
  assert.deepEqual(report.reasons, { 'no-file-node': 1, 'no-label-match': 0, ambiguous: 0 });
  assert.equal(report.symbols[1].resolutionReason, 'no-file-node');
  assert.equal(Object.hasOwn(report.symbols[1], 'resolutionReason'), true);
  assert.equal(Object.getOwnPropertyDescriptor(report.symbols[1], 'resolutionReason').enumerable, false);
  assert.equal(Object.hasOwn({ ...report.symbols[1] }, 'resolutionReason'), false);
  assert.equal(JSON.stringify(report.symbols).includes('resolutionReason'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(report)).reasons, report.reasons);
  assert.equal('resolutionReason' in symbols[1], false);
  assert.equal(resolverReport({ symbols: [], graph: null }).nullRate, 0);
});

test('worklist records omit resolver diagnostics while retaining serialized report counts', () => {
  const report = (async () => {
    const { resolverReport } = await import('../src/graph-node-resolver.mjs');
    return resolverReport({
      symbols: [{ symbolKey: 'missing', name: 'Missing', filePath: 'missing.ts' }],
      graph: { nodes: [] },
    });
  })();
  return report.then((result) => {
    const worklist = buildEnrichmentWorklist({ symbols: result.symbols, symbolIndex: {} });
    assert.equal(result.symbols[0].resolutionReason, 'no-file-node');
    assert.equal(Object.hasOwn(worklist[0], 'resolutionReason'), false);
    assert.equal(JSON.stringify(worklist).includes('resolutionReason'), false);
    assert.deepEqual(JSON.parse(JSON.stringify(result)).reasons, result.reasons);
    assert.equal(JSON.parse(JSON.stringify(result)).unresolved, 1);
  });
});

test('legacy enumerable input diagnostics are copied as non-enumerable and do not serialize', () => {
  const input = { name: 'Missing', filePath: 'missing.ts', resolutionReason: 'legacy-secret' };
  const [resolved] = attachGraphNodeIds({ symbols: [input], graph: { nodes: [] } });
  assert.equal(resolved.resolutionReason, 'no-file-node');
  assert.equal(Object.getOwnPropertyDescriptor(resolved, 'resolutionReason').enumerable, false);
  assert.equal(JSON.stringify(resolved).includes('resolutionReason'), false);
});

test('fixture functions and classes resolve across language/path variants with zero null rate', async () => {
  const { resolverReport } = await import('../src/graph-node-resolver.mjs');
  const symbols = [
    { symbolKey: 'ts|src/a.ts|function|exported|load|0', name: 'load', kind: 'function', filePath: 'src/a.ts', range: { startLine: 2 } },
    { symbolKey: 'js|src/b.js|class|exported|Cache|0', name: 'Cache', kind: 'class', filePath: 'src/b.js', range: { startLine: 8 } },
    { symbolKey: 'py|src/c.py|function|local|parse|0', name: 'parse', kind: 'function', filePath: 'src/c.py', range: { startLine: 11 } },
    { symbolKey: 'cs|src/d.cs|class|exported|Worker|0', name: 'Worker', kind: 'class', filePath: 'src/d.cs', range: { startLine: 4 } },
  ];
  const graph = { nodes: [
    { id: 'ts-load', source_file: 'src/a.ts', source_location: 'L2', label: '.load()' },
    { id: 'js-cache', source_file: 'src/b.js', source_location: 'L8', label: 'Cache' },
    { id: 'py-parse', source_file: 'src/c.py', metadata: { source_location: 'L11-L12' }, label: '.parse()' },
    { id: 'cs-worker', source_file: 'src/d.cs', source_location: 'L4', label: 'Worker' },
  ] };
  const report = resolverReport({ symbols, graph });
  assert.equal(report.nullRate, 0);
  assert.deepEqual(report.symbols.map(({ graphNodeId }) => graphNodeId), ['ts-load', 'js-cache', 'py-parse', 'cs-worker']);
});

test('resolution is permutation-independent, does not mutate inputs, and does not fuzzy-match identifiers', () => {
  const symbol = { symbolKey: 'key', name: 'Task', filePath: 'src/a.ts', kind: 'class', graphNodeId: 'stale' };
  const graph = { nodes: [
    { id: 'later', source_file: 'src/a.ts', source_location: 'L20', label: 'Task' },
    { id: 'earlier', source_file: 'src/a.ts', source_location: 'L4', label: 'Task' },
    { id: 'fuzzy', source_file: 'src/a.ts', source_location: 'L5', label: 'task' },
  ] };
  const originalSymbol = structuredClone(symbol);
  const originalGraph = structuredClone(graph);
  const result = attachGraphNodeIds({ symbols: [symbol], graph })[0];
  const permuted = attachGraphNodeIds({ symbols: [symbol], graph: { nodes: [...graph.nodes].reverse() } })[0];
  assert.equal(result.graphNodeId, null);
  assert.equal(result.resolutionReason, 'ambiguous');
  assert.equal(permuted.graphNodeId, result.graphNodeId);
  assert.deepEqual(symbol, originalSymbol);
  assert.deepEqual(graph, originalGraph);
});

test('same-file candidates with no exact label report no-label-match', async () => {
  const { resolverReport } = await import('../src/graph-node-resolver.mjs');
  const report = resolverReport({
    symbols: [{ name: 'Wanted', filePath: 'src/a.ts' }],
    graph: { nodes: [{ id: 'a', source_file: 'src/a.ts', label: 'Other' }] },
  });
  assert.deepEqual(report.reasons, { 'no-file-node': 0, 'no-label-match': 1, ambiguous: 0 });
});
