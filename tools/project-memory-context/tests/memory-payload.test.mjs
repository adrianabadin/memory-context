import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEnrichmentResult, buildMemoryPayload } from '../src/memory-payload.mjs';

test('buildMemoryPayload formats semantic fields into searchable memory content', () => {
  const payload = buildMemoryPayload({
    projectSlug: 'memory-context',
    job: {
      symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
      language: 'ts',
      kind: 'function',
      name: 'getUser',
      filePath: 'src/user.ts',
      range: { startLine: 10, endLine: 20 },
    },
    semantic: {
      responsibility: 'Fetches a user and normalizes the API response.',
      inputs: ['id: user identifier'],
      output: 'Normalized user object or null.',
      dependencies: ['api.get', 'normalizeUser'],
      role: 'Main user retrieval entry point for the module.',
    },
  });

  assert.equal(payload.category, 'architecture');
  assert.match(payload.content, /Symbol: getUser/);
  assert.match(payload.content, /Responsibility:/);
  assert.match(payload.content, /api.get/);
  assert.ok(payload.tags.includes('symbol'));
  assert.ok(payload.tags.includes('project:memory-context'));
});

test('buildEnrichmentResult derives graph update payload from job and memory id', () => {
  const result = buildEnrichmentResult({
    job: {
      symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
      graphNodeId: 'node-1',
      codeHash: 'hash-a',
    },
    memoryId: 'mem_101',
    semanticSummary: 'Fetches a user and normalizes the API response.',
    status: 'enriched',
    enrichedAt: '2026-05-15T16:00:00Z',
  });

  assert.deepEqual(result, {
    symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
    graphNodeId: 'node-1',
    memoryId: 'mem_101',
    codeHash: 'hash-a',
    semanticSummary: 'Fetches a user and normalizes the API response.',
    status: 'enriched',
    enrichedAt: '2026-05-15T16:00:00Z',
  });
});
