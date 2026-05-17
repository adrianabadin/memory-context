import { join } from 'node:path';

import {
  ensureProjectMemoryContextDirs,
  readJsonArtifact,
  writeJsonArtifact,
} from './artifacts.mjs';
import { applyEnrichmentResult } from './enrichment-linker.mjs';

export async function persistEnrichmentResult({ projectRoot, result }) {
  const dirs = await ensureProjectMemoryContextDirs(projectRoot);
  const graphFile = join(dirs.graph, 'graph.json');
  const indexFile = join(dirs.enrichment, 'symbol-index.json');

  const graph = await readJsonArtifact(graphFile, { nodes: [], edges: [] });
  const symbolIndex = await readJsonArtifact(indexFile, {});

  const updated = applyEnrichmentResult({
    graph,
    symbolIndex,
    result,
  });

  await writeJsonArtifact(graphFile, updated.graph);
  await writeJsonArtifact(indexFile, updated.symbolIndex);

  return {
    graphFile,
    indexFile,
    graph: updated.graph,
    symbolIndex: updated.symbolIndex,
  };
}
