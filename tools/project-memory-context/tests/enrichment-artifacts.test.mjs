import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildEnrichmentArtifacts,
  persistEnrichmentArtifacts,
} from '../src/enrichment-artifacts.mjs';
import { ensureProjectMemoryContextDirs, readJsonArtifact } from '../src/artifacts.mjs';

test('buildEnrichmentArtifacts derives memory payload and graph update from a semantic report', () => {
  const artifacts = buildEnrichmentArtifacts({
    projectSlug: 'memory-context',
    job: {
      symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
      graphNodeId: 'node-1',
      codeHash: 'hash-a',
      language: 'ts',
      kind: 'function',
      name: 'getUser',
      filePath: 'src/user.ts',
      range: { startLine: 10, endLine: 20 },
    },
    report: {
      summary: 'Fetches a user and normalizes the response.',
      findings: [
        'responsibility: Fetches a user and normalizes the response.',
        'inputs: id, includePosts',
        'output: Normalized user object or null.',
        'dependencies: api.get, normalizeUser',
        'role: Main retrieval entry point for the module.',
      ],
    },
    memoryId: 'mem_100',
    enrichedAt: '2026-05-15T16:30:00Z',
  });

  assert.equal(artifacts.memoryPayload.category, 'architecture');
  assert.match(artifacts.memoryPayload.content, /Symbol: getUser/);
  assert.equal(artifacts.enrichmentResult.memoryId, 'mem_100');
  assert.equal(artifacts.enrichmentResult.graphNodeId, 'node-1');
  assert.equal(artifacts.semantic.summary, 'Fetches a user and normalizes the response.');
});

test('persistEnrichmentArtifacts writes memory and graph update payloads to disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-enrichment-artifacts-'));
  const dirs = await ensureProjectMemoryContextDirs(root);

  const persisted = await persistEnrichmentArtifacts({
    projectRoot: root,
    projectSlug: 'memory-context',
    job: {
      symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
      graphNodeId: 'node-1',
      codeHash: 'hash-a',
      language: 'ts',
      kind: 'function',
      name: 'getUser',
      filePath: 'src/user.ts',
      range: { startLine: 10, endLine: 20 },
    },
    report: {
      summary: 'Fetches a user and normalizes the response.',
      findings: [
        'responsibility: Fetches a user and normalizes the response.',
        'inputs: id',
        'output: Normalized user object.',
        'dependencies: api.get',
        'role: Main retrieval entry point for the module.',
      ],
    },
    memoryId: 'mem_100',
    enrichedAt: '2026-05-15T16:30:00Z',
  });

  const memoryPayload = await readJsonArtifact(persisted.memoryPayloadFile);
  const enrichmentResult = await readJsonArtifact(persisted.enrichmentResultFile);

  assert.match(memoryPayload.content, /Symbol: getUser/);
  assert.equal(enrichmentResult.memoryId, 'mem_100');
  assert.equal(enrichmentResult.graphNodeId, 'node-1');
  assert.equal(persisted.memoryPayloadFile.startsWith(dirs.enrichment), true);
});

test('persistEnrichmentArtifacts can write a memory payload before memory id exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-memory-only-'));

  const persisted = await persistEnrichmentArtifacts({
    projectRoot: root,
    projectSlug: 'memory-context',
    job: {
      symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
      graphNodeId: 'node-1',
      codeHash: 'hash-a',
      language: 'ts',
      kind: 'function',
      name: 'getUser',
      filePath: 'src/user.ts',
      range: { startLine: 10, endLine: 20 },
    },
    report: {
      summary: 'Fetches a user and normalizes the response.',
      findings: [
        'responsibility: Fetches a user and normalizes the response.',
        'inputs: id',
        'output: Normalized user object.',
        'dependencies: api.get',
        'role: Main retrieval entry point for the module.',
      ],
    },
  });

  assert.equal(typeof persisted.memoryPayloadFile, 'string');
  assert.equal(persisted.enrichmentResultFile, null);
});
