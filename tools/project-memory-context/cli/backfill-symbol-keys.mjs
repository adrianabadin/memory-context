import { resolve, relative, isAbsolute, sep } from 'node:path';
import { findMemoriesByKeyTag } from './sync.mjs';

const LOOKUP_LIMIT = 100;
const bytewise = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const safeKey = (key) => key.replace(/[^a-zA-Z0-9_-]+/g, '_');

function parseSymbolKey(symbolKey) {
  const parts = symbolKey.split('|');
  if (parts[0] === 'csharp') {
    if (parts.length !== 7 || parts.some((part) => !part)) return null;
    return { language: parts[0], filePath: parts[1] };
  }
  if (parts.length !== 6 || parts.some((part) => !part)) return null;
  return { language: parts[0], filePath: parts[1] };
}

function normalizeProjectPath(filePath, projectRoot) {
  const slashed = filePath.replace(/\\/g, '/');
  if (slashed.startsWith('/') || /^[a-zA-Z]:/.test(slashed)) return null;

  const segments = [];
  for (const segment of slashed.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  if (segments.length === 0) return null;

  const absoluteRoot = resolve(projectRoot);
  const absolutePath = resolve(absoluteRoot, ...segments);
  const fromRoot = relative(absoluteRoot, absolutePath);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return null;
  const normalized = fromRoot.split(sep).join('/');
  return { normalized, segments: normalized.split('/') };
}

function isIgnoredPath(segments) {
  return segments.some((segment) => segment === '.planning' || segment === '.worktrees');
}

function addSkip(skips, symbolKey, reason, details = {}) {
  skips.push({ symbolKey, reason, ...details });
}

/**
 * Build an index-bounded dry-run plan for linking legacy memories to symbol keys.
 * No filesystem or MCP mutation operation is performed; the injected lookup
 * must retain the sync layer's exact-tag search contract and existing cap.
 */
export async function planSymbolKeyBackfill({
  symbolIndex,
  projectTag,
  client,
  projectRoot = process.cwd(),
  findMemoriesByKeyTag: lookup = findMemoriesByKeyTag,
} = {}) {
  if (!symbolIndex || typeof symbolIndex !== 'object' || Array.isArray(symbolIndex)) {
    throw new TypeError('symbolIndex must be an ordinary object');
  }
  if (Object.getPrototypeOf(symbolIndex) !== Object.prototype && Object.getPrototypeOf(symbolIndex) !== null) {
    throw new TypeError('symbolIndex must be an ordinary object');
  }
  if (typeof projectTag !== 'string' || !projectTag.startsWith('project:') || !/\S/.test(projectTag.slice('project:'.length))) {
    throw new TypeError('projectTag must be a nonempty exact project tag');
  }
  if (!client || typeof lookup !== 'function') throw new TypeError('client and lookup function are required');
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) throw new TypeError('projectRoot must be a nonempty path');

  const symbolKeys = Object.keys(symbolIndex).sort(bytewise);
  const groups = new Map();
  for (const symbolKey of symbolKeys) {
    const lookupTag = `key:symbol:${safeKey(symbolKey)}`;
    const group = groups.get(lookupTag) ?? [];
    group.push(symbolKey);
    groups.set(lookupTag, group);
  }

  const mappings = [];
  const skips = [];
  const queriedTags = [];
  const idSightings = new Map();
  const candidatesById = new Map();

  for (const [lookupTag, keys] of [...groups.entries()].sort(([a], [b]) => bytewise(a, b))) {
    if (keys.length > 1) {
      for (const symbolKey of keys) addSkip(skips, symbolKey, 'key-tag-collision', { lookupTag, collidesWith: keys.filter((key) => key !== symbolKey) });
      continue;
    }
    const symbolKey = keys[0];
    const parsed = parseSymbolKey(symbolKey);
    if (!parsed) {
      addSkip(skips, symbolKey, 'invalid-symbol-key', { lookupTag });
      continue;
    }
    const path = normalizeProjectPath(parsed.filePath, projectRoot);
    if (!path) {
      addSkip(skips, symbolKey, 'unsafe-path', { lookupTag });
      continue;
    }
    if (isIgnoredPath(path.segments)) {
      addSkip(skips, symbolKey, 'ignored-path', { lookupTag, filePath: path.normalized });
      continue;
    }

    queriedTags.push(lookupTag);
    const rows = await lookup(client, lookupTag);
    if (!Array.isArray(rows)) throw new TypeError(`Lookup for ${lookupTag} did not return an array`);
    if (rows.length >= LOOKUP_LIMIT) {
      addSkip(skips, symbolKey, 'lookup-truncated', { lookupTag, returned: rows.length, limit: LOOKUP_LIMIT });
      continue;
    }

    for (const memory of rows) {
      const id = memory?.id;
      if (typeof id !== 'string' || id.length === 0) {
        addSkip(skips, symbolKey, 'invalid-memory-id', { lookupTag });
        continue;
      }
      const sightings = idSightings.get(id) ?? { count: 0, symbolKeys: new Set() };
      sightings.count += 1;
      sightings.symbolKeys.add(symbolKey);
      idSightings.set(id, sightings);

      const memoryTags = Array.isArray(memory.tags) ? memory.tags.filter((value) => typeof value === 'string') : [];
      const symbolTags = memoryTags.filter((value) => value.startsWith('key:symbol:'));
      if (!symbolTags.includes(lookupTag) || symbolTags.length !== 1) {
        addSkip(skips, symbolKey, 'missing-exact-key-tag', { id, lookupTag });
        continue;
      }
      const projectTags = memoryTags.filter((value) => value.startsWith('project:'));
      if (projectTags.length !== 1 || projectTags[0] !== projectTag) {
        addSkip(skips, symbolKey, 'project-tag-mismatch', { id, lookupTag });
        continue;
      }

      const snakeKey = memory.symbol_key;
      const camelKey = memory.symbolKey;
      if ((snakeKey !== undefined && snakeKey !== null && typeof snakeKey !== 'string') ||
          (camelKey !== undefined && camelKey !== null && typeof camelKey !== 'string') ||
          (snakeKey != null && camelKey != null && snakeKey !== camelKey)) {
        addSkip(skips, symbolKey, 'conflicting-symbol-key', { id, lookupTag });
        continue;
      }
      const existingKey = snakeKey ?? camelKey;
      if (existingKey != null && existingKey !== symbolKey) {
        addSkip(skips, symbolKey, 'conflicting-symbol-key', { id, lookupTag, existingSymbolKey: existingKey });
        continue;
      }
      if (existingKey === symbolKey) {
        addSkip(skips, symbolKey, 'already-linked', { id, lookupTag });
        continue;
      }

      candidatesById.set(id, { id, symbolKey, keyTag: lookupTag });
    }
  }

  for (const [id, sightings] of idSightings) {
    if (sightings.count > 1) {
      for (const symbolKey of [...sightings.symbolKeys].sort(bytewise)) addSkip(skips, symbolKey, 'duplicate-memory-id', { id });
    }
  }
  for (const [id, candidate] of candidatesById) {
    if (idSightings.get(id).count === 1) mappings.push(candidate);
  }

  mappings.sort((a, b) => bytewise(a.symbolKey, b.symbolKey) || bytewise(a.id, b.id));
  skips.sort((a, b) => bytewise(a.symbolKey, b.symbolKey) || bytewise(a.reason, b.reason) || bytewise(a.id ?? '', b.id ?? ''));
  return {
    dryRun: true,
    coverage: {
      scope: 'known-index-keys-only',
      indexedKeys: symbolKeys.length,
      queriedTags: queriedTags.length,
      unknownTagsSearched: false,
      unknownTaggedMemories: 'excluded-not-queried',
      complete: !skips.some((skip) => skip.reason === 'lookup-truncated'),
    },
    mappings,
    skips,
  };
}
