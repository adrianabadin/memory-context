import test from 'node:test';
import assert from 'node:assert/strict';

import { backfillGraphNode } from '../src/graph-backfill.mjs';

test('backfillGraphNode updates the matching node and preserves unrelated data', () => {
  const graph = {
    nodes: [
      {
        id: 'node-1',
        label: 'getUser',
        metadata: {
          symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
          other: 'keep-me',
        },
      },
      {
        id: 'node-2',
        label: 'Other',
        metadata: {
          symbolKey: 'ts|src/other.ts|function|exported|other|0',
        },
      },
    ],
  };

  const updated = backfillGraphNode({
    graph,
    symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
    memoryId: 'mem_123',
    semanticSummary: 'Loads a user by id.',
    codeHash: 'hash-a',
    enrichedAt: '2026-05-15T12:00:00Z',
    status: 'enriched',
  });

  assert.equal(updated.nodes[0].metadata.memoryId, 'mem_123');
  assert.equal(updated.nodes[0].metadata.semanticSummary, 'Loads a user by id.');
  assert.equal(updated.nodes[0].metadata.other, 'keep-me');
  assert.equal(updated.nodes[1].metadata.memoryId, undefined);
});
