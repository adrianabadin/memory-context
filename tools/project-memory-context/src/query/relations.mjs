import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteGraphStore } from '../graph-store/graph-db.mjs';
import { createQueryEngine } from '../retrieval/query-engine.mjs';
import { resolveTarget } from '../retrieval/target-resolver.mjs';
import { resolveStopAtRole, walkRoleBoundary } from './role-traversal.mjs';
import { buildFacts } from '../cards/facts.mjs';
import { buildFileCard } from '../cards/file-card.mjs';

const TYPES = ['calls', 'imports', 'imports_from', 'contains', 'method'];
const normalize = value => String(value ?? '').replace(/\\/g, '/');
async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

/** Per-request graph.db reader: never creates, rebuilds or migrates a DB. */
export function createRelationsReader({ projectRoot }) {
  const pmc = join(projectRoot, '.planning', 'project-memory-context');
  async function withContext(action) {
    const index = await readJson(join(pmc, 'enrichment', 'symbol-index.json'), {});
    const worklist = await readJson(join(pmc, 'enrichment', 'worklist.json'), []);
    let db;
    try { db = new DatabaseSync(join(pmc, 'graph', 'graph.db'), { readOnly: true }); }
    catch (error) { throw new Error(`graph.db is unavailable; prepare PMC graph artifacts before querying: ${error.message}`); }
    try {
      const raw = createSqliteGraphStore(db);
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
      const groups = new Map();
      for (const { id } of db.prepare('SELECT id FROM nodes ORDER BY id').all()) {
        const node = raw.getNode(id);
        const identities = [node.symbolKey, node.metadata?.symbolKey, String(id).includes('|') ? id : null].filter(value => value != null);
        const key = identities[0];
        if (typeof key !== 'string' || identities.some(value => value !== key)) continue;
        const parts = key.split('|');
        if (parts.length !== 6 || parts.some(part => !part) ||
            (node.source_file != null && normalize(node.source_file) !== parts[1]) ||
            (node.kind != null && node.kind !== parts[2])) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(node);
      }
      const symbolIndex = {};
      for (const [key, nodes] of groups) {
        if (nodes.length !== 1 || (index[key]?.graphNodeId && index[key].graphNodeId !== nodes[0].id)) continue;
        symbolIndex[key] = { ...index[key], graphNodeId: nodes[0].id };
      }
      const store = { ...raw,
        getNode(id) { return raw.getNode(symbolIndex[id]?.graphNodeId ?? id); },
        getNodesByFile(path) {
          return raw.getNodesByFile(path).filter(node => {
            const key = node.symbolKey ?? node.metadata?.symbolKey ?? node.id;
            return symbolIndex[key]?.graphNodeId === node.id;
          });
        },
        listNativeEdges(filters) { return tables.has('native_edges') ? raw.listNativeEdges(filters) : []; },
        getNodeRole(id) {
          // Persisted roles must not revive symbols withheld by this reader's
          // canonical registry (e.g. stale index bindings or conflicting keys).
          if (!tables.has('node_role_assignments') || (!id.startsWith('file|') && !Object.hasOwn(symbolIndex, id))) return null;
          return raw.getNodeRole(id);
        },
      };
      const engine = createQueryEngine({ graphStore: store, symbolIndex, worklist });
      const endpoint = key => {
        if (!Object.prototype.hasOwnProperty.call(symbolIndex, key)) return null;
        const node = store.getNode(key); const parts = key.split('|');
        return { id: node.id, symbolKey: key, kind: node.kind ?? parts[2], path: parts[1] };
      };
      const symbol = key => {
        const entry = symbolIndex[key], node = store.getNode(key), parts = key.split('|');
        return { symbolKey: key, filePath: parts[1], name: parts[4], graphNodeId: entry.graphNodeId,
          memoryId: entry.memoryId ?? null, status: entry.status ?? null,
          semanticSummary: String(entry.semanticSummary ?? node.semanticSummary ?? node.metadata?.semanticSummary ?? '').trim() };
      };
      const fileExists = path => raw.getNodesByFile(path).length > 0 || raw.getNode(`file|${path}`)?.node_kind === 'file' ||
        store.listNativeEdges().some(edge => edge.source.id === `file|${path}` || edge.target.id === `file|${path}`);
      const legacyNodeIds = new Set(Object.values(index).map(entry => entry?.graphNodeId).filter(Boolean));
      return await action({ store, engine, endpoint, symbol, symbolIndex, groups, fileExists, legacyNodeIds,
        nativeAvailable: tables.has('native_edges'),
        // Role names actually assigned in this project's canonical ledger;
        // consulted only when validating an explicit stopAtRole value.
        assignedRoleNames() {
          if (!tables.has('node_role_assignments')) return [];
          const names = new Set();
          for (const row of db.prepare('SELECT classification FROM node_role_assignments').all()) {
            try {
              const classification = JSON.parse(row.classification);
              if (classification && typeof classification.role === 'string' && classification.role.length > 0) names.add(classification.role);
            } catch { /* a malformed stored classification is not a usable role name */ }
          }
          return [...names];
        } });
    } finally { db.close(); }
  }
  function resolve(context, target) {
    if (typeof target !== 'string' || !target.trim()) throw new TypeError('target must be a nonempty string');
    if (!context.engine.resolveSymbolIdentity(target)) {
      const separator = target.lastIndexOf('#');
      const file = separator >= 0 ? normalize(target.slice(0, separator)) : null;
      const name = separator >= 0 ? target.slice(separator + 1) : target;
      const matches = [...context.groups].filter(([key, nodes]) => {
        const parts = key.split('|');
        return key === target || nodes.some(node => node.id === target) ||
          (name && (!file || parts[1] === file) && (parts[4] === name || parts[4].endsWith(`.${name}`)));
      });
      if (matches.some(([, nodes]) => nodes.length > 1)) {
        return { status: 'ambiguous', candidates: matches.flatMap(([key, nodes]) => nodes.map(node => ({
          id: node.id, symbolKey: key, kind: node.kind ?? key.split('|')[2], path: key.split('|')[1],
        }))) };
      }
    }
    const resolved = target.startsWith('file|')
      ? { mode: 'file', target: target.slice(5) }
      : resolveTarget({ engine: context.engine, target });
    if (resolved.mode === 'symbol-ambiguous') return { status: 'ambiguous', candidates: resolved.symbolKeys.map(context.endpoint).filter(Boolean) };
    if (!['symbol', 'file'].includes(resolved.mode)) return { status: 'missing', candidates: [] };
    if (resolved.mode === 'file') {
      const card = buildFileCard(context.store, resolved.target);
      if (!context.fileExists(card.path)) return { status: 'missing', candidates: [] };
      resolved.target = card.path;
    }
    return { status: 'resolved', resolved };
  }
  async function relationsIn(context, { target, direction = 'out', relations = ['calls', 'imports'], depth = 1, stopAtRole }) {
    if (!['in', 'out', 'inbound', 'outbound'].includes(direction)) throw new TypeError('direction must be in, out, inbound or outbound');
    if (!Number.isInteger(depth) || depth < 1 || depth > 3) throw new TypeError('depth must be an integer from 1 to 3');
    if (!Array.isArray(relations) || relations.some(type => !TYPES.includes(type))) throw new TypeError('unsupported relation type');
    // S13: validate the optional role predicate before resolving, exactly like
    // the other option validators; absent (undefined) is a no-op.
    const roleStop = resolveStopAtRole(context, stopAtRole);
    const resolution = resolve(context, target);
    if (resolution.status !== 'resolved') return { ...resolution, edges: [] };
    if (roleStop !== undefined) {
      return await walkRoleBoundary(context, { resolved: resolution.resolved, direction, relations, depth, stopAtRole: roleStop });
    }
    const { store, engine, endpoint } = context;
    const { resolved } = resolution; const incoming = direction === 'in' || direction === 'inbound';
    const edges = new Map();
    const put = edge => edges.set(JSON.stringify([edge.source.symbolKey ?? edge.source.id, edge.target.symbolKey ?? edge.target.id, edge.relation]), edge);
    if (resolved.mode === 'file') {
      const file = buildFileCard(store, resolved.target);
      const otherTypes = relations.filter(type => type !== 'imports');
      if (otherTypes.length) {
        const preset = ['compact', 'extended', 'deep'][depth - 1];
        for (const key of Object.keys(context.symbolIndex).filter(key => key.split('|')[1] === file.path)) {
          const query = incoming
            ? await engine.queryImpactScope({ symbolKeys: [key], depth: preset, edgeTypes: otherTypes })
            : await engine.querySymbolContext({ symbolKey: key, depth: preset, edgeTypes: otherTypes });
          for (const edge of query.edges) {
            const source = endpoint(engine.graphNodeIdToSymbolKey(edge.source));
            const destination = endpoint(engine.graphNodeIdToSymbolKey(edge.target));
            if (source && destination) put({ source, target: destination, relation: edge.relation });
          }
        }
      }
      let frontier = [file.path]; const seen = new Set(frontier);
      if (relations.includes('imports')) for (let hop = 0; hop < depth && frontier.length; hop++) {
        const next = [];
        for (const path of frontier) {
          const card = buildFileCard(store, path);
          const origin = { id: `file|${card.path}`, path: card.path, kind: 'file' };
          for (const item of incoming ? card.importedBy : card.importsFrom) {
            put({ source: incoming ? item : origin, target: incoming ? origin : item, relation: 'imports' });
            if (!seen.has(item.path)) { seen.add(item.path); next.push(item.path); }
          }
        }
        frontier = next;
      }
    } else {
      const preset = ['compact', 'extended', 'deep'][depth - 1];
      const query = incoming
        ? await engine.queryImpactScope({ symbolKeys: [resolved.symbolKey], depth: preset, edgeTypes: relations })
        : await engine.querySymbolContext({ symbolKey: resolved.symbolKey, depth: preset, edgeTypes: relations });
      for (const edge of query.edges) {
        const source = endpoint(engine.graphNodeIdToSymbolKey(edge.source));
        const destination = endpoint(engine.graphNodeIdToSymbolKey(edge.target));
        if (source && destination) put({ source, target: destination, relation: edge.relation });
      }
      if (relations.includes('imports')) {
        let frontier = [resolved.symbolKey]; const seen = new Set(frontier);
        const bindings = store.listNativeImportBindings();
        for (let hop = 0; hop < depth && frontier.length; hop++) {
          const next = [];
          for (const current of frontier) {
            const origin = endpoint(current); const adjacent = [];
            if (!incoming) adjacent.push(...buildFacts(store, current).imports.map(item => item.symbolKey));
            else for (const binding of bindings) {
              if (binding.target?.id !== current) continue;
              for (const key of Object.keys(context.symbolIndex)) {
                const parts = key.split('|');
                if (parts[1] === binding.sourceId.slice(5) && parts[3] === 'exported') adjacent.push(key);
              }
            }
            for (const key of adjacent) {
              const other = endpoint(key);
              if (!other) continue;
              put({ source: incoming ? other : origin, target: incoming ? origin : other, relation: 'imports', scope: 'file' });
              if (!seen.has(key)) { seen.add(key); next.push(key); }
            }
          }
          frontier = next;
        }
      }
    }
    return { status: 'resolved', target: resolved.symbolKey ?? resolved.target, direction: incoming ? 'in' : 'out', depth,
      edges: [...edges.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
  }
  return {
    relations(options) { return withContext(context => relationsIn(context, options)); },
    card({ target }) {
      return withContext(context => {
        const resolution = resolve(context, target);
        if (resolution.status !== 'resolved') return resolution;
        const { resolved } = resolution;
        if (resolved.mode === 'file') return { status: 'resolved', target: resolved.target, facts: buildFileCard(context.store, resolved.target), enrichment: '' };
        return { status: 'resolved', target: resolved.symbolKey, facts: buildFacts(context.store, resolved.symbolKey),
          enrichment: context.symbol(resolved.symbolKey).semanticSummary };
      });
    },
    relatedSymbols(target, direction) {
      return withContext(async context => {
        if (!context.nativeAvailable) return null;
        const resolution = resolve(context, target);
        if (resolution.status === 'missing') return null;
        if (resolution.status === 'resolved' && resolution.resolved.mode === 'symbol') {
          const id = context.symbolIndex[resolution.resolved.symbolKey].graphNodeId;
          const legacy = context.store.traverse({ nodeIds: [id], maxHops: 1, edgeTypes: TYPES,
            direction: direction === 'in' ? 'inbound' : 'outbound' });
          const side = direction === 'in' ? 'source' : 'target';
          if (legacy.edges.some(edge => context.legacyNodeIds.has(edge[side]) && !context.engine.graphNodeIdToSymbolKey(edge[side]))) return null;
        }
        const result = await relationsIn(context, { target, direction, relations: TYPES });
        if (result.status === 'missing') return null; // Preserve older alias callers without promoting native identities.
        if (result.status !== 'resolved') return [];
        const side = direction === 'in' ? 'source' : 'target';
        return result.edges.map(edge => edge[side].symbolKey).filter(Boolean).map(context.symbol);
      });
    },
  };
}
