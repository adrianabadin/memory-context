// tools/project-memory-context/src/cards/facts.mjs
//
// Task 1.3: pure read-only facts builder for symbol cards. It consumes the
// canonical seams shipped by earlier units — the GraphStore node registry
// (getNode/getNodesByFile) and the unit-C `native_edges` readback
// (listNativeEdges) — and never re-resolves endpoints, writes tables, mutates
// graph.json or wires production refresh. Every relation item references an
// endpoint that already exists in the store; unknown fields degrade honestly
// (empty lists, null signature/lines) instead of being fabricated.
//
// Relation item shapes:
//   symbol endpoint — { symbolKey, relation, kind }
//   file endpoint   — { path, relation, kind: 'file' }
//
// Deterministic ordering: every relation list is sorted by symbolKey/path.

const FILE_PREFIX = 'file|';

const READ_SURFACE_METHODS = ['getNode', 'getNodesByFile', 'listNativeEdges'];

const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Parse a 6-part canonical symbol key `lang|path|kind|scope|name|arity`.
 * Returns null for anything else (fail closed, never guessed).
 */
function parseSymbolKey(symbolKey) {
  if (typeof symbolKey !== 'string' || symbolKey.length === 0) return null;
  const parts = symbolKey.split('|');
  if (parts.length !== 6 || parts.some((part) => part.length === 0)) return null;
  return { lang: parts[0], path: parts[1], kind: parts[2], scope: parts[3], name: parts[4], arity: parts[5] };
}

/** Constructor members (`Container.constructor`) mark instantiation edges. */
function isConstructorEndpoint(endpoint) {
  const parsed = parseSymbolKey(endpoint?.id);
  return parsed !== null && parsed.name.endsWith('.constructor');
}

/** Conservative structural heuristic for test files (directory or basename). */
function isTestFilePath(path) {
  const normalized = String(path).replace(/\\/g, '/');
  if (/(^|\/)(tests?|__tests__)(\/|$)/.test(normalized)) return true;
  return /\.(test|spec)\.[^./]+$/.test(normalized);
}

/**
 * Exported top-level registry symbols of a file: nodes classified as plain
 * symbols (node_kind 'symbol', so members/docs/config are excluded) whose
 * canonical key scope is 'exported'. Unparseable or non-exported keys are
 * withheld — an import statement can only bind an exported declaration.
 * Sorted by symbolKey, deduplicated.
 */
function exportedTopLevelSymbols(graphDb, filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return [];
  const found = new Map();
  for (const node of graphDb.getNodesByFile(filePath)) {
    if (node.node_kind !== 'symbol') continue;
    const key = node.symbolKey ?? node.metadata?.symbolKey ?? node.id;
    const parsed = parseSymbolKey(key);
    if (parsed === null || parsed.scope !== 'exported') continue;
    if (!found.has(key)) found.set(key, node.kind ?? parsed.kind);
  }
  return [...found].sort((a, b) => byKey(a[0], b[0])).map(([symbolKey, kind]) => ({ symbolKey, kind }));
}

/** BFS over a native call adjacency map, bounded by `depth` hops. */
function walkCalls(adjacency, startId, depth) {
  const seen = new Set([startId]);
  const found = new Map();
  let frontier = [startId];
  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    const next = [];
    for (const id of frontier) {
      for (const endpoint of adjacency.get(id) ?? []) {
        if (seen.has(endpoint.id)) continue;
        seen.add(endpoint.id);
        found.set(endpoint.id, endpoint.kind);
        next.push(endpoint.id);
      }
    }
    frontier = next;
  }
  return [...found]
    .sort((a, b) => byKey(a[0], b[0]))
    .map(([symbolKey, kind]) => ({ symbolKey, relation: 'calls', kind }));
}

/**
 * Build deterministic relation facts for one symbol or file endpoint.
 *
 * `callers`/`callees` come from persisted native `calls` edges. Edges whose
 * endpoint is a synthetic `Container.constructor` member are instantiation
 * evidence (`new X()`): they stay in the store but are listed under neither
 * callers nor callees — the named-call graph names the called member, not the
 * construction. `depth` (default 1, positive integer) bounds the transitive
 * expansion of those named calls; imports stay file-level and one-hop.
 *
 * Symbol-level `imports` consume persisted, uniquely resolved binding targets
 * that still exist in the registry. Legacy missing binding evidence returns
 * no guessed symbol imports. `importedBy`/`tests` retain the file-scoped lift
 * to exported symbols in importing files; they are not per-symbol usage
 * claims. `tests` entries are symbols
 * located in test files whose file imports the target's file (file-scoped
 * path items when the target itself is a file).
 *
 * `implements` is always [] in this unit: no native relation records
 * interface implementation, and facts never fabricate that evidence.
 *
 * fanIn = callers + importedBy lengths; fanOut = callees + imports lengths.
 *
 * @param {import('../graph-store/graph-db.mjs').GraphStore} graphDb
 * @param {string} symbolKey — canonical symbol key or `file|<path>` endpoint id
 * @param {{depth?: number}} [options]
 */
