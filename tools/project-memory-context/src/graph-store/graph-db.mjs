// tools/project-memory-context/src/graph-store/graph-db.mjs
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { NATIVE_EDGES_SCHEMA_SQL, persistNativeRelations, listNativeEdges, getNativeEdgesFor, listNativeImportBindings } from './native-relations.mjs';
import { persistNodeRoles, getNodeRole, restoreNodeRoles } from './node-roles.mjs';

// ── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,
  label       TEXT,
  kind        TEXT,
  node_kind   TEXT,
  source_file TEXT,
  community   INTEGER,
  degree      INTEGER,
  metadata    TEXT
);
CREATE TABLE IF NOT EXISTS edges (
  source   TEXT NOT NULL,
  target   TEXT NOT NULL,
  relation TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS community_names (
  community_id TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   TEXT,
  updated_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source, relation);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target, relation);
CREATE INDEX IF NOT EXISTS idx_nodes_file   ON nodes(source_file);
${NATIVE_EDGES_SCHEMA_SQL}
`;

// ── Helpers ──────────────────────────────────────────────────────────────────

// node_kind is a reserved core column: raw graph.json payload values are ignored
// on ingest (the computed classification is canonical) and the row value is the
// only value reported on readback — metadata must never shadow it.
const CORE_FIELDS = new Set(['id', 'label', 'kind', 'node_kind', 'source_file', 'community', 'degree']);

// ── Typed node kinds (plan Task 1.1) ────────────────────────────────────────
//
// `classifyNodeKind(node)` is a pure, deterministic classifier over the
// additive `node_kind` column. The legacy `kind` column (Graphify/extractor
// kinds such as `function`/`class`) is preserved untouched for existing
// readers; `node_kind` is the stable typed-taxonomy classification.

/** Allowed values of the typed node taxonomy. */
export const NODE_KINDS = Object.freeze(['file', 'symbol', 'member', 'doc', 'config', 'data']);
const NODE_KIND_SET = new Set(NODE_KINDS);

/** Bumped when persisted node classification changes shape → forces a rebuild. */
const GRAPH_SCHEMA_VERSION = 2;

const DOC_EXTENSIONS = new Set([
  'md', 'markdown', 'mdx', 'mdown', 'mkd', 'rmd', 'rst', 'adoc', 'txt',
]);

const CODE_EXTENSIONS = new Set([
  // JS/TS
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts',
  // JVM / CLR / functional
  'java', 'cs', 'kt', 'kts', 'scala', 'groovy', 'clj', 'cljs', 'fs', 'fsx', 'vb',
  // systems
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'm', 'mm', 'rs', 'go', 'zig', 'nim',
  // scripting
  'py', 'pyw', 'pyi', 'rb', 'php', 'pl', 'pm', 'r', 'lua', 'dart', 'ex', 'exs', 'erl', 'hs', 'ml', 'swift',
  // shell
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  // web source
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro',
]);

const CONFIG_DATA_EXTENSIONS = new Set([
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'lock',
]);

/** Basenames that are configuration even without a recognised extension. */
const CONFIG_BASENAMES = new Set([
  'package.json', 'composer.json', 'cargo.toml', 'docker-compose.yml', 'docker-compose.yaml',
  'go.mod', 'go.work', 'makefile', 'dockerfile', 'gemfile', 'rakefile', 'procfile', 'justfile',
]);

const MEMBER_KINDS = new Set([
  'method', 'member', 'constructor', 'property', 'field', 'event', 'accessor', 'getter', 'setter',
]);

const SYMBOL_KINDS = new Set([
  'function', 'class', 'interface', 'enum', 'struct', 'union', 'trait', 'type', 'typedef',
  'variable', 'constant', 'module', 'namespace', 'macro', 'decorator', 'annotation',
]);

/** Graphify labels both functions and methods as `.name()` — not a membership signal. */
const METHOD_CALL_LABEL = /^\.[A-Za-z_$][A-Za-z0-9_$]*\s*\(/;

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function basename(path) {
  const normalized = String(path).replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

function extensionOf(path) {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** A label denotes a file path when it contains a separator or a known name. */
function isPathLike(label) {
  if (typeof label !== 'string' || label.length === 0) return false;
  if (METHOD_CALL_LABEL.test(label)) return false;
  if (label.includes('/') || label.includes('\\')) return true;
  const ext = extensionOf(label);
  if (ext && (CODE_EXTENSIONS.has(ext) || DOC_EXTENSIONS.has(ext) || CONFIG_DATA_EXTENSIONS.has(ext))) {
    return true;
  }
  const lower = basename(label).toLowerCase();
  if (CONFIG_BASENAMES.has(lower)) return true;
  return lower.startsWith('.'); // dotfiles: .eslintrc, .env, .gitignore
}

function isConfigPath(path) {
  const lower = basename(path).toLowerCase();
  if (lower.startsWith('.')) return true;
  if (CONFIG_BASENAMES.has(lower)) return true;
  if (lower.includes('config')) return true;
  return false;
}

/** Extract the `kind` segment of a symbolKey (generic 6-part or C# 7-part). */
function symbolKeyKind(symbolKey) {
  if (typeof symbolKey !== 'string' || symbolKey.length === 0) return null;
  const parts = symbolKey.split('|');
  if (parts.length >= 7 && parts[0].toLowerCase() === 'csharp') return parts[4];
  if (parts.length >= 6) return parts[2];
  return null;
}

const CONTAINER_FIELDS = ['container', 'containerName', 'parentSymbol', 'memberOf', 'containingType'];

function memberEvidence(node, meta, symbolKey) {
  const legacyKind = firstString(node.kind, meta.kind);
  if (legacyKind && MEMBER_KINDS.has(legacyKind.toLowerCase())) return true;
  const keyKind = symbolKeyKind(symbolKey);
  if (keyKind && MEMBER_KINDS.has(keyKind.toLowerCase())) return true;
  for (const field of CONTAINER_FIELDS) {
    if (firstString(node[field], meta[field])) return true;
  }
  return false;
}

function symbolEvidence(node, meta, symbolKey) {
  if (symbolKey) return true;
  const legacyKind = firstString(node.kind, meta.kind);
  if (legacyKind && SYMBOL_KINDS.has(legacyKind.toLowerCase())) return true;
  if (node.file_type === 'code' && firstString(node.source_location)) return true;
  return false;
}

/**
 * Pure, deterministic typed-taxonomy classifier.
 *
 * Precedence: structured member evidence → Graphify document nodes →
 * path-shaped label (file / config / data / doc by extension and basename) →
 * structured symbol evidence for non-path-like labels → conservative `data`
 * fallback. File detection comes from labels and paths (plan Task 1.1), so a
 * path-shaped label wins over contradictory symbol hints. Unknown or invalid
 * input classifies as `data` (fail closed), never as a code symbol guessed
 * from a label alone.
 *
 * @param {object} node — raw graph.json node (or a persisted node row)
 * @returns {'file'|'symbol'|'member'|'doc'|'config'|'data'}
 */
export function classifyNodeKind(node) {
  if (node === null || typeof node !== 'object') return 'data';
  const meta = (node.metadata && typeof node.metadata === 'object' && !Array.isArray(node.metadata))
    ? node.metadata
    : {};
  const label = firstString(node.label);
  const symbolKey = firstString(meta.symbolKey, node.symbolKey);

  // 1. Structured member evidence wins (container, member kind, member key).
  if (memberEvidence(node, meta, symbolKey)) return 'member';

  // 2. Graphify document nodes.
  if (node.file_type === 'document') return 'doc';

  const ownPath = label !== null && isPathLike(label) ? label : null;

  // 3. Structured symbol evidence — requires a non path-like label.
  if (ownPath === null && symbolEvidence(node, meta, symbolKey)) return 'symbol';

  // 4. Extension-based doc: own path, else the containing source_file.
  const docSource = ownPath ?? firstString(node.source_file);
  if (docSource !== null && DOC_EXTENSIONS.has(extensionOf(docSource))) return 'doc';

  // 5. Path-like label → file / config / data by extension and basename.
  if (ownPath !== null) {
    const ext = extensionOf(ownPath);
    if (ext && CODE_EXTENSIONS.has(ext)) return 'file';
    if (ext && CONFIG_DATA_EXTENSIONS.has(ext)) return isConfigPath(ownPath) ? 'config' : 'data';
    if (isConfigPath(ownPath)) return 'config'; // extensionless/dotfile config: Makefile, .eslintrc
    return 'data'; // unknown extension on a path-like label
  }

  // 6. Conservative fallback for unknown shapes.
  return 'data';
}

/** Idempotently add node_kind to DBs created before the typed-kind layer. */
function ensureNodeKindColumn(db) {
  const columns = db.prepare('PRAGMA table_info(nodes)').all();
  if (!columns.some((column) => column.name === 'node_kind')) {
    db.exec('ALTER TABLE nodes ADD COLUMN node_kind TEXT');
  }
}

function describeFilterValue(value) {
  let text;
  try {
    text = typeof value === 'string' ? JSON.stringify(value) : String(value);
  } catch {
    text = typeof value;
  }
  return text.length > 64 ? `${text.slice(0, 64)}…` : text;
}

/**
 * Validate a traverse `nodeKinds` filter. Omitted (`undefined`) returns `null`
 * (legacy unfiltered behaviour). Any supplied value must be an array of
 * taxonomy values; duplicates collapse; anything else throws TypeError so an
 * invalid filter can never silently widen results (fail closed).
 *
 * @param {string[]|undefined} nodeKinds
 * @returns {Set<string>|null}
 */
function normalizeNodeKinds(nodeKinds) {
  if (nodeKinds === undefined) return null;
  if (!Array.isArray(nodeKinds)) {
    throw new TypeError(
      `nodeKinds must be an array of taxonomy values (${NODE_KINDS.join(', ')}); got ${describeFilterValue(nodeKinds)}`,
    );
  }
  const allowed = new Set();
  for (const kind of nodeKinds) {
    if (typeof kind !== 'string' || !NODE_KIND_SET.has(kind)) {
      throw new TypeError(
        `invalid nodeKinds entry ${describeFilterValue(kind)}; allowed values: ${NODE_KINDS.join(', ')}`,
      );
    }
    allowed.add(kind);
  }
  return allowed;
}

function toMetadataJson(node) {
  const extra = {};
  for (const [k, v] of Object.entries(node)) {
    if (!CORE_FIELDS.has(k)) extra[k] = v;
  }
  return JSON.stringify(extra);
}

function toGraphNode(row) {
  const base = {
    id: row.id,
    label: row.label,
    kind: row.kind,
    node_kind: row.node_kind ?? null,
    source_file: row.source_file,
    community: row.community,
    degree: row.degree,
  };
  try {
    const extra = JSON.parse(row.metadata ?? '{}');
    return { ...base, ...extra };
  } catch {
    return base;
  }
}

function expandParams(items) {
  return items.map(() => '?').join(', ');
}

export function hashGraphJson(graphJson) {
  return createHash('sha256').update(graphJson).digest('hex');
}

// ── Build ─────────────────────────────────────────────────────────────────────

/**
 * Rebuild the SQLite graph from a parsed graph object.
 * Runs inside a single transaction — idempotent (DELETE + INSERT).
 *
 * @param {DatabaseSync} db
 * @param {{ nodes?: object[], links?: object[] }} graph
 * @param {string} contentHash — SHA-256 hex of the source graph.json
 */
export function buildFromGraphJson(db, graph, contentHash) {
  ensureNodeKindColumn(db);
  const insertNode = db.prepare(
    `INSERT OR REPLACE INTO nodes (id, label, kind, node_kind, source_file, community, degree, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertEdge = db.prepare(
    `INSERT INTO edges (source, target, relation) VALUES (?, ?, ?)`,
  );
  const upsertMeta = db.prepare(
    `INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`,
  );

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM nodes; DELETE FROM edges;');

    for (const node of graph.nodes ?? []) {
      insertNode.run(
        node.id,
        node.label ?? null,
        node.kind ?? null,
        classifyNodeKind(node),
        node.source_file != null ? node.source_file.replace(/\\/g, '/') : null,
        node.community ?? null,
        node.degree ?? null,
        toMetadataJson(node),
      );
    }

    for (const link of graph.links ?? []) {
      insertEdge.run(link.source, link.target, link.relation);
    }

    restoreNodeRoles(db);

    upsertMeta.run('content_hash', contentHash);
    upsertMeta.run('schema_version', String(GRAPH_SCHEMA_VERSION));
    upsertMeta.run('built_at', new Date().toISOString());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ── Store ─────────────────────────────────────────────────────────────────────

/**
 * Create a SqliteGraphStore from an already-opened DatabaseSync.
 * Useful in tests to inject a pre-built db without hitting disk for graph.json.
 *
 * @param {DatabaseSync} db
 * @returns {GraphStore}
 */
export function createSqliteGraphStore(db) {
  function traverse({ nodeIds, maxHops, edgeTypes, direction, nodeKinds }) {
    // Fail closed before touching SQL: only omitted nodeKinds keeps the legacy
    // unfiltered behaviour; an explicit list (even empty) is a strict allowlist.
    const allowedKinds = normalizeNodeKinds(nodeKinds);
    const kindAllowed = (row) => allowedKinds === null || allowedKinds.has(row.node_kind ?? null);
    const types = edgeTypes ?? ['calls', 'imports', 'imports_from', 'contains', 'method'];
    const dir = direction ?? 'outbound';

    const visited = new Set(nodeIds);
    const resultNodes = [];
    const resultEdges = [];

    // Collect seed nodes (seeds obey the same filter as any other node)
    for (const id of nodeIds) {
      const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
      if (row && kindAllowed(row)) resultNodes.push(toGraphNode(row));
    }

    let frontier = [...nodeIds].filter((id) => resultNodes.some((n) => n.id === id));
    let depthReached = 0;

    for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
      const nextFrontier = [];
      const edgeIn = expandParams(types);
      const frontierIn = expandParams(frontier);

      const rows = dir === 'outbound'
        ? db.prepare(
            `SELECT * FROM edges WHERE source IN (${frontierIn}) AND relation IN (${edgeIn})`,
          ).all(...frontier, ...types)
        : db.prepare(
            `SELECT * FROM edges WHERE target IN (${frontierIn}) AND relation IN (${edgeIn})`,
          ).all(...frontier, ...types);

      for (const edge of rows) {
        const neighborId = dir === 'outbound' ? edge.target : edge.source;
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          const neighborRow = db.prepare('SELECT * FROM nodes WHERE id = ?').get(neighborId);
          // Excluded neighbours are marked visited but never enter the results,
          // the frontier, or the edge list: paths do not leak through them and
          // they consume no traversal depth.
          if (neighborRow && kindAllowed(neighborRow)) {
            resultNodes.push(toGraphNode(neighborRow));
            resultEdges.push({ source: edge.source, target: edge.target, relation: edge.relation });
            nextFrontier.push(neighborId);
          }
        }
      }

      if (nextFrontier.length === 0) break;
      frontier = nextFrontier;
      depthReached = hop + 1;
    }

    return { nodes: resultNodes, edges: resultEdges, depth_reached: depthReached };
  }

  return {
    getNode(id) {
      const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
      return row ? toGraphNode(row) : null;
    },

    getNodesByFile(filePath) {
      const normalized = String(filePath ?? '').replace(/\\/g, '/');
      const rows = db.prepare('SELECT * FROM nodes WHERE source_file = ?').all(normalized);
      return rows.map(toGraphNode);
    },

    traverse,

    // ── Community names ────────────────────────────────────────────────────────

    upsertCommunityName(communityId, name) {
      const id = String(communityId);
      const now = new Date().toISOString();
      // Preserve created_at on update; only refresh updated_at.
      db.prepare(
        `INSERT INTO community_names (community_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(community_id) DO UPDATE SET
           name = excluded.name,
           updated_at = excluded.updated_at`,
      ).run(id, name, now, now);
    },

    getCommunityName(communityId) {
      const id = String(communityId);
      const row = db
        .prepare('SELECT name FROM community_names WHERE community_id = ?')
        .get(id);
      return row ? row.name : null;
    },

    getAllCommunityNames() {
      return db
        .prepare(
          'SELECT community_id, name, created_at, updated_at FROM community_names ORDER BY community_id',
        )
        .all();
    },

    deleteCommunityName(communityId) {
      const id = String(communityId);
      db.prepare('DELETE FROM community_names WHERE community_id = ?').run(id);
    },

    // ── Native relations (unit C, S4–S5) ─────────────────────────────────────
    // Additive surface: persists resolved native facts into `native_edges`
    // (survives graph.json rebuilds) and reads them back as canonical
    // endpoint pairs. Unresolved facts are never edges. See
    // src/graph-store/native-relations.mjs.
    persistNativeRelations(extractResult) {
      return persistNativeRelations(db, extractResult);
    },

    listNativeEdges(filters) {
      return listNativeEdges(db, filters);
    },

    getNativeEdgesFor(endpointId) {
      return getNativeEdgesFor(db, endpointId);
    },

    listNativeImportBindings() {
      return listNativeImportBindings(db);
    },

    persistNodeRoles(assignments, options) {
      return persistNodeRoles(db, assignments, options);
    },

    getNodeRole(endpointId) {
      return getNodeRole(db, endpointId);
    },

    close() {
      db.close();
    },
  };
}

// ── Open ──────────────────────────────────────────────────────────────────────

/**
 * Open (or create) graph.db at `dbPath`. If the stored content_hash does not
 * match the hash of `graphJsonPath`, or the stored `schema_version` predates
 * the current typed-kind layer, the DB is rebuilt from the JSON file.
 *
 * @param {string} dbPath   — absolute path to graph.db
 * @param {string} graphJsonPath — absolute path to graph.json
 * @returns {GraphStore}
 */
export function openGraphDb(dbPath, graphJsonPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);
  ensureNodeKindColumn(db);

  const graphJson = readFileSync(graphJsonPath, 'utf8');
  const currentHash = hashGraphJson(graphJson);
  const stored = db.prepare(`SELECT value FROM meta WHERE key = 'content_hash'`).get();
  const storedHash = stored?.value ?? null;
  const storedVersion = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()?.value ?? null;

  // Rebuild when graph.json changed OR the persisted classification predates
  // the current schema version (records written by an older classifier).
  if (storedHash !== currentHash || storedVersion !== String(GRAPH_SCHEMA_VERSION)) {
    const graph = JSON.parse(graphJson);
    buildFromGraphJson(db, graph, currentHash);
  }

  return createSqliteGraphStore(db);
}
