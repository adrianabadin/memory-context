import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  readSyncManifest,
  writeSyncManifest,
  createSyncEntry,
  appendSyncEntry,
  appendSyncEntries,
  getPendingEntries,
  getPendingUpserts,
  getPendingDeletes,
  markEntriesSynced,
  removeSyncedEntries,
  clearManifest,
} from '../src/sync-manifest.mjs';

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'sync-manifest-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('sync-manifest', () => {
  describe('createSyncEntry', () => {
    it('creates an upsert entry with all fields', () => {
      const entry = createSyncEntry({
        action: 'upsert',
        keyTag: 'key:project-context:stack-runtime',
        content: '# Stack Runtime\n\nNode.js 20',
        category: 'architecture',
        tags: ['project-context', 'stack-runtime'],
        source: 'project-context',
      });

      assert.equal(entry.action, 'upsert');
      assert.equal(entry.key_tag, 'key:project-context:stack-runtime');
      assert.equal(entry.content, '# Stack Runtime\n\nNode.js 20');
      assert.equal(entry.category, 'architecture');
      assert.deepEqual(entry.tags, ['project-context', 'stack-runtime']);
      assert.equal(entry.status, 'pending');
      assert.equal(entry.source, 'project-context');
      assert.equal(entry.symbolKey, null);
      assert.ok(entry.id);
      assert.ok(entry.addedAt);
      assert.equal(entry.syncedAt, null);
    });

    it('creates a delete entry', () => {
      const entry = createSyncEntry({
        action: 'delete',
        keyTag: 'key:symbol:ts_src_foo_ts_function_myFunc',
        source: 'project-context-refresh',
        symbolKey: 'ts|src/foo.ts||MyClass|function|myFunc|()',
      });

      assert.equal(entry.action, 'delete');
      assert.equal(entry.key_tag, 'key:symbol:ts_src_foo_ts_function_myFunc');
      assert.equal(entry.content, null);
      assert.equal(entry.symbolKey, 'ts|src/foo.ts||MyClass|function|myFunc|()');
    });

    it('uses defaults for optional fields', () => {
      const entry = createSyncEntry({ action: 'upsert', keyTag: 'key:test' });

      assert.equal(entry.category, 'architecture');
      assert.deepEqual(entry.tags, []);
      assert.equal(entry.source, 'unknown');
      assert.equal(entry.symbolKey, null);
    });
  });

  describe('readSyncManifest / writeSyncManifest', () => {
    it('reads empty manifest when file does not exist', async () => {
      const manifest = await readSyncManifest(tmpDir);
      assert.deepEqual(manifest, { entries: [] });
    });

    it('round-trips manifest with entries', async () => {
      const entries = [
        createSyncEntry({ action: 'upsert', keyTag: 'key:a', content: 'A' }),
        createSyncEntry({ action: 'delete', keyTag: 'key:b' }),
      ];
      await writeSyncManifest(tmpDir, { entries });

      const read = await readSyncManifest(tmpDir);
      assert.equal(read.entries.length, 2);
      assert.equal(read.entries[0].key_tag, 'key:a');
      assert.equal(read.entries[1].key_tag, 'key:b');
    });

    it('throws on invalid JSON instead of silently resetting the manifest', async () => {
      await writeFile(join(tmpDir, 'sync-manifest.json'), '{invalid-json', 'utf8');
      await assert.rejects(() => readSyncManifest(tmpDir));
    });
  });

  describe('appendSyncEntry / appendSyncEntries', () => {
    it('appends single entry', async () => {
      const entry = createSyncEntry({ action: 'upsert', keyTag: 'key:x', content: 'X' });
      await appendSyncEntry(tmpDir, entry);

      const manifest = await readSyncManifest(tmpDir);
      assert.equal(manifest.entries.length, 1);
      assert.equal(manifest.entries[0].key_tag, 'key:x');
    });

    it('appends multiple entries', async () => {
      const entries = [
        createSyncEntry({ action: 'upsert', keyTag: 'key:1', content: '1' }),
        createSyncEntry({ action: 'upsert', keyTag: 'key:2', content: '2' }),
        createSyncEntry({ action: 'delete', keyTag: 'key:3' }),
      ];
      await appendSyncEntries(tmpDir, entries);

      const manifest = await readSyncManifest(tmpDir);
      assert.equal(manifest.entries.length, 3);
    });

    it('appends to existing entries', async () => {
      await appendSyncEntry(tmpDir, createSyncEntry({ action: 'upsert', keyTag: 'key:first' }));
      await appendSyncEntries(tmpDir, [
        createSyncEntry({ action: 'upsert', keyTag: 'key:second' }),
        createSyncEntry({ action: 'delete', keyTag: 'key:third' }),
      ]);

      const manifest = await readSyncManifest(tmpDir);
      assert.equal(manifest.entries.length, 3);
      assert.equal(manifest.entries[0].key_tag, 'key:first');
      assert.equal(manifest.entries[1].key_tag, 'key:second');
      assert.equal(manifest.entries[2].key_tag, 'key:third');
    });

    it('serializes concurrent appends without dropping entries', async () => {
      const entries = Array.from({ length: 20 }, (_, idx) => createSyncEntry({
        action: 'upsert',
        keyTag: `key:${idx}`,
        content: String(idx),
      }));

      await Promise.all(entries.map((entry) => appendSyncEntry(tmpDir, entry)));

      const manifest = await readSyncManifest(tmpDir);
      assert.equal(manifest.entries.length, 20);
      assert.equal(new Set(manifest.entries.map((entry) => entry.key_tag)).size, 20);
    });
  });

  describe('getPendingEntries / getPendingUpserts / getPendingDeletes', () => {
    it('filters by status and action', async () => {
      const e1 = createSyncEntry({ action: 'upsert', keyTag: 'key:a' });
      const e2 = createSyncEntry({ action: 'delete', keyTag: 'key:b' });
      const e3 = createSyncEntry({ action: 'upsert', keyTag: 'key:c' });
      e3.status = 'synced';
      await appendSyncEntries(tmpDir, [e1, e2, e3]);

      const manifest = await readSyncManifest(tmpDir);
      assert.equal(getPendingEntries(manifest).length, 2);
      assert.equal(getPendingUpserts(manifest).length, 1);
      assert.equal(getPendingUpserts(manifest)[0].key_tag, 'key:a');
      assert.equal(getPendingDeletes(manifest).length, 1);
      assert.equal(getPendingDeletes(manifest)[0].key_tag, 'key:b');
    });
  });

  describe('markEntriesSynced', () => {
    it('marks specific entries as synced', async () => {
      const e1 = createSyncEntry({ action: 'upsert', keyTag: 'key:a' });
      const e2 = createSyncEntry({ action: 'upsert', keyTag: 'key:b' });
      await appendSyncEntries(tmpDir, [e1, e2]);

      await markEntriesSynced(tmpDir, [e1.id]);

      const manifest = await readSyncManifest(tmpDir);
      assert.equal(manifest.entries[0].status, 'synced');
      assert.ok(manifest.entries[0].syncedAt);
      assert.equal(manifest.entries[1].status, 'pending');
      assert.equal(manifest.entries[1].syncedAt, null);
    });
  });

  describe('removeSyncedEntries', () => {
    it('removes synced entries keeping pending', async () => {
      const e1 = createSyncEntry({ action: 'upsert', keyTag: 'key:a' });
      const e2 = createSyncEntry({ action: 'upsert', keyTag: 'key:b' });
      e2.status = 'synced';
      e2.syncedAt = new Date().toISOString();
      await appendSyncEntries(tmpDir, [e1, e2]);

      const remaining = await removeSyncedEntries(tmpDir);
      assert.equal(remaining, 1);

      const manifest = await readSyncManifest(tmpDir);
      assert.equal(manifest.entries.length, 1);
      assert.equal(manifest.entries[0].key_tag, 'key:a');
    });
  });

  describe('clearManifest', () => {
    it('empties the manifest', async () => {
      await appendSyncEntries(tmpDir, [
        createSyncEntry({ action: 'upsert', keyTag: 'key:a' }),
        createSyncEntry({ action: 'delete', keyTag: 'key:b' }),
      ]);

      await clearManifest(tmpDir);

      const manifest = await readSyncManifest(tmpDir);
      assert.deepEqual(manifest, { entries: [] });
    });
  });

  describe('resumability', () => {
    it('survives partial processing (mark some synced, leave others pending)', async () => {
      const entries = [];
      for (let i = 0; i < 10; i++) {
        entries.push(createSyncEntry({ action: 'upsert', keyTag: `key:sym-${i}`, content: `Symbol ${i}`, source: 'enrich-queue' }));
      }
      await appendSyncEntries(tmpDir, entries);

      await markEntriesSynced(tmpDir, entries.slice(0, 5).map(e => e.id));

      const manifest = await readSyncManifest(tmpDir);
      assert.equal(getPendingEntries(manifest).length, 5);
      assert.equal(manifest.entries.filter(e => e.status === 'synced').length, 5);

      await removeSyncedEntries(tmpDir);

      const after = await readSyncManifest(tmpDir);
      assert.equal(after.entries.length, 5);
      assert.equal(getPendingEntries(after).length, 5);
    });
  });
});
