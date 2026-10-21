import test from 'node:test';
import assert from 'node:assert/strict';

import { extractTopLevelSymbols, buildEnrichmentWorklist } from '../src/symbol-extractor.mjs';

test('extractTopLevelSymbols finds exported TypeScript contracts and functions', async () => {
  const code = `
export interface User {
  id: string;
}

export function getUser(id: string, includePosts: boolean) {
  return { id, includePosts };
}
`;

  const symbols = await extractTopLevelSymbols({ filePath: 'src/user.ts', content: code });

  assert.deepEqual(
    symbols.map((symbol) => [symbol.kind, symbol.name, symbol.language]),
    [
      ['interface', 'User', 'ts'],
      ['function', 'getUser', 'ts'],
    ],
  );
});

test('extractTopLevelSymbols finds csharp public types and methods', async () => {
  const code = `
namespace MyApp.Services;

public record User(Guid Id);

public class UserService {
  public Task<User> GetUserAsync(Guid id, CancellationToken token) {
    throw new NotImplementedException();
  }
}
`;

  const symbols = await extractTopLevelSymbols({ filePath: 'Services/UserService.cs', content: code });

  assert.deepEqual(
    symbols.map((symbol) => [symbol.kind, symbol.name, symbol.language]),
    [
      ['record', 'User', 'csharp'],
      ['class', 'UserService', 'csharp'],
      ['method', 'GetUserAsync', 'csharp'],
    ],
  );
});

// ── S1 regressions: buildEnrichmentWorklist acceptance invariant ────────────

test('buildEnrichmentWorklist leaves fresh explicit pending record pending when codeHash matches', () => {
  const symbolKey = 'ts|src/services/user.service.ts|method|member|UserService.findById|1';
  const symbols = [
    {
      symbolKey,
      codeHash: 'abc',
      filePath: 'src/services/user.service.ts',
      name: 'UserService.findById',
    },
  ];
  const symbolIndex = {
    [symbolKey]: {
      codeHash: 'abc',
      status: 'pending',
      memoryId: null,
    },
  };

  const worklist = buildEnrichmentWorklist({ symbols, symbolIndex });
  assert.equal(worklist.length, 1);
  assert.equal(worklist[0].status, 'pending');
  assert.equal(worklist[0].memoryId, null);
});

test('buildEnrichmentWorklist keeps repeated unchanged unenriched records pending', () => {
  const symbolKey = 'ts|src/services/user.service.ts|method|member|UserService.findById|1';
  const symbols = [
    {
      symbolKey,
      codeHash: 'abc',
      filePath: 'src/services/user.service.ts',
      name: 'UserService.findById',
      graphNodeId: 'node-1',
    },
  ];
  const symbolIndex = {
    [symbolKey]: {
      graphNodeId: 'node-1',
      codeHash: 'abc',
      status: 'pending',
      memoryId: null,
      lastEnrichedAt: null,
    },
  };

  const worklist = buildEnrichmentWorklist({ symbols, symbolIndex });
  assert.equal(worklist[0].status, 'pending');
  assert.equal(worklist[0].memoryId, null);
  assert.equal(worklist[0].graphNodeId, 'node-1');
});

test('buildEnrichmentWorklist keeps actually accepted unchanged record enriched', () => {
  const symbolKey = 'ts|src/services/user.service.ts|method|member|UserService.findById|1';
  const symbols = [
    {
      symbolKey,
      codeHash: 'accepted-hash',
      filePath: 'src/services/user.service.ts',
      name: 'UserService.findById',
    },
  ];
  const symbolIndex = {
    [symbolKey]: {
      codeHash: 'accepted-hash',
      status: 'enriched',
      memoryId: 'mem_123',
      semanticSummary: 'Finds a user by id.',
      lastEnrichedAt: '2026-10-01T12:00:00Z',
    },
  };

  const worklist = buildEnrichmentWorklist({ symbols, symbolIndex });
  assert.equal(worklist[0].status, 'enriched');
  assert.equal(worklist[0].memoryId, 'mem_123');
});

test('buildEnrichmentWorklist marks changed source after accepted hash as pending while preserving metadata', () => {
  const symbolKey = 'ts|src/services/user.service.ts|method|member|UserService.findById|1';
  const symbols = [
    {
      symbolKey,
      codeHash: 'new-source-hash',
      filePath: 'src/services/user.service.ts',
      name: 'UserService.findById',
      graphNodeId: 'node-findById',
    },
  ];
  const symbolIndex = {
    [symbolKey]: {
      codeHash: 'old-accepted-hash',
      status: 'enriched',
      memoryId: 'mem_123',
      graphNodeId: 'node-findById',
      semanticSummary: 'Finds a user by id.',
      lastEnrichedAt: '2026-10-01T12:00:00Z',
    },
  };

  const worklist = buildEnrichmentWorklist({ symbols, symbolIndex });
  assert.equal(worklist[0].status, 'pending');
  assert.equal(worklist[0].memoryId, 'mem_123');
  assert.equal(worklist[0].graphNodeId, 'node-findById');
});

test('buildEnrichmentWorklist preserves legacy accepted behavior when status is omitted but memoryId and codeHash match', () => {
  const symbolKey = 'ts|src/user.ts|function|exported|getUser|1';
  const symbols = [
    {
      symbolKey,
      codeHash: 'hash-a',
      graphNodeId: 'node-1',
    },
  ];
  const symbolIndex = {
    [symbolKey]: {
      memoryId: 'mem_1',
      graphNodeId: 'node-1',
      codeHash: 'hash-a',
    },
  };

  const worklist = buildEnrichmentWorklist({ symbols, symbolIndex });
  assert.equal(worklist[0].status, 'enriched');
  assert.equal(worklist[0].memoryId, 'mem_1');
  assert.equal(worklist[0].graphNodeId, 'node-1');
});

test('buildEnrichmentWorklist treats legacy record without memoryId as pending even if codeHash matches', () => {
  const symbolKey = 'ts|src/user.ts|function|exported|getUser|1';
  const symbols = [
    {
      symbolKey,
      codeHash: 'hash-a',
    },
  ];
  const symbolIndex = {
    [symbolKey]: {
      codeHash: 'hash-a',
      memoryId: null,
    },
  };

  const worklist = buildEnrichmentWorklist({ symbols, symbolIndex });
  assert.equal(worklist[0].status, 'pending');
  assert.equal(worklist[0].memoryId, null);
});
