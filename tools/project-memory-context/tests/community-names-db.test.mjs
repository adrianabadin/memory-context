// tools/project-memory-context/tests/community-names-db.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Windows can briefly hold a lock on WAL sidecar files after close; retry rm.
function safeRm(path) {
  if (!existsSync(path)) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(path);
      return;
    } catch (err) {
      if (attempt === 4) return; // best-effort cleanup; do not fail the test
    }
  }
}

import {
  buildFromGraphJson,
  createSqliteGraphStore,
  openGraphDb,
} from '../src/graph-store/graph-db.mjs';

const FIXTURE = {
  nodes: [
    { id: 'a', label: 'A', source_file: 'src/a.ts', kind: 'function', community: 1, degree: 1 },
    { id: 'b', label: 'B', source_file: 'src/b.ts', kind: 'function', community: 1, degree: 3 },
  ],
  links: [],
};

// Mirror the real SCHEMA so the store CRUD methods have a table to operate on.
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, label TEXT, kind TEXT, source_file TEXT, community INTEGER, degree INTEGER, metadata TEXT);
    CREATE TABLE edges (source TEXT NOT NULL, target TEXT NOT NULL, relation TEXT NOT NULL);
    CREATE TABLE community_names (
      community_id TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      created_at   TEXT,
      updated_at   TEXT
    );
  `);
  return db;
}

function makeStore() {
  const db = makeDb();
  buildFromGraphJson(db, FIXTURE, 'test-hash');
  return createSqliteGraphStore(db);
}

// ── upsertCommunityName ────────────────────────────────────────────────────────

test('upsertCommunityName inserts a new community name', () => {
  const store = makeStore();
  store.upsertCommunityName('1', 'Graph Storage');
  assert.equal(store.getCommunityName('1'), 'Graph Storage');
});

test('upsertCommunityName overwrites an existing name for the same id', () => {
  const store = makeStore();
  store.upsertCommunityName('1', 'Old Name');
  store.upsertCommunityName('1', 'New Name');
  assert.equal(store.getCommunityName('1'), 'New Name');
  // Overwrite must not create a duplicate row
  const all = store.getAllCommunityNames();
  assert.equal(all.filter((c) => c.community_id === '1').length, 1);
});

test('upsertCommunityName sets created_at on insert and updated_at on update', () => {
  const store = makeStore();
  store.upsertCommunityName('7', 'First');
  const inserted = store.getAllCommunityNames().find((c) => c.community_id === '7');
  assert.ok(inserted.created_at, 'created_at should be set on insert');
  assert.ok(!isNaN(Date.parse(inserted.created_at)), 'created_at is a valid ISO date');

  store.upsertCommunityName('7', 'Second');
  const updated = store.getAllCommunityNames().find((c) => c.community_id === '7');
  assert.equal(updated.created_at, inserted.created_at, 'created_at is preserved across updates');
  assert.ok(!isNaN(Date.parse(updated.updated_at)), 'updated_at is a valid ISO date');
});

// ── getCommunityName ───────────────────────────────────────────────────────────

test('getCommunityName returns null for an unknown community', () => {
  const store = makeStore();
  assert.equal(store.getCommunityName('999'), null);
});

test('getCommunityName coerces numeric community ids to string lookup', () => {
  const store = makeStore();
  store.upsertCommunityName('2', 'Retrieval Layer');
  // Callers may pass a number (community column is INTEGER); lookup must still work.
  assert.equal(store.getCommunityName(2), 'Retrieval Layer');
});

// ── getAllCommunityNames ───────────────────────────────────────────────────────

test('getAllCommunityNames returns an empty array when none are stored', () => {
  const store = makeStore();
  assert.deepEqual(store.getAllCommunityNames(), []);
});

test('getAllCommunityNames returns every stored name', () => {
  const store = makeStore();
  store.upsertCommunityName('1', 'Graph Storage');
  store.upsertCommunityName('2', 'Retrieval Layer');
  const all = store.getAllCommunityNames();
  assert.equal(all.length, 2);
  const byId = Object.fromEntries(all.map((c) => [c.community_id, c.name]));
  assert.deepEqual(byId, { 1: 'Graph Storage', 2: 'Retrieval Layer' });
});

// ── deleteCommunityName ────────────────────────────────────────────────────────

test('deleteCommunityName removes a stored name', () => {
  const store = makeStore();
  store.upsertCommunityName('1', 'Graph Storage');
  store.deleteCommunityName('1');
  assert.equal(store.getCommunityName('1'), null);
  assert.deepEqual(store.getAllCommunityNames(), []);
});

test('deleteCommunityName leaves other names intact', () => {
  const store = makeStore();
  store.upsertCommunityName('1', 'Graph Storage');
  store.upsertCommunityName('2', 'Retrieval Layer');
  store.deleteCommunityName('1');
  assert.equal(store.getCommunityName('1'), null);
  assert.equal(store.getCommunityName('2'), 'Retrieval Layer');
});

// ── Migration: openGraphDb creates community_names on existing DBs ──────────────

test('openGraphDb creates the community_names table on a fresh DB', () => {
  const dir = tmpdir();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dbPath = join(dir, `pmc-cn-${stamp}.db`);
  const jsonPath = join(dir, `pmc-cn-${stamp}.json`);

  try {
    writeFileSync(jsonPath, JSON.stringify(FIXTURE), 'utf8');
    const store = openGraphDb(dbPath, jsonPath);
    // Table must exist and be writable through the store.
    store.upsertCommunityName('1', 'Graph Storage');
    assert.equal(store.getCommunityName('1'), 'Graph Storage');
    store.close();
  } finally {
    for (const p of [dbPath, dbPath + '-shm', dbPath + '-wal', jsonPath]) {
      safeRm(p);
    }
  }
});

test('openGraphDb adds community_names table to a pre-existing DB without it (migration)', () => {
  const dir = tmpdir();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dbPath = join(dir, `pmc-mig-${stamp}.db`);
  const jsonPath = join(dir, `pmc-mig-${stamp}.json`);

  try {
    // Simulate a legacy DB built before community_names existed: only nodes/edges/meta.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE nodes (id TEXT PRIMARY KEY, label TEXT, kind TEXT, source_file TEXT, community INTEGER, degree INTEGER, metadata TEXT);
      CREATE TABLE edges (source TEXT NOT NULL, target TEXT NOT NULL, relation TEXT NOT NULL);
    `);
    legacy.close();

    writeFileSync(jsonPath, JSON.stringify(FIXTURE), 'utf8');
    const store = openGraphDb(dbPath, jsonPath);
    // Migration via CREATE TABLE IF NOT EXISTS must make the table available.
    store.upsertCommunityName('3', 'Migrated Community');
    assert.equal(store.getCommunityName('3'), 'Migrated Community');
    store.close();
  } finally {
    for (const p of [dbPath, dbPath + '-shm', dbPath + '-wal', jsonPath]) {
      safeRm(p);
    }
  }
});
