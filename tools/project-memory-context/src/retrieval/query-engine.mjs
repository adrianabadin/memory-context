// src/retrieval/query-engine.mjs
import { createInMemoryGraphStore } from '../graph-store/in-memory-graph.mjs';
import { withLockRetry } from './lock-retry.mjs';

const DEPTH_PRESETS = {
  compact:  { maxHops: 1, includeCommunity: false, maxTokens: 2000,  readSourceFiles: false },
  extended: { maxHops: 2, includeCommunity: true,  maxTokens: 5000,  readSourceFiles: false },
  deep:     { maxHops: 3, includeCommunity: true,  maxTokens: 10000, readSourceFiles: false },
  disk:     { maxHops: 3, includeCommunity: true,  maxTokens: 15000, readSourceFiles: true  },
};

export function createDepthConfig(depth) {
  const preset = DEPTH_PRESETS[depth] ?? DEPTH_PRESETS.compact;
  return { ...preset };
}

function parseSymbolKeyParts(key) { return key.split('|'); }
function extractName(parts)      { return parts.length >= 5 ? parts[parts.length - 2] : null; }
function extractFilePath(parts)  { return parts.length >= 2 ? parts[1] : null; }
function normalizePath(filePath) { return String(filePath ?? '').replace(/\\/g, '/'); }

export function focusToEdgeTypes(focus) {
  const map = {
    dependencies: ['imports', 'imports_from'],
    callers:      ['calls'],
    containment:  ['contains', 'method'],
  };
  return map[focus] ?? ['calls', 'imports', 'imports_from', 'contains', 'method'];
}

