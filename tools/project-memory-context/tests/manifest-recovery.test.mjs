import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseConcatenatedManifests,
  recoverManifestEntries,
  repairManifestFile,
} from '../src/manifest-recovery.mjs';

let tmpDir;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'manifest-recovery-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function manifest(entries) {
  return { entries };
}

function entry(id, keyTag) {
  return {
    id,
    action: 'upsert',
    key_tag: keyTag,
    content: keyTag,
    category: 'architecture',
    tags: [],
    status: 'pending',
    source: 'test',
    symbolKey: null,
    addedAt: '2026-07-10T00:00:00.000Z',
    syncedAt: null,
  };
}

describe('parseConcatenatedManifests', () => {
  it('extracts a single document', () => {
    const raw = JSON.stringify(manifest([entry('a', 'key:a')]));
    const docs = parseConcatenatedManifests(raw);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].entries.length, 1);
  });

  it('extracts two concatenated documents separated by whitespace', () => {
    const raw = `${JSON.stringify(manifest([entry('a', 'key:a')]))}\n${JSON.stringify(manifest([entry('b', 'key:b')]))}`;
    const docs = parseConcatenatedManifests(raw);
    assert.equal(docs.length, 2);
    assert.equal(docs[0].entries[0].id, 'a');
    assert.equal(docs[1].entries[0].id, 'b');
  });

  it('recovers the first complete document and ignores a truncated tail', () => {
    const complete = JSON.stringify(manifest([entry('a', 'key:a')]));
    const raw = `${complete}\n{"entries":[{"id":"b","key_tag":"key:b`; // truncated second doc
    const docs = parseConcatenatedManifests(raw);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].entries[0].id, 'a');
  });

  it('respects braces inside string literals', () => {
    const raw = JSON.stringify(manifest([entry('a', 'key:{nested}[brackets]')]));
    const docs = parseConcatenatedManifests(raw);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].entries[0].key_tag, 'key:{nested}[brackets]');
  });
});

describe('recoverManifestEntries', () => {
  it('unions entries across documents and dedupes by id (last wins)', () => {
    const first = manifest([entry('a', 'key:a-old'), entry('b', 'key:b')]);
    const second = manifest([entry('a', 'key:a-new'), entry('c', 'key:c')]);
    const raw = `${JSON.stringify(first)}\n${JSON.stringify(second)}`;

    const recovered = recoverManifestEntries(raw);
    const byId = new Map(recovered.map((e) => [e.id, e]));

    assert.equal(recovered.length, 3);
    assert.equal(byId.get('a').key_tag, 'key:a-new');
    assert.ok(byId.has('b'));
    assert.ok(byId.has('c'));
  });

  it('throws when no recoverable document is present', () => {
    assert.throws(() => recoverManifestEntries('not json at all'));
  });
});

describe('repairManifestFile', () => {
  it('rewrites a concatenated file into one valid manifest and backs up the original', async () => {
    const filePath = join(tmpDir, 'sync-manifest.json');
    const first = manifest([entry('a', 'key:a')]);
    const second = manifest([entry('b', 'key:b')]);
    const corrupted = `${JSON.stringify(first, null, 2)}\n${JSON.stringify(second, null, 2)}`;
    await writeFile(filePath, corrupted, 'utf8');

    const result = await repairManifestFile(filePath);

    assert.equal(result.repaired, true);
    assert.equal(result.recovered, 2);
    assert.ok(result.backupPath);

    const repaired = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(repaired.entries.length, 2);

    const backup = await readFile(result.backupPath, 'utf8');
    assert.equal(backup, corrupted);
  });

  it('is a no-op on an already valid manifest', async () => {
    const filePath = join(tmpDir, 'sync-manifest.json');
    await writeFile(filePath, `${JSON.stringify(manifest([entry('a', 'key:a')]), null, 2)}\n`, 'utf8');

    const result = await repairManifestFile(filePath);

    assert.equal(result.repaired, false);
    assert.equal(result.recovered, 1);
    assert.equal(result.backupPath, null);
  });

  it('does not mutate the file when nothing can be recovered', async () => {
    const filePath = join(tmpDir, 'sync-manifest.json');
    await writeFile(filePath, 'total garbage, no json', 'utf8');

    await assert.rejects(() => repairManifestFile(filePath));

    const untouched = await readFile(filePath, 'utf8');
    assert.equal(untouched, 'total garbage, no json');
  });
});
