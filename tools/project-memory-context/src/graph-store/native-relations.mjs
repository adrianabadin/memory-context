// tools/project-memory-context/src/graph-store/native-relations.mjs
//
// Unit C (S4–S5): collision-safe persistence for native relation facts.
// Resolved facts (those carrying canonical endpoint objects) persist with
// their relation type as rows in the additive `native_edges` table; unresolved
// and ambiguous facts stay unresolved and are reported, never stored as
// raw-ID edges. The table is owned by this module and is deliberately NOT
// part of the Graphify-managed `nodes`/`edges` pair, so a graph.json rebuild
// (which wipes and rewrites nodes/edges) never destroys native edges, and
// native persistence never disturbs Graphify's legacy surfaces.
//
// Endpoints are the canonical shapes emitted by the native extractors:
//   file endpoint   — { id: 'file|<project-relative-path>', kind: 'file', path }
//   symbol endpoint — { id: symbolKey, symbolKey, kind, path }

/** Relation types the native extractors may persist. */
export const NATIVE_RELATIONS = Object.freeze(['calls', 'imports']);
const NATIVE_RELATION_SET = new Set(NATIVE_RELATIONS);

/**
 * DDL for the additive native edge table. Idempotent (IF NOT EXISTS); shared
 * by the graph.db schema so production opens and test fixtures stay identical.
 */
