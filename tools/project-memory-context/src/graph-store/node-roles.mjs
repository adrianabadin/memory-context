// Caller-owned classification assignments survive Graphify rebuilds by canonical
// endpoint, never by a reusable Graphify node ID. Readers never create tables.
import { loadProfile, assertProfile } from '../roles/classify.mjs';

const SCHEMA = `CREATE TABLE IF NOT EXISTS node_role_assignments (
  endpoint_id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, classification TEXT NOT NULL
);`;
const normalize = (path) => String(path).replace(/\\/g, '/');
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

function validEndpoint(endpoint) {
  if (!object(endpoint) || !nonempty(endpoint.id) || !nonempty(endpoint.path) || !nonempty(endpoint.kind)) {
    throw new TypeError('Role assignment requires a canonical endpoint');
  }
  const path = endpoint.path;
  if (path !== normalize(path) || /^(\/|[A-Za-z]:)/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new TypeError('Role endpoint path must be normalized and project-relative');
  }
  if (endpoint.kind === 'file') {
    if (endpoint.id !== `file|${path}` || endpoint.symbolKey !== undefined) throw new TypeError('Invalid canonical file endpoint');
  } else {
    const parts = endpoint.id.split('|');
    const csharp = parts[0] === 'csharp' && parts.length === 7;
    if ((!csharp && parts.length !== 6) || parts.some((part) => !part) ||
        endpoint.symbolKey !== endpoint.id || parts[1] !== path || parts[csharp ? 4 : 2] !== endpoint.kind) {
      throw new TypeError('Role endpoint identity, path, kind and symbolKey must agree');
    }
  }
  return structuredClone(endpoint);
}

function metadata(row) {
  const extra = JSON.parse(row.metadata ?? '{}');
  if (!object(extra) || (extra.metadata !== undefined && !object(extra.metadata))) {
    throw new TypeError('Role assignment requires object node metadata');
  }
  return extra;
}

function matchingRows(db, endpoint) {
  return db.prepare('SELECT * FROM nodes WHERE source_file = ?').all(endpoint.path).filter((row) => {
    const extra = metadata(row);
    const keys = [extra.symbolKey, extra.metadata?.symbolKey].filter((key) => key !== undefined);
    if (keys.some((key) => key !== endpoint.id)) return false;
    if (endpoint.kind === 'file') {
      return row.node_kind === 'file' && normalize(row.label ?? '') === endpoint.path;
    }
    return (keys.length > 0 || row.id === endpoint.id) && (row.kind === null || row.kind === endpoint.kind) &&
      (row.node_kind === 'symbol' || row.node_kind === 'member');
  });
}

function validClassification(value, profile) {
  if (!object(value) || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1 ||
      !Array.isArray(value.evidence) || value.evidence.some((entry) => !nonempty(entry))) {
    throw new TypeError('Invalid role classification shape or confidence/evidence');
  }
  if (value.role === null) {
    if (value.layer !== null || value.confidence !== 0 || value.evidence.length !== 0) throw new TypeError('Invalid unknown role classification');
  } else if (!Object.hasOwn(profile.roleLayers, value.role) || value.layer !== profile.roleLayers[value.role] || value.evidence.length === 0) {
    throw new TypeError('Role classification must use a declared role/layer with evidence');
  }
  return { role: value.role, layer: value.layer, confidence: value.confidence, evidence: [...value.evidence] };
}

function applyMetadata(db, row, classification) {
  const extra = metadata(row);
  extra.metadata = { ...extra.metadata, roleClassification: classification };
  db.prepare('UPDATE nodes SET metadata = ? WHERE id = ?').run(JSON.stringify(extra), row.id);
}

export function persistNodeRoles(db, assignments, options = {}) {
  if (!Array.isArray(assignments)) throw new TypeError('Role assignments must be an array');
  if (!object(options) || Object.keys(options).some((key) => key !== 'profile')) {
    throw new TypeError('Role assignment options accept only a resolved profile');
  }
  const { profile = loadProfile('generic') } = options;
  assertProfile(profile);
  const seen = new Set();
  const validated = assignments.map((assignment) => {
    const endpoint = validEndpoint(assignment?.endpoint);
    const classification = validClassification(assignment?.classification, profile);
    if (seen.has(endpoint.id)) throw new TypeError('Duplicate role assignment endpoint');
    seen.add(endpoint.id);
    const rows = matchingRows(db, endpoint);
    if (rows.length !== 1) throw new TypeError('Role assignment endpoint must resolve to one current node');
    return { endpoint, classification, row: rows[0] };
  });
  db.exec('SAVEPOINT node_role_batch');
  try {
    db.exec(SCHEMA);
    const insert = db.prepare('INSERT INTO node_role_assignments VALUES (?, ?, ?) ON CONFLICT(endpoint_id) DO UPDATE SET endpoint=excluded.endpoint,classification=excluded.classification');
    for (const { endpoint, classification, row } of validated) {
      insert.run(endpoint.id, JSON.stringify(endpoint), JSON.stringify(classification));
      applyMetadata(db, row, classification);
    }
    db.exec('RELEASE node_role_batch');
    return { updated: validated.length };
  } catch (error) {
    db.exec('ROLLBACK TO node_role_batch; RELEASE node_role_batch');
    throw error;
  }
}

function hasTable(db) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='node_role_assignments'").get();
}

export function getNodeRole(db, endpointId) {
  if (!hasTable(db)) return null;
  const row = db.prepare('SELECT endpoint, classification FROM node_role_assignments WHERE endpoint_id = ?').get(endpointId);
  if (!row) return null;
  const endpoint = JSON.parse(row.endpoint);
  return matchingRows(db, endpoint).length === 1 ? JSON.parse(row.classification) : null;
}

// Called within the rebuild transaction, after the new nodes exist. Missing or
// ambiguous identities are retained as history but never projected onto nodes.
export function restoreNodeRoles(db) {
  if (!hasTable(db)) return;
  for (const record of db.prepare('SELECT endpoint, classification FROM node_role_assignments ORDER BY endpoint_id').all()) {
    const endpoint = JSON.parse(record.endpoint);
    const rows = matchingRows(db, endpoint);
    if (rows.length === 1) applyMetadata(db, rows[0], JSON.parse(record.classification));
  }
}
