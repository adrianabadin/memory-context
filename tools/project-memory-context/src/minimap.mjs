/**
 * buildMinimapChunk — pure builder for the module-level navigation map.
 *
 * Consumes pre-loaded graph and analysis data (no I/O) and returns a
 * project-context memory chunk that can be written via writeMemories()
 * and synced to agent-memory through the existing sync-manifest pipeline.
 *
 * Design constraints:
 *  - body must stay under ~2 KB so it fits comfortably in autostart context.
 *  - No I/O: all data is passed in by the caller.
 *  - Graceful: returns null when graph is empty or missing.
 */

import { createMaterializedProjectContext } from './project-context-schema.mjs';

/** Edges that represent import/re-export relationships at module level. */
const IMPORT_EDGE_TYPES = new Set(['imports', 'imports_from', 're_exports']);

/** Max modules to list in the "key modules" section. */
const MAX_KEY_MODULES = 14;

/** Max imports to list per module line. */
const MAX_IMPORTS_PER_LINE = 4;

/** Max entry-point files to list. */
const MAX_ENTRY_POINTS = 3;

/** Max bridge-node connector lines. */
const MAX_BRIDGE_NODES = 5;

/**
 * Shorten a file path to its last 2 segments for compact display.
 * "agent-memory-mcp/src/memory-store.ts" → "src/memory-store.ts"
 */
function fmtFile(filePath) {
  const parts = String(filePath ?? '').replace(/\\/g, '/').split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : filePath;
}

/**
 * Build the minimap chunk.
 *
 * @param {object} options
 * @param {{ nodes: object[], links?: object[], edges?: object[] }} options.graph
 * @param {{ questions?: object[] }} options.analysis  — from .graphify_analysis.json
 * @param {string} options.projectSlug
 * @param {string} options.updatedAt  — ISO timestamp
 * @returns {object|null}  — createMaterializedProjectContext result, or null if graph unusable
 */
export function buildMinimapChunk({ graph, analysis, projectSlug, updatedAt }) {
  const nodes = graph?.nodes ?? [];
  const edges = graph?.links ?? graph?.edges ?? [];

  if (nodes.length === 0) {
    return null;
  }

  // ── Build code-node → source_file map (skip document nodes and nodes without source_file) ──
  const nodeToFile = new Map(); // nodeId → source_file path
  for (const node of nodes) {
    if (node.file_type !== 'document' && node.source_file) {
      nodeToFile.set(node.id, node.source_file);
    }
  }

  // ── Collapse import edges to file level ──
  // fileDepsOut: Map<sourceFile, Map<targetFile, edgeCount>>
  // fileInDegree: Map<targetFile, number>
  const fileDepsOut = new Map();
  const fileInDegree = new Map();

  for (const edge of edges) {
    if (!IMPORT_EDGE_TYPES.has(edge.relation)) continue;
    const srcFile = nodeToFile.get(edge.source);
    const tgtFile = nodeToFile.get(edge.target);
    if (!srcFile || !tgtFile || srcFile === tgtFile) continue;

    if (!fileDepsOut.has(srcFile)) fileDepsOut.set(srcFile, new Map());
    const out = fileDepsOut.get(srcFile);
    out.set(tgtFile, (out.get(tgtFile) ?? 0) + 1);

    fileInDegree.set(tgtFile, (fileInDegree.get(tgtFile) ?? 0) + 1);
  }

  if (fileInDegree.size === 0 && fileDepsOut.size === 0) {
    return null;
  }

  // ── Rank by in-degree: files most others import ──
  const keyModules = [...fileInDegree.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_KEY_MODULES)
    .map(([file, inDeg]) => {
      const outMap = fileDepsOut.get(file) ?? new Map();
      const topImports = [...outMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_IMPORTS_PER_LINE)
        .map(([f]) => fmtFile(f));
      return { file, inDeg, topImports };
    });

  // ── Entry points: high out-degree, not imported by anything ──
  const entryPoints = [...fileDepsOut.entries()]
    .filter(([file]) => !fileInDegree.get(file))
    .map(([file, outMap]) => ({
      file,
      outDeg: outMap.size,
      topImports: [...outMap.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([f]) => fmtFile(f)),
    }))
    .sort((a, b) => b.outDeg - a.outDeg)
    .slice(0, MAX_ENTRY_POINTS);

  // ── Bridge nodes from graphify analysis ──
  const bridgeNodes = (analysis?.questions ?? [])
    .filter((q) => q.type === 'bridge_node')
    .slice(0, MAX_BRIDGE_NODES);

  // ── Compose body (target: < ~2 KB) ──
  const lines = [];

  lines.push('**Key modules** (ranked by how many others import them):');
  lines.push('');
  for (const { file, inDeg, topImports } of keyModules) {
    const importsStr = topImports.length ? topImports.join(', ') : '—';
    lines.push(`- \`${fmtFile(file)}\` ← ${inDeg} modules · imports: ${importsStr}`);
  }

  if (entryPoints.length > 0) {
    lines.push('');
    lines.push('**Entry points** (import many, imported by few):');
    for (const { file, outDeg, topImports } of entryPoints) {
      const importsStr = topImports.length ? topImports.join(', ') : '—';
      lines.push(`- \`${fmtFile(file)}\` → ${outDeg} deps · ${importsStr}`);
    }
  }

  if (bridgeNodes.length > 0) {
    lines.push('');
    lines.push('**Cross-module connectors** (high betweenness centrality):');
    for (const q of bridgeNodes) {
      const match = q.question?.match(/`([^`]+)`/);
      const sym = match ? `\`${match[1]}\`` : '(unknown)';
      const why = q.why ?? q.question ?? '';
      lines.push(`- ${sym}: ${why}`);
    }
  }

  lines.push('');
  lines.push('> Drill: `pmc get-context <symbol> extended dependencies` · `pmc get-context <symbol> extended dependents`');

  const body = lines.join('\n');

  const totalModules = keyModules.length + entryPoints.length;
  const summary = `Module-level navigation map: ${totalModules} key modules, ${bridgeNodes.length} cross-module connectors identified. Use get-context to drill into any module.`;

  return createMaterializedProjectContext({
    kind: 'module-minimap',
    title: 'Module navigation map',
    summary,
    body,
    tags: ['project-context', `project:${projectSlug}`, 'minimap', 'architecture', 'navigation'],
    sourceFiles: ['.planning/project-memory-context/graph/graph.json'],
    graphRefs: keyModules.slice(0, 5).map((m) => m.file),
    sourceMode: 'detected',
    confidence: 'medium',
    updatedAt,
  });
}
