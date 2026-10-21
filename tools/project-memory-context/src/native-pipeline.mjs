import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';

import {
  ensureProjectMemoryContextDirs,
  readJsonArtifact,
  writeJsonArtifact,
} from './artifacts.mjs';
import { shouldIgnoreDir, isGraphifyScope } from './walk-ignores.mjs';
import { extractTopLevelSymbols, buildEnrichmentWorklist } from './symbol-extractor.mjs';
import { extractNativeCalls } from './relations/native-calls.mjs';
import { extractNativeImportBindings } from './relations/native-import-bindings.mjs';
import { attachGraphNodeIds } from './graph-node-resolver.mjs';
import { backfillGraphNode } from './graph-backfill.mjs';
import { openGraphDb } from './graph-store/graph-db.mjs';
import { classifySymbol, loadProfile } from './roles/classify.mjs';
import { loadProjectProfile } from './roles/profile-loader.mjs';
import { upsertSymbolIndexEntry } from './symbol-index.mjs';
import { hashSymbol } from './hash.mjs';

const ELIGIBLE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cs'];

function findSourceFiles(dir, projectRoot) {
  const results = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === '.opencode' || shouldIgnoreDir(entry.name)) continue;
        results.push(...findSourceFiles(resolve(dir, entry.name), projectRoot));
      } else if (entry.isFile()) {
        if (isGraphifyScope(entry.name)) continue;
        const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
        if (ELIGIBLE_EXTS.includes(ext)) {
          const rel = relative(projectRoot, resolve(dir, entry.name)).replace(/\\/g, '/');
          results.push(rel);
        }
      }
    }
  } catch {
    // skip inaccessible directories
  }
  return results;
}

function hashCodeFragment(content, startLine, endLine) {
  return hashSymbol(content.split('\n').slice(startLine - 1, endLine).join('\n'));
}

function endpointMatchesNode(store, endpoint) {
  const nodes = store.getNodesByFile(endpoint.path);
  const matching = nodes.filter((node) => {
    const meta = typeof node.metadata === 'object' && node.metadata !== null ? node.metadata : {};
    const keys = [meta.symbolKey, node.symbolKey].filter((k) => k !== undefined);
    if (keys.some((k) => k !== endpoint.id)) return false;
    if (endpoint.kind === 'file') {
      return node.node_kind === 'file' && (node.label ?? '').replace(/\\/g, '/') === endpoint.path;
    }
    return (keys.length > 0 || node.id === endpoint.id) &&
      (node.kind === null || node.kind === endpoint.kind) &&
      (node.node_kind === 'symbol' || node.node_kind === 'member');
  });
  return matching.length === 1;
}

/**
 * Shared native-pipeline helper appropriate for bootstrap/build-worklist
 * and refresh-context. Materializes canonical identities, native calls/import
 * bindings, deterministic roles, and symbol index from actual source files.
 *
 * Preserves Graphify graph, unrelated accepted enrichment, and fail closed
 * on ambiguous identities.
 */
