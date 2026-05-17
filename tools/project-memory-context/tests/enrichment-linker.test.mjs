import test from 'node:test';
import assert from 'node:assert/strict';

import { applyEnrichmentResult } from '../src/enrichment-linker.mjs';

test('applyEnrichmentResult updates both graph and symbol index for bidirectional lookup', () => {
  const graph = {
    nodes: [
      {
        id: 'node-1',
        label: 'getUser',
        metadata: {
          symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
        },
      },
    ],
  };

  const { graph: updatedGraph, symbolIndex } = applyEnrichmentResult({
    graph,
    symbolIndex: {},
    result: {
      symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
      graphNodeId: 'node-1',
      memoryId: 'mem_999',
      codeHash: 'hash-z',
      semanticSummary: 'Fetches a user and normalizes the response.',
      status: 'enriched',
      enrichedAt: '2026-05-15T13:00:00Z',
    },
  });

  assert.equal(updatedGraph.nodes[0].metadata.memoryId, 'mem_999');
  assert.equal(updatedGraph.nodes[0].metadata.graphNodeId, 'node-1');
  assert.deepEqual(symbolIndex['ts|src/user.ts|function|exported|getUser|1'], {
    memoryId: 'mem_999',
    graphNodeId: 'node-1',
    codeHash: 'hash-z',
    status: 'enriched',
    lastEnrichedAt: '2026-05-15T13:00:00Z',
  });
});
