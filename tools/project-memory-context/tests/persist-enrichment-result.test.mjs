import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ensureProjectMemoryContextDirs, readJsonArtifact, writeJsonArtifact } from '../src/artifacts.mjs';
import { persistEnrichmentResult } from '../src/persist-enrichment-result.mjs';

test('persistEnrichmentResult writes updated graph and symbol index artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-persist-'));
  const dirs = await ensureProjectMemoryContextDirs(root);
  const graphFile = join(dirs.graph, 'graph.json');
  const indexFile = join(dirs.enrichment, 'symbol-index.json');

  await writeJsonArtifact(graphFile, {
    nodes: [
      {
        id: 'node-1',
        metadata: {
          symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
        },
      },
    ],
  });
  await writeJsonArtifact(indexFile, {});

  await persistEnrichmentResult({
    projectRoot: root,
    result: {
      symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
      graphNodeId: 'node-1',
      memoryId: 'mem_100',
      codeHash: 'hash-100',
      semanticSummary: 'Fetches a user.',
      status: 'enriched',
      enrichedAt: '2026-05-15T14:00:00Z',
    },
  });

  const graph = await readJsonArtifact(graphFile);
  const index = await readJsonArtifact(indexFile);

  assert.equal(graph.nodes[0].metadata.memoryId, 'mem_100');
  assert.equal(index['ts|src/user.ts|function|exported|getUser|1'].graphNodeId, 'node-1');
  assert.equal(index['ts|src/user.ts|function|exported|getUser|1'].memoryId, 'mem_100');
});
