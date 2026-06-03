import test from 'node:test';
import assert from 'node:assert/strict';

import { attachGraphNodeIds } from '../src/graph-node-resolver.mjs';

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

test('attachGraphNodeIds falls back to norm_label when label does not match', () => {
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
  assert.equal(resolved[0].graphNodeId, 'src_app_mycomponent');
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

test('attachGraphNodeIds preserves existing graphNodeId when no graph match', () => {
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
  assert.equal(resolved[0].graphNodeId, 'pre-existing-id');
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
