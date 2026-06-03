import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadQueryArtifacts } from '../src/query/load-artifacts.mjs';

async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function createProjectRoot() {
  return mkdtemp(join(tmpdir(), 'pmc-query-artifacts-'));
}

test('loads materialized project-context memories from canonical directory', async () => {
  const projectRoot = await createProjectRoot();
  const pmcRoot = join(projectRoot, '.planning', 'project-memory-context');

  await writeJson(join(pmcRoot, 'project-context', 'materialized', 'stack-runtime.json'), {
    kind: 'stack-runtime',
    title: 'Stack Runtime',
  });
  await writeJson(join(pmcRoot, 'project-context', 'legacy.json'), {
    kind: 'legacy',
    title: 'Legacy Memory',
  });

  const artifacts = await loadQueryArtifacts(projectRoot);

  assert.equal(artifacts.memories.length, 1);
  assert.equal(artifacts.memories[0].kind, 'stack-runtime');
  assert.equal(
    artifacts.memories[0].path,
    join(pmcRoot, 'project-context', 'materialized', 'stack-runtime.json'),
  );
});

test('falls back to legacy project-context directory only when materialized memories are absent', async () => {
  const projectRoot = await createProjectRoot();
  const pmcRoot = join(projectRoot, '.planning', 'project-memory-context');

  await writeJson(join(pmcRoot, 'project-context', 'architecture-current.json'), {
    kind: 'architecture-current',
    title: 'Architecture Current',
  });

  const artifacts = await loadQueryArtifacts(projectRoot);

  assert.equal(artifacts.memories.length, 1);
  assert.equal(artifacts.memories[0].kind, 'architecture-current');
  assert.equal(
    artifacts.memories[0].path,
    join(pmcRoot, 'project-context', 'architecture-current.json'),
  );
});

test('hydrates semantic summaries from graph node metadata when symbol-index lacks them', async () => {
  const projectRoot = await createProjectRoot();
  const pmcRoot = join(projectRoot, '.planning', 'project-memory-context');

  await writeJson(join(pmcRoot, 'enrichment', 'symbol-index.json'), {
    'ts|src/user.ts|function|exported|getUser|1': {
      graphNodeId: 'node-1',
      memoryId: 'mem-1',
      status: 'enriched',
    },
  });
  await writeJson(join(pmcRoot, 'graph', 'graph.json'), {
    nodes: [
      {
        id: 'node-1',
        metadata: {
          semanticSummary: 'Loads a user by id.',
        },
      },
    ],
    edges: [],
  });

  const artifacts = await loadQueryArtifacts(projectRoot);

  assert.deepEqual(artifacts.symbols, [
    {
      symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
      filePath: 'src/user.ts',
      name: 'getUser',
      graphNodeId: 'node-1',
      memoryId: 'mem-1',
      status: 'enriched',
      semanticSummary: 'Loads a user by id.',
    },
  ]);
});

test('normalizes graph relationships from either edges or links', async () => {
  const projectRoot = await createProjectRoot();
  const pmcRoot = join(projectRoot, '.planning', 'project-memory-context');

  const edgesGraph = {
    nodes: [{ id: 'a' }, { id: 'b' }],
    edges: [{ source: 'a', target: 'b', relation: 'calls' }],
  };
  await writeJson(join(pmcRoot, 'graph', 'graph.json'), edgesGraph);

  let artifacts = await loadQueryArtifacts(projectRoot);
  assert.deepEqual(artifacts.nodes, edgesGraph.nodes);
  assert.deepEqual(artifacts.edges, edgesGraph.edges);

  await writeJson(join(pmcRoot, 'graph', 'graph.json'), {
    nodes: [{ id: 'x' }, { id: 'y' }],
    links: [{ source: 'x', target: 'y', relation: 'imports' }],
  });

  artifacts = await loadQueryArtifacts(projectRoot);
  assert.deepEqual(artifacts.nodes, [{ id: 'x' }, { id: 'y' }]);
  assert.deepEqual(artifacts.edges, [{ source: 'x', target: 'y', relation: 'imports' }]);
});

test('throws on malformed JSON artifacts instead of treating them as empty state', async () => {
  const projectRoot = await createProjectRoot();
  const pmcRoot = join(projectRoot, '.planning', 'project-memory-context');

  await mkdir(join(pmcRoot, 'graph'), { recursive: true });
  await writeFile(join(pmcRoot, 'graph', 'graph.json'), '{ bad json\n', 'utf8');

  await assert.rejects(
    loadQueryArtifacts(projectRoot),
    /Unexpected token|Expected property name|JSON/i,
  );
});

test('missing files return empty arrays and safe defaults', async () => {
  const projectRoot = await createProjectRoot();

  const artifacts = await loadQueryArtifacts(projectRoot);

  assert.deepEqual(artifacts, {
    memories: [],
    symbols: [],
    nodes: [],
    edges: [],
  });
});