export const NATIVE_EDGES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS native_edges (
  source_id   TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  relation    TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  target_kind TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_native_edges_edge   ON native_edges(source_id, target_id, relation);
CREATE INDEX IF NOT EXISTS idx_native_edges_source ON native_edges(source_id, relation);
CREATE INDEX IF NOT EXISTS idx_native_edges_target ON native_edges(target_id, relation);
CREATE TABLE IF NOT EXISTS native_import_bindings (
  source_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  evidence TEXT NOT NULL,
  PRIMARY KEY (source_id, file_id, evidence)
);
`;

const isNonEmptyString = value => typeof value === 'string' && value.length > 0;

/**
 * Validate one endpoint object and return its canonical { id, kind } pair.
 * Throws TypeError on raw IDs, missing fields, prefix violations or a
 * symbolKey/id mismatch — a rejected batch must never write rows.
 */
function endpointOf(value, role) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`native relation ${role} must be a canonical endpoint object, got ${typeof value}`);
  }
  if (!isNonEmptyString(value.id)) throw new TypeError(`native relation ${role}.id must be a non-empty string`);
  if (!isNonEmptyString(value.kind)) throw new TypeError(`native relation ${role}.kind must be a non-empty string`);
  if (value.kind === 'file' && !value.id.startsWith('file|')) {
    throw new TypeError(`native relation ${role} is a file endpoint but id does not use the file| prefix: ${value.id}`);
  }
  if (value.symbolKey !== undefined && value.symbolKey !== value.id) {
    throw new TypeError(`native relation ${role} symbolKey '${value.symbolKey}' does not match id '${value.id}'`);
  }
  return { id: value.id, kind: value.kind };
}

/**
 * Persist the resolved facts of an extractor result into `native_edges`.
 *
 * Two-phase on purpose: every fact is validated first and only then written,
 * so a malformed batch (raw string target, unknown relation, mismatched
 * symbolKey) throws before any row is inserted. Re-persisting the same
 * (source, target, relation) triple is idempotent and counted as duplicate.
 *
 * Unresolved facts are never edges: they are counted per relation and
 * returned so callers keep the unresolved population observable.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{relations: Array<object>, unresolved: Array<object>}} extractResult
 * @returns {{inserted: number, duplicates: number, unresolved: Record<string, number>}}
 */
export function persistNativeRelations(db, extractResult, options = {}) {
  if (!extractResult || !Array.isArray(extractResult.relations) || !Array.isArray(extractResult.unresolved)) {
    throw new TypeError('extractResult must provide relations and unresolved arrays');
  }

  // Phase 1 — validate the whole batch; nothing is written yet.
  const validated = extractResult.relations.map(fact => {
    if (!fact || typeof fact !== 'object') throw new TypeError('native relation facts must be objects');
    if (!NATIVE_RELATION_SET.has(fact.relation)) {
      throw new TypeError(`unsupported native relation '${String(fact.relation)}' (allowed: ${NATIVE_RELATIONS.join(', ')})`);
    }
    if (fact.target === undefined) {
      throw new TypeError('resolved native relation facts must carry a canonical target endpoint');
    }
    const source = endpointOf(fact.source, 'source'); const target = endpointOf(fact.target, 'target');
    if (fact.bindings !== undefined && !Array.isArray(fact.bindings)) throw new TypeError('native import bindings must be an array');
    const bindings = (fact.bindings ?? []).map(binding => {
      if (fact.relation !== 'imports' || source.kind !== 'file' || target.kind !== 'file' ||
          !binding || !isNonEmptyString(binding.imported) || !isNonEmptyString(binding.local) || typeof binding.typeOnly !== 'boolean') {
        throw new TypeError('native import bindings require file endpoints and valid syntax metadata');
      }
      const evidence = { imported: binding.imported, local: binding.local, typeOnly: binding.typeOnly };
      if (binding.target !== undefined) {
        const resolved = endpointOf(binding.target, 'binding target');
        const parts = resolved.id.split('|');
        if (parts.length !== 6 || parts.some(part => !part) || binding.target.symbolKey !== resolved.id ||
            parts[1] !== target.id.slice(5) || parts[2] !== resolved.kind || binding.target.path !== parts[1] ||
            resolved.kind === 'file' || binding.imported === '*') throw new TypeError('native import binding target must identify a symbol in its target file');
        evidence.target = { ...resolved, symbolKey: resolved.id, path: parts[1] };
      } else if (binding.reason !== undefined) {
        if (!isNonEmptyString(binding.reason)) throw new TypeError('native import binding reason must be a nonempty string');
        evidence.reason = binding.reason;
      }
      return evidence;
    });
    return { source, target, relation: fact.relation, bindings };
  });

  const unresolved = {};
  for (const fact of extractResult.unresolved) {
    const relation = isNonEmptyString(fact?.relation) ? fact.relation : 'unknown';
    unresolved[relation] = (unresolved[relation] ?? 0) + 1;
  }

  // Phase 2 — write; the unique index makes repeated triples idempotent.
  db.exec('SAVEPOINT native_relation_batch');
  try {
  db.exec(NATIVE_EDGES_SCHEMA_SQL);
  if (options?.replace) {
    db.prepare('DELETE FROM native_edges').run();
    db.prepare('DELETE FROM native_import_bindings').run();
  }
  const insert = db.prepare(
    'INSERT OR IGNORE INTO native_edges (source_id, target_id, relation, source_kind, target_kind) VALUES (?, ?, ?, ?, ?)',
  );
  let inserted = 0;
  let duplicates = 0;
  const insertBinding = db.prepare('INSERT OR IGNORE INTO native_import_bindings (source_id, file_id, evidence) VALUES (?, ?, ?)');
  for (const edge of validated) {
    const result = insert.run(edge.source.id, edge.target.id, edge.relation, edge.source.kind, edge.target.kind);
    if (result.changes === 1) inserted += 1;
    else duplicates += 1;
    for (const binding of edge.bindings) insertBinding.run(edge.source.id, edge.target.id, JSON.stringify(binding));
  }
  db.exec('RELEASE native_relation_batch');
  return { inserted, duplicates, unresolved };
  } catch (error) {
    db.exec('ROLLBACK TO native_relation_batch; RELEASE native_relation_batch');
    throw error;
  }
}

// Evidence accumulates idempotently for a caller-owned immutable snapshot.
// This is not a live refresh/replacement API; conflicting binding evidence
// is retained and withheld by readers rather than selecting a last writer.
export function listNativeImportBindings(db) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'native_import_bindings'").get();
  if (!exists) return [];
  const rows = db.prepare('SELECT source_id, file_id, evidence FROM native_import_bindings ORDER BY source_id, file_id, evidence').all();
  const groups = new Map();
  for (const row of rows) {
    const binding = JSON.parse(row.evidence);
    const key = JSON.stringify([row.source_id, row.file_id, binding.imported, binding.local, binding.typeOnly]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ sourceId: row.source_id, fileId: row.file_id, ...binding });
  }
  return [...groups.values()].map(group => {
    if (group.length === 1) return group[0];
    const { target, reason, ...binding } = group[0];
    return { ...binding, reason: 'ambiguous-binding-evidence' };
  });
}

/**
 * Read persisted native edges as canonical endpoint pairs, deterministically
 * ordered. Optional filters narrow by relation and/or endpoint id.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{relation?: string, sourceId?: string, targetId?: string}} [filters]
 * @returns {Array<{source: {id: string, kind: string}, target: {id: string, kind: string}, relation: string}>}
 */
export function listNativeEdges(db, { relation, sourceId, targetId } = {}) {
  const clauses = [];
  const params = [];
  if (relation !== undefined) { clauses.push('relation = ?'); params.push(relation); }
  if (sourceId !== undefined) { clauses.push('source_id = ?'); params.push(sourceId); }
  if (targetId !== undefined) { clauses.push('target_id = ?'); params.push(targetId); }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT source_id, target_id, relation, source_kind, target_kind FROM native_edges${where} ORDER BY source_id, target_id, relation`)
    .all(...params);
  return rows.map(row => ({
    source: { id: row.source_id, kind: row.source_kind },
    target: { id: row.target_id, kind: row.target_kind },
    relation: row.relation,
  }));
}

/**
 * Read every native edge touching `endpointId` from either direction.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} endpointId — canonical file or symbol endpoint id
 */
export function getNativeEdgesFor(db, endpointId) {
  if (!isNonEmptyString(endpointId)) throw new TypeError('endpointId must be a non-empty string');
  const rows = db
    .prepare(
      `SELECT source_id, target_id, relation, source_kind, target_kind FROM native_edges
       WHERE source_id = ? OR target_id = ?
       ORDER BY source_id, target_id, relation`,
    )
    .all(endpointId, endpointId);
  return rows.map(row => ({
    source: { id: row.source_id, kind: row.source_kind },
    target: { id: row.target_id, kind: row.target_kind },
    relation: row.relation,
  }));
}
