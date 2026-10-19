import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteGraphStore } from '../graph-store/graph-db.mjs';
import { createQueryEngine } from '../retrieval/query-engine.mjs';
import { resolveTarget } from '../retrieval/target-resolver.mjs';
import { resolveStopAtRole, walkRoleBoundary } from './role-traversal.mjs';
import { walkEntrypoints } from './entrypoints.mjs';
import { walkImpact } from './impact.mjs';
import { assertContainedRead, rejectUnknownOptions, buildFileRollupResponse, buildCommunityCardResponse, buildFeatureCardResponse } from './aggregate-cards.mjs';
import { buildFacts } from '../cards/facts.mjs';
import { buildFileCard } from '../cards/file-card.mjs';
import { buildLeveledCard } from '../cards/card-levels.mjs';
import { isCanonicalSymbolKey } from '../cards/prompt-v2.mjs';

const TYPES = ['calls', 'imports', 'imports_from', 'contains', 'method'];
const normalize = value => String(value ?? '').replace(/\\/g, '/');
async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

/** Per-request graph.db reader: never creates, rebuilds or migrates a DB. */
export function createRelationsReader({ projectRoot }) {
  const pmc = join(projectRoot, '.planning', 'project-memory-context');
  const enrichmentDir = join(pmc, 'enrichment');
  async function withContext(action, aggregate = false) {
    if (aggregate) {
      // New card surfaces reject escaped DB/metadata/artifact roots; old
      // reader defaults and their error/option behavior remain unchanged.
      for (const path of [join(pmc, 'graph', 'graph.db'), enrichmentDir,
        join(enrichmentDir, 'symbol-index.json'), join(enrichmentDir, 'worklist.json')]) {
        await assertContainedRead(projectRoot, path);
      }
    }
    const index = await readJson(join(pmc, 'enrichment', 'symbol-index.json'), {});
    const worklist = await readJson(join(pmc, 'enrichment', 'worklist.json'), []);
    let db;
    try { db = new DatabaseSync(join(pmc, 'graph', 'graph.db'), { readOnly: true }); }
    catch (error) { throw new Error(`graph.db is unavailable; prepare PMC graph artifacts before querying: ${error.message}`); }
    try {
      const raw = createSqliteGraphStore(db);
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
      const groups = new Map();
      // S15: every known canonical FILE endpoint recognized by the same
      // identity/card coherence the public file readers use — standalone file
      // nodes with no registry symbols and no import edges included, so the
      // full-known impact ranking graph never drops an existing file vertex.
      // Contradictory identities or a foreign source_file fail closed, and a
      // node whose current kind is not `file` is never promoted to one.
      const knownFilePaths = new Set();
      for (const { id } of db.prepare('SELECT id FROM nodes ORDER BY id').all()) {
        const node = raw.getNode(id);
        if (typeof id === 'string' && id.startsWith('file|')) {
          const filePath = id.slice('file|'.length);
          const fileKeyCoherent = [node.symbolKey, node.metadata?.symbolKey]
            .filter(value => value != null).every(value => value === id);
          const sourceCoherent = node.source_file == null || normalize(node.source_file) === filePath;
          if (filePath && fileKeyCoherent && sourceCoherent &&
              (node.node_kind === 'file' || (node.node_kind == null && raw.getNodesByFile(filePath).length > 0))) {
            knownFilePaths.add(filePath);
          }
        }
        const identities = [node.symbolKey, node.metadata?.symbolKey, String(id).includes('|') ? id : null].filter(value => value != null);
        const key = identities[0];
        if (typeof key !== 'string' || identities.some(value => value !== key)) continue;
        const parts = key.split('|');
        const validKey = aggregate ? isCanonicalSymbolKey(key) : parts.length === 6 && !parts.some(part => !part);
        const kind = aggregate && parts.length === 7 ? parts[4] : parts[2];
        if (!validKey ||
            (node.source_file != null && normalize(node.source_file) !== parts[1]) ||
            (node.kind != null && node.kind !== kind)) continue;
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
      return await action({ store, engine, endpoint, symbol, symbolIndex, groups, fileExists, legacyNodeIds, worklist,
        knownFileEndpoints: [...knownFilePaths].sort(),
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
  // S14: `pmc_entrypoints_for` shares the same reader, resolution contracts and
  // per-request read-only lifecycle. The ONLY accepted option is `target`; an
  // undocumented extra (depth/role/direction/…) is rejected loudly instead of
  // being silently ignored, and a missing/ambiguous target keeps the existing
  // candidate shape with empty projections instead of inventing a resolved one.
  async function entrypointsIn(context, options) {
    const unknown = Object.keys(options ?? {}).filter(key => key !== 'target');
    if (unknown.length > 0) {
      throw new TypeError(`pmc_entrypoints_for accepts only the target option; unknown option '${unknown[0]}'`);
    }
    const resolution = resolve(context, options?.target);
    if (resolution.status !== 'resolved') return { ...resolution, matches: [], entrypoints: [], controllers: [] };
    return await walkEntrypoints(context, { resolved: resolution.resolved });
  }
  // S15: `pmc_impact` shares the same reader, resolution contracts and
  // per-request read-only lifecycle. The ONLY accepted option is `target`;
  // an undocumented extra (depth/role/direction/…) is rejected loudly instead
  // of being silently ignored, and a missing/ambiguous target keeps the
  // existing candidate shape with empty projections. The ranking parameters
  // (damping/tolerance/iterations) are implementation defaults reported in
  // `rankModel`, never accepted as options.
  async function impactIn(context, options) {
    const unknown = Object.keys(options ?? {}).filter(key => key !== 'target');
    if (unknown.length > 0) {
      throw new TypeError(`pmc_impact accepts only the target option; unknown option '${unknown[0]}'`);
    }
    const resolution = resolve(context, options?.target);
    if (resolution.status !== 'resolved') return { ...resolution, dependents: [], tests: [], roles: [] };
    return await walkImpact(context, { resolved: resolution.resolved });
  }
  // S23: the three aggregate-card readers share this reader, its resolution
  // contracts and its per-request read-only lifecycle. Each accepts ONLY its
  // own documented input (validated before the database is opened), derives
  // every membership/enumeration fact from the graph, and loads only EXISTING
  // accepted narrative artifacts through aggregate-cards.mjs. No level option:
  // the S18/S19 builders do not implement detail tiers.
  async function fileRollupIn(options) {
    rejectUnknownOptions('pmc_file_rollup', options, ['target']);
    const target = options?.target;
    if (typeof target !== 'string' || !target.trim()) throw new TypeError('target must be a nonempty string');
    return withContext(async context => {
      const resolution = resolve(context, target);
      if (resolution.status !== 'resolved') return resolution;
      const { resolved } = resolution;
      // A symbol is never silently presented as a file rollup.
      if (resolved.mode !== 'file') {
        return { status: 'not-a-file', reason: 'target-resolves-to-symbol', target: resolved.symbolKey, candidates: [] };
      }
      return await buildFileRollupResponse(context, { enrichmentDir, filePath: resolved.target });
    }, true);
  }
  async function communityCardIn(options) {
    rejectUnknownOptions('pmc_community_card', options, ['communityId']);
    const { communityId } = options ?? {};
    if (!(typeof communityId === 'string' && communityId.length > 0)
      && !(typeof communityId === 'number' && Number.isFinite(communityId))) {
      throw new TypeError('communityId must be a non-empty string or a finite number');
    }
    return withContext(context => buildCommunityCardResponse(context, { enrichmentDir, communityId }), true);
  }
  async function featureCardIn(options) {
    rejectUnknownOptions('pmc_feature_card', options, ['name', 'members']);
    const { name, members } = options ?? {};
    if (typeof name !== 'string' || name.length === 0) {
      throw new TypeError('name must be a non-empty string supplied by the consumer');
    }
    if (!Array.isArray(members) || members.length === 0) throw new TypeError('members must be a non-empty array of canonical symbol or file keys');
    const seen = new Set();
    for (const member of members) {
      if (typeof member !== 'string' || member.length === 0) {
        throw new TypeError('each members entry must be a non-empty string');
      }
      if (seen.has(member)) throw new TypeError(`duplicate members entry: ${member}`);
      seen.add(member);
    }
    return withContext(context => buildFeatureCardResponse(context, { enrichmentDir, name, members }), true);
  }
  return {
    relations(options) { return withContext(context => relationsIn(context, options)); },
    entrypoints(options) { return withContext(context => entrypointsIn(context, options)); },
    impact(options) { return withContext(context => impactIn(context, options)); },
    card({ target, level } = {}) {
      return withContext(context => {
        const resolution = resolve(context, target);
        if (resolution.status !== 'resolved') return resolution;
        const { resolved } = resolution;
        const isFile = resolved.mode === 'file';
        const facts = isFile ? buildFileCard(context.store, resolved.target) : buildFacts(context.store, resolved.symbolKey);
        const enrichment = isFile ? '' : context.symbol(resolved.symbolKey).semanticSummary;
        const outTarget = isFile ? resolved.target : resolved.symbolKey;
        // No level -> exact legacy facts-only output, byte-for-byte unchanged.
        if (level === undefined) return { status: 'resolved', target: outTarget, facts, enrichment };
        const leveled = buildLeveledCard({ facts, enrichment, level });
        return { status: 'resolved', target: outTarget, ...leveled };
      });
    },
    fileRollup(options) { return fileRollupIn(options); },
    communityCard(options) { return communityCardIn(options); },
    featureCard(options) { return featureCardIn(options); },
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
