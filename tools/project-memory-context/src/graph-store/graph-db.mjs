// tools/project-memory-context/src/graph-store/graph-db.mjs
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

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
`;

// ── Helpers ──────────────────────────────────────────────────────────────────

const CORE_FIELDS = new Set(['id', 'label', 'kind', 'source_file', 'community', 'degree']);

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
  const insertNode = db.prepare(
    `INSERT OR REPLACE INTO nodes (id, label, kind, source_file, community, degree, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
        node.source_file != null ? node.source_file.replace(/\\/g, '/') : null,
        node.community ?? null,
        node.degree ?? null,
        toMetadataJson(node),
      );
    }

    for (const link of graph.links ?? []) {
      insertEdge.run(link.source, link.target, link.relation);
    }

    upsertMeta.run('content_hash', contentHash);
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
  function traverse({ nodeIds, maxHops, edgeTypes, direction }) {
    const types = edgeTypes ?? ['calls', 'imports', 'imports_from', 'contains', 'method'];
    const dir = direction ?? 'outbound';

    const visited = new Set(nodeIds);
    const resultNodes = [];
    const resultEdges = [];

    // Collect seed nodes
    for (const id of nodeIds) {
      const row = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
      if (row) resultNodes.push(toGraphNode(row));
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
          if (neighborRow) {
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

    close() {
      db.close();
    },
  };
}

// ── Open ──────────────────────────────────────────────────────────────────────

/**
 * Open (or create) graph.db at `dbPath`. If the stored content_hash does not
 * match the hash of `graphJsonPath`, the DB is rebuilt from the JSON file.
 *
 * @param {string} dbPath   — absolute path to graph.db
 * @param {string} graphJsonPath — absolute path to graph.json
 * @returns {GraphStore}
 */
export function openGraphDb(dbPath, graphJsonPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);

  const graphJson = readFileSync(graphJsonPath, 'utf8');
  const currentHash = hashGraphJson(graphJson);
  const stored = db.prepare(`SELECT value FROM meta WHERE key = 'content_hash'`).get();
  const storedHash = stored?.value ?? null;

  if (storedHash !== currentHash) {
    const graph = JSON.parse(graphJson);
    buildFromGraphJson(db, graph, currentHash);
  }

  return createSqliteGraphStore(db);
}