export function createQueryEngine({ graphStore, graph, symbolIndex, worklist, enrichmentDir, projectSlug, memoryStore }) {
  // Backward-compat: if old `graph` object passed, auto-wrap in InMemoryGraphStore.
  const store = graphStore ?? createInMemoryGraphStore(graph ?? { nodes: [], links: [] });

  // ── Symbol index maps (built from symbolIndex — unchanged from v1) ──────────
  const graphNodeIdToSymbolKeyMap = new Map();
  const nameToSymbolKeys          = new Map();
  const filePathToSymbolKeys      = new Map();

  for (const key of Object.keys(symbolIndex ?? {})) {
    const entry = symbolIndex[key];
    if (entry.graphNodeId) graphNodeIdToSymbolKeyMap.set(entry.graphNodeId, key);

    const parts = parseSymbolKeyParts(key);
    const name = extractName(parts);
    if (name) {
      const arr = nameToSymbolKeys.get(name);
      if (arr) arr.push(key); else nameToSymbolKeys.set(name, [key]);
    }

    const fp = extractFilePath(parts);
    if (fp) {
      const normalized = normalizePath(fp);
      const arr = filePathToSymbolKeys.get(normalized);
      if (arr) arr.push(key); else filePathToSymbolKeys.set(normalized, [key]);
    }
  }

  // ── Traversal (delegates to store) ─────────────────────────────────────────
  function traverseGraph({ nodeIds, maxHops, edgeTypes, direction }) {
    const types = edgeTypes ?? ['calls', 'imports', 'imports_from', 'contains', 'method'];
    const dir = direction ?? 'outbound';
    return store.traverse({ nodeIds, maxHops, edgeTypes: types, direction: dir });
  }

  function resolveWorklistEntry(symbolKey) {
    return (worklist ?? []).find((e) => e.symbolKey === symbolKey) ?? null;
  }

  async function fetchLinkedMemories(symbolKey) {
    if (!memoryStore?.getBySymbol) return [];
    try {
      const rows = await withLockRetry(
        () => memoryStore.getBySymbol(symbolKey, { sources: ['memory'], limit: 10 }),
        { maxAttempts: 3, baseDelay: 100, staleFallback: [] },
      );
      return rows.map(r => ({ id: r.id, content: r.content, type: r.source, scope: 'project' }));
    } catch {
      return [];
    }
  }

  async function buildSymbolInfo(symbolKey) {
    const entry = (symbolIndex ?? {})[symbolKey];
    const wl    = resolveWorklistEntry(symbolKey);
    const parts = parseSymbolKeyParts(symbolKey);
    const linkedMemories = await fetchLinkedMemories(symbolKey);
    return {
      symbolKey,
      name:        wl?.name      ?? extractName(parts),
      filePath:    wl?.filePath  ?? extractFilePath(parts),
      kind:        wl?.kind      ?? null,
      range:       wl?.range     ?? null,
      codeHash:    wl?.codeHash  ?? null,
      graphNodeId: entry?.graphNodeId ?? null,
      memoryId:    entry?.memoryId    ?? null,
      status:      entry?.status      ?? null,
      linkedMemories,
    };
  }

  async function querySymbolContext({ symbolKey, depth }) {
    const config = createDepthConfig(depth);
    const target = await buildSymbolInfo(symbolKey);
    if (!target.graphNodeId) return { target, neighbors: [], edges: [], depth_reached: 0 };

    const traversal = traverseGraph({ nodeIds: [target.graphNodeId], maxHops: config.maxHops });
    const neighbors = [];
    for (const n of traversal.nodes) {
      if (n.id === target.graphNodeId) continue;
      const sk = graphNodeIdToSymbolKeyMap.get(n.id);
      if (sk) {
        neighbors.push(await buildSymbolInfo(sk));
      } else {
        neighbors.push({ graphNodeId: n.id, label: n.label, sourceFile: n.source_file ?? null, symbolKey: null });
      }
    }
    return { target, neighbors, edges: traversal.edges, depth_reached: traversal.depth_reached };
  }

  async function queryFileContext({ filePath, depth }) {
    const config      = createDepthConfig(depth);
    const normalized  = normalizePath(filePath);
    const symbolKeys  = filePathToSymbolKeys.get(normalized) ?? [];
    const symbols     = [];
    for (const sk of symbolKeys) {
      symbols.push(await buildSymbolInfo(sk));
    }
    const fileNodeIds = store.getNodesByFile(normalized).map((n) => n.id);

    const outTraversal = traverseGraph({ nodeIds: fileNodeIds, maxHops: config.maxHops });
    const inTraversal  = traverseGraph({ nodeIds: fileNodeIds, maxHops: config.maxHops, direction: 'inbound' });

    const fileNodeIdSet = new Set(fileNodeIds);
    const seen      = new Set();
    const neighbors = [];
    const edges     = [];

    for (const n of [...outTraversal.nodes, ...inTraversal.nodes]) {
      if (fileNodeIdSet.has(n.id) || seen.has(n.id)) continue;
      seen.add(n.id);
      const sk = graphNodeIdToSymbolKeyMap.get(n.id);
      if (sk) {
        neighbors.push(await buildSymbolInfo(sk));
      } else {
        neighbors.push({ graphNodeId: n.id, label: n.label, sourceFile: n.source_file ?? null, symbolKey: null });
      }
    }

    const edgeSet = new Set();
    for (const e of [...outTraversal.edges, ...inTraversal.edges]) {
      const key = `${e.source}->${e.target}`;
      if (!edgeSet.has(key)) { edgeSet.add(key); edges.push(e); }
    }

    const depth_reached = Math.max(outTraversal.depth_reached, inTraversal.depth_reached);
    return { symbols, neighbors, edges, depth_reached };
  }

  async function queryImpactScope({ symbolKeys, depth }) {
    const config      = createDepthConfig(depth);
    const targets     = [];
    for (const sk of symbolKeys) {
      targets.push(await buildSymbolInfo(sk));
    }
    const nodeIds     = targets.map((t) => t.graphNodeId).filter(Boolean);
    const traversal   = traverseGraph({ nodeIds, maxHops: config.maxHops, direction: 'inbound' });
    const targetIdSet = new Set(nodeIds);
    const dependents  = [];
    for (const n of traversal.nodes) {
      if (targetIdSet.has(n.id)) continue;
      const sk = graphNodeIdToSymbolKeyMap.get(n.id);
      if (sk) {
        dependents.push(await buildSymbolInfo(sk));
      } else {
        dependents.push({ graphNodeId: n.id, label: n.label, sourceFile: n.source_file ?? null, symbolKey: null });
      }
    }
    return {
      target:        targets.length === 1 ? targets[0] : targets,
      dependents,
      edges:         traversal.edges,
      depth_reached: traversal.depth_reached,
    };
  }

  return {
    graphNodeIdToSymbolKey(graphNodeId) { return graphNodeIdToSymbolKeyMap.get(graphNodeId) ?? null; },
    findSymbolKeyByName(name)           { return nameToSymbolKeys.get(name) ?? []; },
    findSymbolKeysByFilePath(filePath)  { return filePathToSymbolKeys.get(normalizePath(filePath)) ?? []; },
    traverseGraph,
    querySymbolContext,
    queryFileContext,
    queryImpactScope,
  };
}
