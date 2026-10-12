import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractSemanticSummary,
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

test('upsertSymbolIndexEntry keeps semanticSummary when provided', () => {
  const index = {};
  const updated = upsertSymbolIndexEntry(index, {
    symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
    memoryId: 'mem_1',
    graphNodeId: 'node-1',
    codeHash: 'hash-1',
    status: 'enriched',
    semanticSummary: 'Fetches a user and normalizes the response.',
  });

  assert.equal(
    updated['ts|src/user.ts|function|exported|getUser|1'].semanticSummary,
    'Fetches a user and normalizes the response.',
  );
});

test('upsertSymbolIndexEntry preserves existing semanticSummary when update omits field', () => {
  const index = {
    'ts|src/user.ts|function|exported|getUser|1': {
      memoryId: 'mem_1',
      graphNodeId: 'node-1',
      codeHash: 'hash-1',
      status: 'enriched',
      lastEnrichedAt: '2026-05-15T12:00:00Z',
      semanticSummary: 'Original summary of user service.',
    },
  };

  const updated = upsertSymbolIndexEntry(index, {
    symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
    memoryId: 'mem_2',
    graphNodeId: 'node-1',
    codeHash: 'hash-2',
    status: 'enriched',
    lastEnrichedAt: '2026-05-16T12:00:00Z',
  });

  assert.equal(
    updated['ts|src/user.ts|function|exported|getUser|1'].semanticSummary,
    'Original summary of user service.',
  );
  assert.equal(updated['ts|src/user.ts|function|exported|getUser|1'].memoryId, 'mem_2');
});

test('upsertSymbolIndexEntry replaces existing semanticSummary with new string', () => {
  const index = {
    'ts|src/user.ts|function|exported|getUser|1': {
      memoryId: 'mem_1',
      codeHash: 'hash-1',
      status: 'enriched',
      semanticSummary: 'Old summary.',
    },
  };

  const updated = upsertSymbolIndexEntry(index, {
    symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
    memoryId: 'mem_1',
    codeHash: 'hash-2',
    status: 'enriched',
    semanticSummary: 'New replacement summary.',
  });

  assert.equal(
    updated['ts|src/user.ts|function|exported|getUser|1'].semanticSummary,
    'New replacement summary.',
  );
});

test('upsertSymbolIndexEntry clears existing semanticSummary when explicitly null', () => {
  const index = {
    'ts|src/user.ts|function|exported|getUser|1': {
      memoryId: 'mem_1',
      codeHash: 'hash-1',
      status: 'enriched',
      semanticSummary: 'Summary to be cleared.',
    },
  };

  const updated = upsertSymbolIndexEntry(index, {
    symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
    memoryId: 'mem_1',
    codeHash: 'hash-1',
    status: 'enriched',
    semanticSummary: null,
  });

  assert.equal(
    updated['ts|src/user.ts|function|exported|getUser|1'].semanticSummary,
    null,
  );
});

test('upsertSymbolIndexEntry normalizes empty or whitespace string to null so it does not mask fallback', () => {
  const index = {};
  const updatedEmpty = upsertSymbolIndexEntry(index, {
    symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
    memoryId: 'mem_1',
    codeHash: 'hash-1',
    status: 'pending',
    semanticSummary: '   ',
  });

  assert.equal(
    updatedEmpty['ts|src/user.ts|function|exported|getUser|1'].semanticSummary,
    null,
  );
});

test('extractSemanticSummary extracts first sentence from markdown heading formats', () => {
  const headingH2 = `
## Responsibility
Handles user authentication and session management. It also validates credentials.

## Inputs
- user: string
`;
  assert.equal(
    extractSemanticSummary(headingH2),
    'Handles user authentication and session management.',
  );

  const headingH3Colon = `
### Responsibility:
Manages distributed locks with Redis leases. Ensures fail-safe release on error.
`;
  assert.equal(
    extractSemanticSummary(headingH3Colon),
    'Manages distributed locks with Redis leases.',
  );
});

test('extractSemanticSummary extracts first sentence from inline bullet formats', () => {
  const bulletBoldColon = `
- **Responsibility**: A concise explanation of what the symbol does. Next sentence here.
- **Primary Inputs**: arg1
`;
  assert.equal(
    extractSemanticSummary(bulletBoldColon),
    'A concise explanation of what the symbol does.',
  );

  const starBulletColon = `
* **Responsibility:** Parses AST nodes into intermediate representations.
* **Output:** AST
`;
  assert.equal(
    extractSemanticSummary(starBulletColon),
    'Parses AST nodes into intermediate representations.',
  );

  const plainBullet = `
- Responsibility: Dispatches events to registered listeners across the channel.
`;
  assert.equal(
    extractSemanticSummary(plainBullet),
    'Dispatches events to registered listeners across the channel.',
  );
});

test('extractSemanticSummary extracts first sentence from plain label formats', () => {
  const plainLabel = `
Symbol: getUser
Kind: function
Language: typescript
Location: src/user.ts:1-10

Responsibility:
Fetches a user and normalizes the API response. It handles auth tokens.

Inputs:
- id: string
`;
  assert.equal(
    extractSemanticSummary(plainLabel),
    'Fetches a user and normalizes the API response.',
  );
});

test('extractSemanticSummary falls back to first sentence of content when no Responsibility section', () => {
  const noResp = 'foo is a function that returns 42. It is called by bar.';
  assert.equal(
    extractSemanticSummary(noResp),
    'foo is a function that returns 42.',
  );

  const markdownTitleNoResp = `
# CacheManager
Coordinates in-memory and disk cache tiers. Evicts expired keys automatically.
`;
  assert.equal(
    extractSemanticSummary(markdownTitleNoResp),
    'Coordinates in-memory and disk cache tiers.',
  );
});

test('extractSemanticSummary caps length at 200 characters', () => {
  const longSentence = 'A'.repeat(250) + '. Second sentence.';
  const content = `## Responsibility\n${longSentence}`;
  const summary = extractSemanticSummary(content);

  assert.ok(summary.length <= 200, `Expected length <= 200, got ${summary.length}`);
  assert.equal(summary, 'A'.repeat(200));
});

test('extractSemanticSummary returns null for empty or whitespace or non-string content', () => {
  assert.equal(extractSemanticSummary(''), null);
  assert.equal(extractSemanticSummary('   \n  \t  '), null);
  assert.equal(extractSemanticSummary(null), null);
  assert.equal(extractSemanticSummary(undefined), null);
});
