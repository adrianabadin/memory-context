import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEnrichmentWorklist } from '../src/symbol-extractor.mjs';

test('buildEnrichmentWorklist marks known symbols as enriched when hashes match', () => {
  const worklist = buildEnrichmentWorklist({
    symbols: [
      {
        symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
        codeHash: 'hash-a',
        graphNodeId: 'node-1',
      },
    ],
    symbolIndex: {
      'ts|src/user.ts|function|exported|getUser|1': {
        memoryId: 'mem_1',
        graphNodeId: 'node-1',
        codeHash: 'hash-a',
      },
    },
  });

  assert.equal(worklist[0].status, 'enriched');
  assert.equal(worklist[0].memoryId, 'mem_1');
  assert.equal(worklist[0].graphNodeId, 'node-1');
});