export function buildFacts(graphDb, symbolKey, { depth } = {}) {
  if (!graphDb || typeof graphDb !== 'object') {
    throw new TypeError('buildFacts requires a GraphStore read surface');
  }
  for (const name of READ_SURFACE_METHODS) {
    if (typeof graphDb[name] !== 'function') {
      throw new TypeError(`buildFacts requires a GraphStore read surface: missing ${name}`);
    }
  }
  if (typeof symbolKey !== 'string' || symbolKey.length === 0) {
    throw new TypeError('symbolKey must be a non-empty string');
  }
  const hops = depth === undefined ? 1 : depth;
  if (!Number.isInteger(hops) || hops < 1) {
    throw new TypeError(`depth must be a positive integer, got ${String(depth)}`);
  }

  const importEdges = graphDb.listNativeEdges({ relation: 'imports' });
  if (symbolKey.startsWith(FILE_PREFIX)) return fileFacts(graphDb, symbolKey, importEdges);

  // Named-call adjacency: constructor-instantiation edges are skipped by the
  // facts walk (see docblock); they remain untouched rows in the store.
  const outbound = new Map();
  const inbound = new Map();
  const push = (map, id, endpoint) => {
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(endpoint);
  };
  for (const edge of graphDb.listNativeEdges({ relation: 'calls' })) {
    if (isConstructorEndpoint(edge.source) || isConstructorEndpoint(edge.target)) continue;
    push(outbound, edge.source.id, edge.target);
    push(inbound, edge.target.id, edge.source);
  }

  const node = graphDb.getNode(symbolKey);
  const parsed = parseSymbolKey(symbolKey);
  const filePath = node?.source_file ?? parsed?.path ?? null;
  const fileId = filePath === null ? null : FILE_PREFIX + filePath;

  const importingFiles = fileId === null ? [] : importEdges.filter((e) => e.target.id === fileId).map((e) => e.source.path ?? e.source.id.slice(FILE_PREFIX.length));
  const testFiles = importingFiles.filter(isTestFilePath);

  const lift = (paths, relation) =>
    paths
      .flatMap((path) => exportedTopLevelSymbols(graphDb, path))
      .map(({ symbolKey: key, kind }) => ({ symbolKey: key, relation, kind }))
      .sort((a, b) => byKey(a.symbolKey, b.symbolKey));

  const callers = walkCalls(inbound, symbolKey, hops);
  const callees = walkCalls(outbound, symbolKey, hops);
  const bindings = typeof graphDb.listNativeImportBindings === 'function' ? graphDb.listNativeImportBindings() : [];
  const resolved = new Map();
  for (const binding of bindings.filter(binding => binding.sourceId === fileId && binding.target)) {
    const target = graphDb.getNode(binding.target.id);
    if (!target || target.source_file !== binding.target.path) continue;
    resolved.set(binding.target.id, { symbolKey: binding.target.id, relation: 'imports', kind: binding.target.kind });
  }
  const imports = [...resolved.values()].sort((a, b) => byKey(a.symbolKey, b.symbolKey));
  const importedBy = lift(importingFiles, 'imports');
  const tests = lift(testFiles, 'tests');

  return {
    id: symbolKey,
    kind: node?.kind ?? parsed?.kind ?? null,
    signature: node?.signature ?? null,
    location: {
      path: filePath,
      startLine: node?.range?.startLine ?? null,
      endLine: node?.range?.endLine ?? null,
    },
    callers,
    callees,
    imports,
    importedBy,
    implements: [],
    tests,
    fanIn: callers.length + importedBy.length,
    fanOut: callees.length + imports.length,
  };
}

/** File-endpoint facts: one-hop file-level relations, path-shaped items. */
function fileFacts(graphDb, fileId, importEdges) {
  const path = fileId.slice(FILE_PREFIX.length);
  if (path.length === 0) {
    throw new TypeError('file endpoints must carry a non-empty project-relative path');
  }
  const toPath = (endpoint) => endpoint.path ?? endpoint.id.slice(FILE_PREFIX.length);

  const fileItems = (paths, relation) =>
    [...new Set(paths)]
      .sort(byKey)
      .map((filePath) => ({ path: filePath, relation, kind: 'file' }));

  const imports = fileItems(
    importEdges.filter((e) => e.source.id === fileId).map((e) => toPath(e.target)),
    'imports',
  );
  const importedBy = fileItems(
    importEdges.filter((e) => e.target.id === fileId).map((e) => toPath(e.source)),
    'imports',
  );
  const tests = fileItems(
    importEdges.filter((e) => e.target.id === fileId).map((e) => toPath(e.source)).filter(isTestFilePath),
    'tests',
  );

  return {
    id: fileId,
    kind: 'file',
    signature: null,
    location: { path, startLine: null, endLine: null },
    // File endpoints carry no symbol-level call or implements evidence.
    callers: [],
    callees: [],
    imports,
    importedBy,
    implements: [],
    tests,
    fanIn: importedBy.length,
    fanOut: imports.length,
  };
}
