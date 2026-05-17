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

test('attachGraphNodeIds falls back to file path and label matching when symbol key is absent', () => {
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
        id: 'node-2',
        label: 'getUser',
        metadata: {
          filePath: 'src/user.ts',
          kind: 'function',
        },
      },
    ],
  };

  const resolved = attachGraphNodeIds({ symbols, graph });
  assert.equal(resolved[0].graphNodeId, 'node-2');
});
