import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findGraphNodeIdByMemoryId,
  findMemoryIdByGraphNodeId,
  upsertSymbolIndexEntry,
} from '../src/symbol-index.mjs';

test('upsertSymbolIndexEntry replaces an existing symbol record by key', () => {
  const index = {
    'ts|src/user.ts|function|exported|getUser|1': {
      memoryId: 'mem_old',
      codeHash: 'old-hash',
      status: 'pending',
    },
  };

  const updated = upsertSymbolIndexEntry(index, {
    symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
    memoryId: 'mem_new',
    graphNodeId: 'node-42',
    codeHash: 'new-hash',
    status: 'enriched',
    lastEnrichedAt: '2026-05-15T12:00:00Z',
  });

  assert.deepEqual(updated['ts|src/user.ts|function|exported|getUser|1'], {
    memoryId: 'mem_new',
    graphNodeId: 'node-42',
    codeHash: 'new-hash',
    status: 'enriched',
    lastEnrichedAt: '2026-05-15T12:00:00Z',
  });
});

test('symbol index resolves graph node ids and memory ids bidirectionally', () => {
  const index = {
    'ts|src/user.ts|function|exported|getUser|1': {
      memoryId: 'mem_123',
      graphNodeId: 'node-1',
      codeHash: 'hash-a',
      status: 'enriched',
      lastEnrichedAt: '2026-05-15T12:00:00Z',
    },
  };

  assert.equal(findGraphNodeIdByMemoryId(index, 'mem_123'), 'node-1');
  assert.equal(findMemoryIdByGraphNodeId(index, 'node-1'), 'mem_123');
  assert.equal(findGraphNodeIdByMemoryId(index, 'missing'), null);
  assert.equal(findMemoryIdByGraphNodeId(index, 'missing'), null);
});
