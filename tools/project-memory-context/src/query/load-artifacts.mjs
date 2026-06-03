import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

function normalizePath(filePath) {
  return String(filePath ?? '').replace(/\\/g, '/');
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function readJsonDirectory(directoryPath) {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function loadMemories(projectContextDir) {
  const materializedDir = join(projectContextDir, 'materialized');
  const materializedEntries = await readJsonDirectory(materializedDir);
  const directory = materializedEntries.length > 0 ? materializedDir : projectContextDir;
  const fileNames = materializedEntries.length > 0
    ? materializedEntries
    : await readJsonDirectory(projectContextDir);

  const memories = [];
  for (const fileName of fileNames) {
    const path = join(directory, fileName);
    const memory = await readJson(path, null);
    if (memory) {
      memories.push({ ...memory, path });
    }
  }

  return memories;
}

function parseSymbol(symbolKey, entry, semanticSummary) {
  const parts = String(symbolKey ?? '').split('|');
  return {
    symbolKey,
    filePath: parts.length >= 2 ? normalizePath(parts[1]) : '',
    name: parts.length >= 2 ? parts[parts.length - 2] : '',
    graphNodeId: entry?.graphNodeId ?? null,
    memoryId: entry?.memoryId ?? null,
    status: entry?.status ?? null,
    semanticSummary,
  };
}

export async function loadQueryArtifacts(projectRoot) {
  const pmcRoot = join(projectRoot, '.planning', 'project-memory-context');
  const projectContextDir = join(pmcRoot, 'project-context');
  const symbolIndexPath = join(pmcRoot, 'enrichment', 'symbol-index.json');
  const graphPath = join(pmcRoot, 'graph', 'graph.json');

  const memories = await loadMemories(projectContextDir);
  const symbolIndex = await readJson(symbolIndexPath, {});
  const graph = await readJson(graphPath, {});
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? graph.links ?? [];

  const nodeById = new Map(nodes.map((node) => [node?.id, node]));
  const symbols = Object.entries(symbolIndex).map(([symbolKey, entry]) => {
    const semanticSummary = String(
      entry?.semanticSummary
      ?? nodeById.get(entry?.graphNodeId)?.metadata?.semanticSummary
      ?? '',
    ).trim();

    return parseSymbol(symbolKey, entry, semanticSummary);
  });

  return {
    memories,
    symbols,
    nodes,
    edges,
  };
}
