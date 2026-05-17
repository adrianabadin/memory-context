import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ensureProjectMemoryContextDirs,
  readJsonArtifact,
  writeJsonArtifact,
} from '../src/artifacts.mjs';
import { finalizeEnrichment } from '../src/finalize-enrichment.mjs';

test('finalizeEnrichment updates graph, symbol index, and worklist together', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-finalize-'));
  const dirs = await ensureProjectMemoryContextDirs(root);

  await writeJsonArtifact(join(dirs.graph, 'graph.json'), {
    nodes: [
      {
        id: 'node-1',
        metadata: {
          symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
        },
      },
    ],
    edges: [],
  });
  await writeJsonArtifact(join(dirs.enrichment, 'symbol-index.json'), {});
  await writeJsonArtifact(join(dirs.enrichment, 'worklist.json'), [
    {
      symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
      graphNodeId: 'node-1',
      codeHash: 'hash-a',
      status: 'pending',
      memoryId: null,
    },
  ]);

  await finalizeEnrichment({
    projectRoot: root,
    result: {
      symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
      graphNodeId: 'node-1',
      memoryId: 'mem_123',
      codeHash: 'hash-a',
      semanticSummary: 'Fetches a user and normalizes the response.',
      status: 'enriched',
      enrichedAt: '2026-05-15T18:00:00Z',
    },
  });

  const graph = await readJsonArtifact(join(dirs.graph, 'graph.json'));
  const index = await readJsonArtifact(join(dirs.enrichment, 'symbol-index.json'));
  const worklist = await readJsonArtifact(join(dirs.enrichment, 'worklist.json'));

  assert.equal(graph.nodes[0].metadata.memoryId, 'mem_123');
  assert.equal(index['ts|src/user.ts|function|exported|getUser|1'].memoryId, 'mem_123');
  assert.equal(worklist[0].status, 'enriched');
  assert.equal(worklist[0].memoryId, 'mem_123');
});