export async function executeNativePipeline({
  projectRoot,
  files,
  dirs: callerDirs,
  graph,
  profile,
  replace = true,
  log = () => {},
} = {}) {
  if (!projectRoot) {
    throw new TypeError('executeNativePipeline requires a projectRoot');
  }

  const root = resolve(projectRoot);
  const dirs = callerDirs ?? (await ensureProjectMemoryContextDirs(root));

  // 1. Discover or use provided eligible source files
  const fileList = Array.isArray(files) && files.length > 0
    ? files.map((f) => relative(root, resolve(root, f)).replace(/\\/g, '/'))
    : findSourceFiles(root, root);

  const sourceFiles = [];
  for (const relPath of fileList) {
    try {
      const fullPath = resolve(root, relPath);
      const content = await readFile(fullPath, 'utf8');
      sourceFiles.push({ path: relPath, content });
    } catch {
      // skip unreadable
    }
  }

  // 2. Extract AST symbols for each file
  const symbols = [];
  for (const file of sourceFiles) {
    const fileSymbols = await extractTopLevelSymbols({ filePath: file.path, content: file.content });
    for (const sym of fileSymbols) {
      if (!sym.codeHash && sym.range?.startLine && sym.range?.endLine) {
        sym.codeHash = await hashCodeFragment(file.content, sym.range.startLine, sym.range.endLine);
      }
    }
    symbols.push(...fileSymbols);
  }

  // 3. Extract native calls and import bindings
  const calls = await extractNativeCalls({ files: sourceFiles });
  const importBindings = await extractNativeImportBindings({ files: sourceFiles });

  // 4. Canonical identity matching with Graphify graph
  const graphJsonPath = resolve(dirs.graph, 'graph.json');
  let graphData = graph ?? (await readJsonArtifact(graphJsonPath, { nodes: [], links: [] }));
  if (!Array.isArray(graphData.nodes)) graphData.nodes = [];
  if (!Array.isArray(graphData.links) && !Array.isArray(graphData.edges)) graphData.links = [];

  // When no existing graph nodes are present (e.g. Graphify skipped), seed canonical nodes from symbols
  if (graphData.nodes.length === 0) {
    for (const sym of symbols) {
      graphData.nodes.push({
        id: sym.symbolKey,
        label: sym.name,
        kind: sym.kind,
        node_kind: sym.kind === 'method' && sym.container ? 'member' : 'symbol',
        source_file: sym.filePath,
        source_location: `L${sym.range?.startLine ?? 1}`,
        metadata: {
          symbolKey: sym.symbolKey,
          codeHash: sym.codeHash,
          status: 'pending',
        },
      });
    }
  }

  const resolvedSymbols = attachGraphNodeIds({ symbols, graph: graphData });

  const symbolIndexPath = resolve(dirs.enrichment, 'symbol-index.json');
  const existingIndex = await readJsonArtifact(symbolIndexPath, {});

  for (const sym of resolvedSymbols) {
    if (sym.graphNodeId) {
      const existingEntry = existingIndex[sym.symbolKey];
      graphData = backfillGraphNode({
        graph: graphData,
        symbolKey: sym.symbolKey,
        graphNodeId: sym.graphNodeId,
        codeHash: sym.codeHash,
        memoryId: existingEntry?.memoryId ?? null,
        semanticSummary: existingEntry?.semanticSummary ?? null,
        status: existingEntry?.status ?? 'pending',
        enrichedAt: existingEntry?.lastEnrichedAt ?? null,
      });
    }
  }

  // Write graph.json preserving links/edges
  await writeJsonArtifact(graphJsonPath, graphData);

  // 5. GraphStore SQLite persistence
  const graphDbPath = resolve(dirs.graph, 'graph.db');
  let store;
  try {
    store = openGraphDb(graphDbPath, graphJsonPath);

    // Persist native relations (combined calls and import bindings)
    const combinedRelations = {
      relations: [...calls.relations, ...importBindings.relations],
      unresolved: [...calls.unresolved, ...importBindings.unresolved],
    };
    store.persistNativeRelations(combinedRelations, { replace });

    // Persist deterministic node roles
    let projectProfile = profile;
    if (!projectProfile) {
      try {
        projectProfile = await loadProjectProfile(root, { profileName: 'generic' });
      } catch {
        projectProfile = loadProfile('generic');
      }
    }

    if (replace) {
      store.clearNodeRoles?.();
    }

    const assignments = [];
    for (const endpoint of calls.symbols) {
      const record = symbols.find((s) => s.symbolKey === endpoint.symbolKey);
      const symbolRecord = record ?? {
        name: endpoint.id.split('|')[4],
        kind: endpoint.kind,
        filePath: endpoint.path,
      };
      const classification = classifySymbol(symbolRecord, {
        profile: projectProfile,
        allSymbols: symbols,
      });

      if (endpointMatchesNode(store, endpoint)) {
        assignments.push({ endpoint, classification });
      }
    }

    if (assignments.length > 0) {
      store.persistNodeRoles(assignments, { profile: projectProfile });
    }
  } catch (err) {
    log(`graph.db persistence error: ${err.message}`);
  } finally {
    try {
      store?.close();
    } catch {
      // ignore close errors
    }
  }

  // 6. Update symbol-index.json
  let updatedIndex = { ...existingIndex };
  const currentKeys = new Set(resolvedSymbols.map((s) => s.symbolKey));

  for (const sym of resolvedSymbols) {
    const existing = updatedIndex[sym.symbolKey];
    let status = 'pending';
    if (existing?.status === 'enriched' || (existing?.status === undefined && existing?.memoryId)) {
      status = (existing.codeHash && existing.codeHash === sym.codeHash) ? 'enriched' : 'pending';
    } else if (existing?.status) {
      status = existing.status;
    }

    updatedIndex = upsertSymbolIndexEntry(updatedIndex, {
      symbolKey: sym.symbolKey,
      graphNodeId: sym.graphNodeId ?? existing?.graphNodeId ?? null,
      codeHash: sym.codeHash,
      status,
      memoryId: existing?.memoryId ?? null,
      semanticSummary: existing?.semanticSummary,
      lastEnrichedAt: existing?.lastEnrichedAt ?? null,
      narrativeHash: existing?.narrativeHash,
      calleeSummaryHashes: existing?.calleeSummaryHashes,
      promptVersion: existing?.promptVersion,
    });
  }

  // Prune removed symbols if replace is requested
  if (replace) {
    for (const key of Object.keys(updatedIndex)) {
      if (!currentKeys.has(key)) {
        delete updatedIndex[key];
      }
    }
  }

  await writeJsonArtifact(symbolIndexPath, updatedIndex);

  // 7. Update worklist.json
  const worklist = buildEnrichmentWorklist({
    symbols: resolvedSymbols,
    symbolIndex: updatedIndex,
  });
  const worklistPath = resolve(dirs.enrichment, 'worklist.json');
  await writeJsonArtifact(worklistPath, worklist);

  return {
    symbols,
    resolvedSymbols,
    calls,
    importBindings,
    graph: graphData,
    symbolIndex: updatedIndex,
    worklist,
  };
}
