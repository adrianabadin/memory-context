import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MANIFEST_FILE = 'sync-manifest.json';
const manifestWriteLocks = new Map();

function manifestPath(enrichmentDir) {
  return join(enrichmentDir, MANIFEST_FILE);
}

export async function readSyncManifest(enrichmentDir) {
  try {
    const parsed = JSON.parse(await readFile(manifestPath(enrichmentDir), 'utf8'));
    // Migrate legacy array format → { entries: [...] }
    if (Array.isArray(parsed)) {
      return { entries: parsed };
    }
    if (!Array.isArray(parsed.entries)) {
      parsed.entries = [];
    }
    return parsed;
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      throw error;
    }
    return { entries: [] };
  }
}

export async function writeSyncManifest(enrichmentDir, manifest) {
  const path = manifestPath(enrichmentDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function withManifestLock(enrichmentDir, operation) {
  const path = manifestPath(enrichmentDir);
  const previous = manifestWriteLocks.get(path) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(operation);
  manifestWriteLocks.set(path, next);

  try {
    return await next;
  } finally {
    if (manifestWriteLocks.get(path) === next) {
      manifestWriteLocks.delete(path);
    }
  }
}

export function createSyncEntry({ action, keyTag, content, category, tags, source, symbolKey }) {
  return {
    id: randomUUID(),
    action,
    key_tag: keyTag,
    content: content || null,
    category: category || 'architecture',
    tags: tags || [],
    status: 'pending',
    source: source || 'unknown',
    symbolKey: symbolKey || null,
    addedAt: new Date().toISOString(),
    syncedAt: null,
  };
}

export async function appendSyncEntry(enrichmentDir, entry) {
  return withManifestLock(enrichmentDir, async () => {
    const manifest = await readSyncManifest(enrichmentDir);
    manifest.entries.push(entry);
    await writeSyncManifest(enrichmentDir, manifest);
    return entry;
  });
}

export async function appendSyncEntries(enrichmentDir, entries) {
  return withManifestLock(enrichmentDir, async () => {
    const manifest = await readSyncManifest(enrichmentDir);
    manifest.entries.push(...entries);
    await writeSyncManifest(enrichmentDir, manifest);
    return entries;
  });
}

export function getPendingEntries(manifest) {
  return manifest.entries.filter(e => e.status === 'pending');
}

export function getPendingUpserts(manifest) {
  return manifest.entries.filter(e => e.status === 'pending' && e.action === 'upsert');
}

export function getPendingDeletes(manifest) {
  return manifest.entries.filter(e => e.status === 'pending' && e.action === 'delete');
}

export async function markEntriesSynced(enrichmentDir, ids) {
  await withManifestLock(enrichmentDir, async () => {
    const manifest = await readSyncManifest(enrichmentDir);
    const idSet = new Set(ids);
    for (const entry of manifest.entries) {
      if (idSet.has(entry.id)) {
        entry.status = 'synced';
        entry.syncedAt = new Date().toISOString();
      }
    }
    await writeSyncManifest(enrichmentDir, manifest);
  });
}

export async function removeSyncedEntries(enrichmentDir) {
  return withManifestLock(enrichmentDir, async () => {
    const manifest = await readSyncManifest(enrichmentDir);
    manifest.entries = manifest.entries.filter(e => e.status !== 'synced');
    await writeSyncManifest(enrichmentDir, manifest);
    return manifest.entries.length;
  });
}

export async function clearManifest(enrichmentDir) {
  await withManifestLock(enrichmentDir, async () => {
    await writeSyncManifest(enrichmentDir, { entries: [] });
  });
}
