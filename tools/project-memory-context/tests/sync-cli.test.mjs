import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findMemoriesByKeyTag,
  applySyncEntry,
  syncPendingEntries,
  main,
} from '../cli/sync.mjs';

function toolResult(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
  };
}

function syncEntry(id, keyTag, action = 'upsert') {
  return { id, status: 'pending', action, key_tag: keyTag, content: id, category: 'architecture', tags: [] };
}

// Client stub where every lookup misses and every upsert stores a new memory.
function missThenStoreClient(calls) {
  return {
    async callTool(request) {
      calls.push(request);
      if (request.name === 'search') return toolResult({ count: 0, results: [] });
      if (request.name === 'store') return toolResult({ id: `mem-${calls.length}` });
      throw new Error(`unexpected tool ${request.name}`);
    },
  };
}

function makeBackgroundDeps({ entries, stateWrites = [], committed = [], clientCallTool, heartbeat = async () => true } = {}) {
  return {
    SyncLock: class {
      async acquire() { return true; }
      async heartbeat() { return heartbeat(); }
      async isOwner() { return true; }
      async release() {}
    },
    writeSyncState: async (path, state) => {
      stateWrites.push({ path, state: JSON.parse(JSON.stringify(state)) });
    },
    readSyncManifest: async () => ({ entries }),
    markEntriesSynced: async (dir, ids) => { committed.push(ids.length); },
    loadAgentMemoryConfig: async () => ({ command: 'node', args: [] }),
    Client: class {
      async connect() {}
      async callTool(request) {
        if (clientCallTool) return clientCallTool(request);
        if (request.name === 'search') return toolResult({ count: 0, results: [] });
        if (request.name === 'store') return toolResult({ id: 'mem' });
        throw new Error(`unexpected tool ${request.name}`);
      }
      async close() {}
    },
    StdioClientTransport: class {},
    log: () => {},
    errLog: () => {},
    ENRICHMENT_DIR: '/fake/enrichment',
    PROJECT_ROOT: '/fake/root',
  };
}

test('findMemoriesByKeyTag searches by query and tag', async () => {
  const calls = [];
  const client = {
    async callTool(request) {
      calls.push(request);
      return toolResult({
        count: 1,
        results: [
          {
            memory: {
              id: 'memory-1',
              content: 'existing',
              category: 'architecture',
              tags: ['key:test'],
            },
          },
        ],
      });
    },
  };

  const memories = await findMemoriesByKeyTag(client, 'key:test');

  assert.deepEqual(memories, [
    {
      id: 'memory-1',
      content: 'existing',
      category: 'architecture',
      tags: ['key:test'],
    },
  ]);
  assert.deepEqual(calls, [
    {
      name: 'search',
      arguments: {
        query: 'key:test',
        tags: ['key:test'],
        limit: 100,
      },
    },
  ]);
});

test('applySyncEntry updates existing memory for upsert entries', async () => {
  const calls = [];
  const client = {
    async callTool(request) {
      calls.push(request);
      if (request.name === 'search') {
        return toolResult({
          count: 1,
          results: [{ memory: { id: 'memory-1', tags: ['key:test'] } }],
        });
      }
      if (request.name === 'update') {
        return toolResult({ id: 'memory-1' });
      }
      throw new Error(`unexpected tool ${request.name}`);
    },
  };

  await applySyncEntry(client, {
    id: 'entry-1',
    action: 'upsert',
    key_tag: 'key:test',
    content: 'updated content',
    category: 'architecture',
    tags: ['project-context'],
  });

  assert.deepEqual(calls, [
    {
      name: 'search',
      arguments: {
        query: 'key:test',
        tags: ['key:test'],
        limit: 100,
      },
    },
    {
      name: 'update',
      arguments: {
        id: 'memory-1',
        content: 'updated content',
        category: 'architecture',
        tags: ['project-context', 'key:test'],
      },
    },
  ]);
});

test('applySyncEntry converges duplicate matches for upsert entries', async () => {
  const calls = [];
  const client = {
    async callTool(request) {
      calls.push(request);
      if (request.name === 'search') {
        return toolResult({
          count: 3,
          results: [
            { memory: { id: 'memory-2', tags: ['key:test'] } },
            { memory: { id: 'memory-1', tags: ['key:test'] } },
            { memory: { id: 'memory-3', tags: ['key:test'] } },
          ],
        });
      }
      if (request.name === 'update') {
        return toolResult({ id: request.arguments.id });
      }
      if (request.name === 'delete') {
        return toolResult({ deleted: true, id: request.arguments.id });
      }
      throw new Error(`unexpected tool ${request.name}`);
    },
  };

  await applySyncEntry(client, {
    id: 'entry-dup',
    action: 'upsert',
    key_tag: 'key:test',
    content: 'updated content',
    category: 'architecture',
    tags: ['project-context'],
  });

  assert.deepEqual(calls, [
    {
      name: 'search',
      arguments: {
        query: 'key:test',
        tags: ['key:test'],
        limit: 100,
      },
    },
    {
      name: 'update',
      arguments: {
        id: 'memory-1',
        content: 'updated content',
        category: 'architecture',
        tags: ['project-context', 'key:test'],
      },
    },
    { name: 'delete', arguments: { id: 'memory-2' } },
    { name: 'delete', arguments: { id: 'memory-3' } },
  ]);
});

test('applySyncEntry stores a new memory when an upsert lookup misses', async () => {
  const calls = [];
  const client = {
    async callTool(request) {
      calls.push(request);
      if (request.name === 'search') {
        return toolResult({ count: 0, results: [] });
      }
      if (request.name === 'store') {
        return toolResult({ id: 'memory-2' });
      }
      throw new Error(`unexpected tool ${request.name}`);
    },
  };

  await applySyncEntry(client, {
    id: 'entry-2',
    action: 'upsert',
    key_tag: 'key:new',
    content: 'new content',
    category: 'architecture',
    tags: ['project-context', 'key:new'],
  });

  assert.deepEqual(calls, [
    {
      name: 'search',
      arguments: {
        query: 'key:new',
        tags: ['key:new'],
        limit: 100,
      },
    },
    {
      name: 'store',
      arguments: {
        content: 'new content',
        category: 'architecture',
        tags: ['project-context', 'key:new'],
      },
    },
  ]);
});

test('applySyncEntry deletes all matching memories for delete entries', async () => {
  const calls = [];
  const client = {
    async callTool(request) {
      calls.push(request);
      if (request.name === 'search') {
        return toolResult({
          count: 2,
          results: [
            { memory: { id: 'memory-1' } },
            { memory: { id: 'memory-2' } },
          ],
        });
      }
      if (request.name === 'delete') {
        return toolResult({ deleted: true, id: request.arguments.id });
      }
      throw new Error(`unexpected tool ${request.name}`);
    },
  };

  await applySyncEntry(client, {
    id: 'entry-3',
    action: 'delete',
    key_tag: 'key:gone',
    content: null,
    category: 'architecture',
    tags: [],
  });

  assert.deepEqual(calls, [
    {
      name: 'search',
      arguments: {
        query: 'key:gone',
        tags: ['key:gone'],
        limit: 100,
      },
    },
    { name: 'delete', arguments: { id: 'memory-1' } },
    { name: 'delete', arguments: { id: 'memory-2' } },
  ]);
});

test('syncPendingEntries marks only successful entries as synced', async () => {
  const syncedIds = [];
  const calls = [];
  const client = {
    async callTool(request) {
      calls.push(request);
      if (request.name === 'search' && request.arguments.query === 'key:ok') {
        return toolResult({ count: 0, results: [] });
      }
      if (request.name === 'store') {
        return toolResult({ id: 'memory-ok' });
      }
      if (request.name === 'search' && request.arguments.query === 'key:fail') {
        return toolResult({ count: 1, results: [{ memory: { id: 'memory-fail' } }] });
      }
      if (request.name === 'delete') {
        return { isError: true, content: [{ type: 'text', text: 'Delete failed' }] };
      }
      throw new Error(`unexpected tool ${request.name}`);
    },
  };

  const result = await syncPendingEntries(client, [
    {
      id: 'entry-ok',
      action: 'upsert',
      key_tag: 'key:ok',
      content: 'ok',
      category: 'architecture',
      tags: [],
    },
    {
      id: 'entry-fail',
      action: 'delete',
      key_tag: 'key:fail',
      content: null,
      category: 'architecture',
      tags: [],
    },
  ], {
    async markSynced(ids) {
      syncedIds.push(...ids);
    },
  });

  assert.equal(result.synced, 1);
  assert.equal(result.errors, 1);
  assert.deepEqual(syncedIds, ['entry-ok']);
});

test('syncPendingEntries stops before later entries when beforeEntry aborts', async () => {
  const calls = [];
  const client = {
    async callTool(request) {
      calls.push(request);
      if (request.name === 'search') return toolResult({ count: 0, results: [] });
      if (request.name === 'store') return toolResult({ id: 'mem' });
      throw new Error(`unexpected tool ${request.name}`);
    },
  };
  const markSyncedIds = [];
  const entries = ['a', 'b', 'c'].map((k) => ({
    id: `entry-${k}`,
    status: 'pending',
    action: 'upsert',
    key_tag: `key:${k}`,
    content: k,
    category: 'architecture',
    tags: [],
  }));

  const result = await syncPendingEntries(client, entries, {
    markSynced: async (ids) => { markSyncedIds.push(...ids); },
    beforeEntry: async (entry) => {
      if (entry.id === 'entry-b') {
        const error = new Error('abort before b');
        error.syncAbort = true;
        throw error;
      }
    },
  });

  // Batched checkpoints: entry a was applied but its batch was never
  // committed once the abort fired, so nothing counts as synced and the
  // entry stays pending for the next (idempotent) run.
  assert.equal(result.synced, 0);
  assert.equal(result.errors, 0);
  assert.match(result.aborted, /abort before b/);
  assert.deepEqual(markSyncedIds, []);
  assert.equal(calls.filter(c => c.name === 'store').length, 1); // a was applied
  // Entry b and c are never mutated once the abort fires.
  assert.ok(!calls.some(c => c.arguments?.query === 'key:b'));
  assert.ok(!calls.some(c => c.arguments?.query === 'key:c'));
});

test('syncPendingEntries gates the checkpoint behind beforeEntry', async () => {
  const calls = [];
  const client = {
    async callTool(request) {
      calls.push(request);
      if (request.name === 'search') return toolResult({ count: 0, results: [] });
      if (request.name === 'store') return toolResult({ id: 'mem' });
      throw new Error(`unexpected tool ${request.name}`);
    },
  };
  const markSyncedIds = [];
  const entries = [{
    id: 'entry-a',
    status: 'pending',
    action: 'upsert',
    key_tag: 'key:a',
    content: 'a',
    category: 'architecture',
    tags: [],
  }];

  const result = await syncPendingEntries(client, entries, {
    markSynced: async (ids) => { markSyncedIds.push(...ids); },
    beforeEntry: async (entry, phase) => {
      if (phase === 'pre-checkpoint') {
        const error = new Error('lost before checkpoint');
        error.syncAbort = true;
        throw error;
      }
    },
  });

  // The mutation ran, but the checkpoint never did: not counted as synced.
  assert.equal(calls.filter(c => c.name === 'store').length, 1);
  assert.deepEqual(markSyncedIds, []);
  assert.equal(result.synced, 0);
  assert.equal(result.errors, 0);
  assert.match(result.aborted, /lost before checkpoint/);
});

test('main in --detach mode spawns worker and exits 0', async () => {
  const spawnCalls = [];
  const logCalls = [];
  const fsCalls = [];

  const deps = {
    spawnBackground: (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      return 12345;
    },
    openLogFile: async (path) => {
      fsCalls.push({ action: 'open', path });
      return { fd: 99, close: async () => { fsCalls.push({ action: 'close', fd: 99 }); } };
    },
    log: (msg) => logCalls.push(msg),
    ENRICHMENT_DIR: '/fake/enrichment',
    PROJECT_ROOT: '/fake/root',
  };

  const exitCode = await main(['node', 'cli/sync.mjs', '--detach'], deps);

  assert.equal(exitCode, 0);
  assert.equal(spawnCalls.length, 1);
  assert.ok(spawnCalls[0].args.includes('--background'));
  assert.equal(spawnCalls[0].opts.stdio[1], 99);
  assert.equal(spawnCalls[0].opts.stdio[2], 99);
  assert.ok(logCalls.some(m => m.includes('12345')));
  assert.ok(fsCalls.some(f => f.action === 'close' && f.fd === 99));
});

test('main in --background mode acquires lock, updates sync state, runs sync, and releases lock', async () => {
  const logCalls = [];
  const stateWrites = [];
  const lockCalls = [];
  let clientCloses = 0;

  const deps = {
    SyncLock: class {
      constructor(path) {
        this.path = path;
      }
      async acquire(pid) {
        lockCalls.push({ action: 'acquire', pid });
        return true;
      }
      async heartbeat() {
        lockCalls.push({ action: 'heartbeat' });
      }
      async isOwner() {
        return true;
      }
      async release() {
        lockCalls.push({ action: 'release' });
      }
    },
    writeSyncState: async (path, state) => {
      stateWrites.push({ path, state: JSON.parse(JSON.stringify(state)) });
    },
    readSyncManifest: async () => ({ entries: [{ id: '1', status: 'pending', action: 'upsert', key_tag: 'key:1', content: 'c' }] }),
    markEntriesSynced: async () => {},
    loadAgentMemoryConfig: async () => ({ command: 'node', args: [] }),
    Client: class {
      async connect() {}
      async callTool(request) {
        if (request.name === 'search') return toolResult({ count: 0, results: [] });
        return toolResult({ id: 'mem-1' });
      }
      async close() { clientCloses += 1; }
    },
    StdioClientTransport: class {},
    log: (msg) => logCalls.push(msg),
    ENRICHMENT_DIR: '/fake/enrichment',
    PROJECT_ROOT: '/fake/root',
  };

  const exitCode = await main(['node', 'cli/sync.mjs', '--background'], deps);

  assert.equal(exitCode, 0);
  // Exactly-once MCP cleanup on the success path too.
  assert.equal(clientCloses, 1);
  // Mutual-exclusion guarantees retained: acquire first and exactly one
  // release, last. Exact action counts are not asserted because heartbeat
  // ticks from the unref'd 10s timer may interleave under load.
  assert.equal(lockCalls[0].action, 'acquire');
  assert.equal(lockCalls[0].pid, process.pid);
  assert.equal(lockCalls.filter(c => c.action === 'release').length, 1);
  assert.equal(lockCalls.at(-1).action, 'release');
  assert.ok(stateWrites.some(w => w.state.status === 'running'));
  assert.ok(stateWrites.some(w => w.state.status === 'finished'));
});

test('main in --background mode writes failed status and releases lock on error', async () => {
  const logCalls = [];
  const stateWrites = [];
  const lockCalls = [];

  const deps = {
    SyncLock: class {
      constructor(path) {
        this.path = path;
      }
      async acquire() {
        lockCalls.push({ action: 'acquire' });
        return true;
      }
      async isOwner() {
        return true;
      }
      async release() {
        lockCalls.push({ action: 'release' });
      }
    },
    writeSyncState: async (path, state) => {
      stateWrites.push({ path, state: JSON.parse(JSON.stringify(state)) });
    },
    readSyncManifest: async () => {
      throw new Error('manifest read error');
    },
    log: (msg) => logCalls.push(msg),
    ENRICHMENT_DIR: '/fake/enrichment',
    PROJECT_ROOT: '/fake/root',
  };

  const exitCode = await main(['node', 'cli/sync.mjs', '--background'], deps);

  assert.equal(exitCode, 1);
  assert.deepEqual(lockCalls, [
    { action: 'acquire' },
    { action: 'release' }
  ]);
  assert.ok(stateWrites.some(w => w.state.status === 'running'));
  assert.ok(stateWrites.some(w => w.state.status === 'failed' && w.state.lastError === 'manifest read error'));
});

test('main in --background mode logs skip and exits 0 when lock cannot be acquired', async () => {
  const logCalls = [];
  const lockCalls = [];

  const deps = {
    SyncLock: class {
      constructor(path) {
        this.path = path;
      }
      async acquire() {
        lockCalls.push({ action: 'acquire' });
        return false;
      }
      async release() {
        lockCalls.push({ action: 'release' });
      }
    },
    log: (msg) => logCalls.push(msg),
    ENRICHMENT_DIR: '/fake/enrichment',
    PROJECT_ROOT: '/fake/root',
  };

  const exitCode = await main(['node', 'cli/sync.mjs', '--background'], deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(lockCalls, [{ action: 'acquire' }]);
  assert.ok(logCalls.some(m => m.includes('skip') || m.includes('another sync') || m.includes('running') || m.includes('busy')));
});

test('main foreground skips without launching MCP when the sync lock is held', async () => {
  const logCalls = [];
  const lockCalls = [];
  const counters = { manifestReads: 0, connects: 0 };

  const deps = {
    SyncLock: class {
      constructor(path) {
        this.path = path;
      }
      async acquire(pid) {
        lockCalls.push({ action: 'acquire', pid });
        return false;
      }
      async release() {
        lockCalls.push({ action: 'release' });
      }
    },
    readSyncManifest: async () => {
      counters.manifestReads += 1;
      return { entries: [{ id: '1', status: 'pending', action: 'upsert', key_tag: 'key:1', content: 'c' }] };
    },
    loadAgentMemoryConfig: async () => {
      throw new Error('must not load MCP config while lock is held');
    },
    Client: class {
      async connect() {
        counters.connects += 1;
      }
    },
    StdioClientTransport: class {},
    log: (msg) => logCalls.push(msg),
    ENRICHMENT_DIR: '/fake/enrichment',
    PROJECT_ROOT: '/fake/root',
  };

  const exitCode = await main(['node', 'cli/sync.mjs'], deps);

  assert.equal(exitCode, 1);
  assert.deepEqual(lockCalls, [{ action: 'acquire', pid: process.pid }]);
  assert.equal(counters.manifestReads, 0);
  assert.equal(counters.connects, 0);
  assert.ok(logCalls.some(m => /already running|held|another sync/i.test(m)));
});

test('main foreground acquires the lock, syncs, and releases it', async () => {
  const logCalls = [];
  const lockCalls = [];
  const calls = [];
  let clientCloses = 0;

  const deps = {
    SyncLock: class {
      constructor(path) {
        this.path = path;
      }
      async acquire(pid) {
        lockCalls.push({ action: 'acquire', pid });
        return true;
      }
      async isOwner() {
        return true;
      }
      async release() {
        lockCalls.push({ action: 'release' });
      }
    },
    readSyncManifest: async () => ({
      entries: [{ id: '1', status: 'pending', action: 'upsert', key_tag: 'key:1', content: 'c' }],
    }),
    markEntriesSynced: async () => {},
    loadAgentMemoryConfig: async () => ({ command: 'node', args: [] }),
    Client: class {
      async connect() {}
      async callTool(request) {
        calls.push(request);
        if (request.name === 'search') return toolResult({ count: 0, results: [] });
        if (request.name === 'store') return toolResult({ id: 'mem-1' });
        throw new Error(`unexpected tool ${request.name}`);
      }
      async close() { clientCloses += 1; }
    },
    StdioClientTransport: class {},
    log: (msg) => logCalls.push(msg),
    ENRICHMENT_DIR: '/fake/enrichment',
    PROJECT_ROOT: '/fake/root',
  };

  const exitCode = await main(['node', 'cli/sync.mjs'], deps);

  assert.equal(exitCode, 0);
  // Exactly-once MCP cleanup on the success path too.
  assert.equal(clientCloses, 1);
  assert.deepEqual(lockCalls, [
    { action: 'acquire', pid: process.pid },
    { action: 'release' },
  ]);
  assert.ok(logCalls.some(m => m.includes('Done')));
  assert.equal(calls.filter(c => c.name === 'store').length, 1);
});

test('main foreground releases the lock when the MCP connect fails', async () => {
  const lockCalls = [];
  let clientCloses = 0;

  const deps = {
    SyncLock: class {
      constructor(path) {
        this.path = path;
      }
      async acquire(pid) {
        lockCalls.push({ action: 'acquire', pid });
        return true;
      }
      async release() {
        lockCalls.push({ action: 'release' });
      }
    },
    readSyncManifest: async () => ({
      entries: [{ id: '1', status: 'pending', action: 'upsert', key_tag: 'key:1', content: 'c' }],
    }),
    loadAgentMemoryConfig: async () => ({ command: 'node', args: [] }),
    Client: class {
      async connect() {
        throw new Error('spawn ENOENT');
      }
      async close() { clientCloses += 1; }
    },
    StdioClientTransport: class {},
    log: () => {},
    errLog: () => {},
    ENRICHMENT_DIR: '/fake/enrichment',
    PROJECT_ROOT: '/fake/root',
  };

  await assert.rejects(
    () => main(['node', 'cli/sync.mjs'], deps),
    /Failed to connect to agent-memory/
  );

  assert.deepEqual(lockCalls, [
    { action: 'acquire', pid: process.pid },
    { action: 'release' },
  ]);
  // The client was created before connect failed: it must still be closed
  // exactly once so the spawned MCP child never leaks.
  assert.equal(clientCloses, 1);
});

test('main in --background mode closes the MCP client exactly once when connect fails', async () => {
  const stateWrites = [];
  const lockCalls = [];
  let clientCloses = 0;
  const deps = makeBackgroundDeps({
    entries: [syncEntry('1', 'key:1')],
    stateWrites,
  });
  deps.SyncLock = class {
    async acquire() { return true; }
    async heartbeat() { return true; }
    async isOwner() { return true; }
    async release() { lockCalls.push('release'); }
  };
  deps.Client = class {
    async connect() { throw new Error('spawn ENOENT'); }
    async close() { clientCloses += 1; }
  };

  const exitCode = await main(['node', 'cli/sync.mjs', '--background'], deps);

  // Connect failure is fatal but the created client must still be closed
  // exactly once, and the lock must still be released.
  assert.equal(exitCode, 1);
  assert.equal(clientCloses, 1);
  assert.deepEqual(lockCalls, ['release']);
  const failed = stateWrites.find(w => w.state.status === 'failed');
  assert.ok(failed);
  assert.match(failed.state.lastError ?? '', /spawn ENOENT/);
});

test('main in --background mode closes the MCP client exactly once when the run throws, without masking the error', async () => {
  const stateWrites = [];
  let clientCloses = 0;
  const deps = makeBackgroundDeps({
    entries: [syncEntry('1', 'key:bad')],
    stateWrites,
    clientCallTool: (request) => {
      if (request.name === 'search') {
        return { isError: true, content: [{ type: 'text', text: 'lookup failed' }] };
      }
      throw new Error(`unexpected tool ${request.name}`);
    },
  });
  // The per-entry reporter (errLog) throwing simulates a mid-run failure
  // escaping the sync pipeline; client.close() throwing on top verifies
  // that cleanup failures never mask the primary error.
  deps.errLog = (msg) => {
    if (/Entry .* failed/.test(String(msg))) throw new Error('logger exploded');
  };
  const BaseClient = deps.Client;
  deps.Client = class extends BaseClient {
    async close() { clientCloses += 1; throw new Error('close boom'); }
  };

  const exitCode = await main(['node', 'cli/sync.mjs', '--background'], deps);

  assert.equal(exitCode, 1);
  assert.equal(clientCloses, 1);
  const failed = stateWrites.find(w => w.state.status === 'failed');
  assert.ok(failed);
  // The primary failure survives; the close failure never replaces it.
  assert.match(failed.state.lastError ?? '', /logger exploded/);
  assert.doesNotMatch(failed.state.lastError ?? '', /close boom/);
});

test('main foreground closes the MCP client exactly once when the run throws, without masking the error', async () => {
  const lockCalls = [];
  let clientCloses = 0;
  const deps = {
    SyncLock: class {
      async acquire() { return true; }
      async isOwner() { return true; }
      async release() { lockCalls.push('release'); }
    },
    readSyncManifest: async () => ({ entries: [syncEntry('1', 'key:bad')] }),
    markEntriesSynced: async () => {},
    loadAgentMemoryConfig: async () => ({ command: 'node', args: [] }),
    Client: class {
      async connect() {}
      async callTool(request) {
        if (request.name === 'search') {
          return { isError: true, content: [{ type: 'text', text: 'lookup failed' }] };
        }
        throw new Error(`unexpected tool ${request.name}`);
      }
      async close() { clientCloses += 1; throw new Error('close boom'); }
    },
    StdioClientTransport: class {},
    log: () => {},
    errLog: (msg) => {
      if (/Entry .* failed/.test(String(msg))) throw new Error('logger exploded');
    },
    ENRICHMENT_DIR: '/fake/enrichment',
    PROJECT_ROOT: '/fake/root',
  };

  await assert.rejects(
    () => main(['node', 'cli/sync.mjs'], deps),
    /logger exploded/,
  );
  assert.equal(clientCloses, 1);
  assert.deepEqual(lockCalls, ['release']);
});

test('main in --background mode aborts remaining sync work when lock ownership is lost', async () => {
  const logCalls = [];
  const errCalls = [];
  const stateWrites = [];
  const lockCalls = [];
  const syncedIds = [];
  const toolCalls = [];

  const deps = {
    SyncLock: class {
      constructor(path) {
        this.path = path;
      }
      async acquire(pid) {
        lockCalls.push({ action: 'acquire', pid });
        return true;
      }
      async heartbeat() {
        lockCalls.push({ action: 'heartbeat' });
        return false; // ownership was taken over
      }
      async isOwner() {
        return true;
      }
      async release() {
        lockCalls.push({ action: 'release' });
        return false;
      }
    },
    writeSyncState: async (path, state) => {
      stateWrites.push({ path, state: JSON.parse(JSON.stringify(state)) });
    },
    readSyncManifest: async () => ({
      entries: [
        { id: '1', status: 'pending', action: 'upsert', key_tag: 'key:1', content: 'c1' },
        { id: '2', status: 'pending', action: 'upsert', key_tag: 'key:2', content: 'c2' },
      ],
    }),
    markEntriesSynced: async (dir, ids) => { syncedIds.push(...ids); },
    loadAgentMemoryConfig: async () => ({ command: 'node', args: [] }),
    Client: class {
      async connect() {}
      async callTool(request) {
        toolCalls.push(request);
        if (request.name === 'search') return toolResult({ count: 0, results: [] });
        if (request.name === 'store') return toolResult({ id: 'mem-1' });
        throw new Error(`unexpected tool ${request.name}`);
      }
      async close() {}
    },
    StdioClientTransport: class {},
    log: (msg) => logCalls.push(msg),
    errLog: (msg) => errCalls.push(msg),
    ENRICHMENT_DIR: '/fake/enrichment',
    PROJECT_ROOT: '/fake/root',
  };

  // Batch size 1 makes every entry its own checkpoint, so the heartbeat in
  // the progress callback runs between the two entries and detects the loss.
  const exitCode = await main(['node', 'cli/sync.mjs', '--background', '--checkpoint-batch-size', '1'], deps);

  // Ownership loss aborts: nonzero failed exit, no "finished" state.
  assert.equal(exitCode, 1);
  // Entry 1 completed before the loss was detected; entry 2 is never mutated.
  assert.deepEqual(syncedIds, ['1']);
  assert.ok(toolCalls.some(c => c.arguments?.query === 'key:1'));
  assert.ok(!toolCalls.some(c => c.arguments?.query === 'key:2'));
  // Truthful state: partial progress preserved under "failed", not zeroed.
  const failed = stateWrites.find(w => w.state.status === 'failed');
  assert.ok(failed);
  assert.equal(failed.state.summary.synced, 1);
  assert.equal(failed.state.summary.pending, 1);
  assert.match(failed.state.lastError ?? '', /ownership/);
  assert.ok(errCalls.some(m => /ownership|abort/i.test(m)));
  assert.equal(lockCalls[0].action, 'acquire');
  assert.equal(lockCalls[lockCalls.length - 1].action, 'release');
});

test('syncPendingEntries commits checkpoints in batches of 25 by default', async () => {
  const batches = [];
  const entries = Array.from({ length: 60 }, (_, i) => syncEntry(`e${i}`, `key:${i}`));

  const result = await syncPendingEntries(missThenStoreClient([]), entries, {
    markSynced: async (ids) => { batches.push([...ids]); },
  });

  assert.equal(result.synced, 60);
  assert.equal(result.errors, 0);
  // Quantified write reduction: 3 manifest checkpoints instead of 60
  // per-entry writes, with the final remainder flushed.
  assert.deepEqual(batches.map(b => b.length), [25, 25, 10]);
  assert.deepEqual(batches.flat(), entries.map(e => e.id));
});

test('syncPendingEntries honors checkpointBatchSize and rejects out-of-range values', async () => {
  const batches = [];
  const entries = Array.from({ length: 5 }, (_, i) => syncEntry(`e${i}`, `key:${i}`));

  await syncPendingEntries(missThenStoreClient([]), entries, {
    checkpointBatchSize: 2,
    markSynced: async (ids) => { batches.push(ids.length); },
  });
  assert.deepEqual(batches, [2, 2, 1]);

  for (const bad of [0, -1, 2.5, 'abc', 100000]) {
    await assert.rejects(
      () => syncPendingEntries(missThenStoreClient([]), entries, { checkpointBatchSize: bad }),
      /checkpointBatchSize/,
    );
  }
});

test('syncPendingEntries treats a checkpoint failure as fatal and counts only committed ids', async () => {
  const calls = [];
  const entries = Array.from({ length: 30 }, (_, i) => syncEntry(`e${i}`, `key:${i}`));

  const result = await syncPendingEntries(missThenStoreClient(calls), entries, {
    markSynced: async () => { throw new Error('disk full'); },
  });

  assert.equal(result.synced, 0);
  assert.equal(result.errors, 0);
  assert.match(result.aborted, /checkpoint failed: disk full/);
  // The run stops at the failed checkpoint; later entries are never applied.
  assert.equal(calls.filter(c => c.name === 'store').length, 25);

  // Partial commits: the first checkpoint is durable, the second fails, so
  // synced counts only the 25 committed ids.
  let markCalls = 0;
  const partial = await syncPendingEntries(missThenStoreClient([]), entries, {
    markSynced: async () => { markCalls += 1; if (markCalls === 2) throw new Error('io error'); },
  });
  assert.equal(partial.synced, 25);
  assert.match(partial.aborted, /checkpoint failed: io error/);
});

test('syncPendingEntries halts later entries for a failed key and keeps other keys running', async () => {
  const calls = [];
  const reported = [];
  const syncedIds = [];
  const client = {
    async callTool(request) {
      calls.push(request);
      if (request.name === 'search' && request.arguments.query === 'key:bad') {
        return { isError: true, content: [{ type: 'text', text: 'lookup failed' }] };
      }
      if (request.name === 'search') return toolResult({ count: 0, results: [] });
      if (request.name === 'store') return toolResult({ id: `mem-${calls.length}` });
      throw new Error(`unexpected tool ${request.name}`);
    },
  };

  const result = await syncPendingEntries(client, [
    syncEntry('a', 'key:bad'),
    syncEntry('b', 'key:bad'),
    syncEntry('c', 'key:good'),
  ], {
    markSynced: async (ids) => { syncedIds.push(...ids); },
    onError: (report) => reported.push(report),
  });

  assert.equal(result.synced, 1);
  assert.equal(result.errors, 1);
  assert.equal(result.halted, 1);
  // key:bad is looked up exactly once: the failed entry halts its successor.
  assert.equal(calls.filter(c => c.arguments?.query === 'key:bad').length, 1);
  assert.deepEqual(syncedIds, ['c']);
  // The halted entry is reported truthfully as skipped, not as a failure.
  const halt = reported.find(r => r.entry.id === 'b');
  assert.ok(halt?.halted);
  assert.match(halt.error.message, /key:bad/);
  const failure = reported.find(r => r.entry.id === 'a');
  assert.ok(failure && !failure.halted);
});

test('syncPendingEntries drops the whole uncommitted batch at a pre-checkpoint abort', async () => {
  const calls = [];
  const syncedIds = [];
  const entries = ['a', 'b', 'c'].map(k => syncEntry(`e-${k}`, `key:${k}`));

  const result = await syncPendingEntries(missThenStoreClient(calls), entries, {
    checkpointBatchSize: 3,
    markSynced: async (ids) => { syncedIds.push(...ids); },
    beforeEntry: async (entry, phase) => {
      if (phase === 'pre-checkpoint' && entry.id === 'e-b') {
        const error = new Error('lost mid-batch');
        error.syncAbort = true;
        throw error;
      }
    },
  });

  assert.equal(calls.filter(c => c.name === 'store').length, 3); // all applied
  assert.equal(result.synced, 0);
  assert.equal(result.errors, 0);
  assert.match(result.aborted, /lost mid-batch/);
  // Nothing is committed without full gate approval for the batch.
  assert.deepEqual(syncedIds, []);
});

test('syncPendingEntries aborts the whole batch when any pre-checkpoint gate fails', async () => {
  const calls = [];
  const syncedIds = [];
  const entries = [
    syncEntry('a', 'key:1'),
    syncEntry('b', 'key:1'),
    syncEntry('c', 'key:2'),
    syncEntry('d', 'key:2'),
    syncEntry('e', 'key:1'),
    syncEntry('f', 'key:1'),
  ];

  const result = await syncPendingEntries(missThenStoreClient(calls), entries, {
    checkpointBatchSize: 5,
    markSynced: async (ids) => { syncedIds.push(...ids); },
    beforeEntry: async (entry, phase) => {
      if (phase === 'pre-checkpoint' && entry.id === 'b') throw new Error('gate unavailable');
    },
  });

  // Whole-batch abort: zero commits, never selective. Committing around a
  // failed gate would let the next run re-apply the older uncommitted
  // mutation after the newer committed one, overwriting fresh content.
  assert.equal(calls.filter(c => c.name === 'store').length, 5); // a..e applied; f never reached
  assert.equal(result.synced, 0);
  assert.equal(result.errors, 0);
  assert.equal(result.halted, 0);
  assert.match(result.aborted, /checkpoint gate failed: gate unavailable/);
  assert.deepEqual(syncedIds, []);
});

test('syncPendingEntries ignores observer failures without double-counting entries', async () => {
  const syncedIds = [];
  const entries = Array.from({ length: 6 }, (_, i) => syncEntry(`e${i}`, `key:${i}`));

  const result = await syncPendingEntries(missThenStoreClient([]), entries, {
    checkpointBatchSize: 3,
    markSynced: async (ids) => { syncedIds.push(...ids); },
    onProgress: async () => { throw new Error('state write failed'); },
  });

  // A throwing observer never re-attributes an already committed entry.
  assert.equal(result.synced, 6);
  assert.equal(result.errors, 0);
  assert.equal(result.aborted, null);
  assert.deepEqual(syncedIds, entries.map(e => e.id));
});

test('main in --background mode writes progress state at checkpoint cadence, not per entry', async () => {
  const stateWrites = [];
  const committed = [];
  const deps = makeBackgroundDeps({
    entries: Array.from({ length: 30 }, (_, i) => syncEntry(`e${i}`, `key:${i}`)),
    stateWrites,
    committed,
  });

  const exitCode = await main(['node', 'cli/sync.mjs', '--background'], deps);

  assert.equal(exitCode, 0);
  // Deterministic write accounting: 2 running writes + 2 checkpoint progress
  // writes (25 committed, then the 5-entry remainder) + 1 finished write.
  assert.equal(stateWrites.length, 5);
  assert.deepEqual(committed, [25, 5]);
  const finished = stateWrites.at(-1).state;
  assert.equal(finished.status, 'finished');
  assert.equal(finished.summary.synced, 30);
  assert.equal(finished.summary.pending, 0);
});

test('main in --background mode reports truthful pending when an entry fails', async () => {
  const stateWrites = [];
  const deps = makeBackgroundDeps({
    entries: [syncEntry('1', 'key:ok'), syncEntry('2', 'key:bad')],
    stateWrites,
    clientCallTool: (request) => {
      if (request.name === 'search' && request.arguments.query === 'key:bad') {
        return { isError: true, content: [{ type: 'text', text: 'boom' }] };
      }
      if (request.name === 'search') return toolResult({ count: 0, results: [] });
      if (request.name === 'store') return toolResult({ id: 'mem' });
      throw new Error(`unexpected tool ${request.name}`);
    },
  });

  const exitCode = await main(['node', 'cli/sync.mjs', '--background'], deps);

  assert.equal(exitCode, 1);
  const finished = stateWrites.find(w => w.state.status === 'finished');
  assert.ok(finished);
  assert.equal(finished.state.summary.synced, 1);
  assert.equal(finished.state.summary.errors, 1);
  // The failed entry stays pending in the manifest; the summary says so.
  assert.equal(finished.state.summary.pending, 1);
});

test('main rejects an invalid --checkpoint-batch-size before touching locks', async () => {
  for (const bad of ['0', 'abc', '201']) {
    const errCalls = [];
    let lockTouched = false;
    const exitCode = await main(['node', 'cli/sync.mjs', '--checkpoint-batch-size', bad], {
      SyncLock: class { constructor() { lockTouched = true; } },
      log: () => {},
      errLog: (msg) => errCalls.push(msg),
      ENRICHMENT_DIR: '/fake/enrichment',
      PROJECT_ROOT: '/fake/root',
    });

    assert.equal(exitCode, 1);
    assert.equal(lockTouched, false);
    assert.ok(errCalls.some(m => /checkpoint-batch-size/.test(m)));
  }
});

test('main in --detach mode forwards --checkpoint-batch-size to the worker', async () => {
  const spawnCalls = [];
  const exitCode = await main(['node', 'cli/sync.mjs', '--detach', '--checkpoint-batch-size', '5'], {
    spawnBackground: (cmd, args) => { spawnCalls.push(args); return 7; },
    openLogFile: async () => ({ fd: 1, close: async () => {} }),
    log: () => {},
    ENRICHMENT_DIR: '/fake/enrichment',
    PROJECT_ROOT: '/fake/root',
  });

  assert.equal(exitCode, 0);
  assert.ok(spawnCalls[0].includes('--background'));
  const index = spawnCalls[0].indexOf('--checkpoint-batch-size');
  assert.ok(index !== -1);
  assert.equal(spawnCalls[0][index + 1], '5');
});

test('main foreground exits nonzero and logs the abort when the checkpoint fails', async () => {
  const logCalls = [];
  const errCalls = [];
  const deps = {
    SyncLock: class {
      async acquire() { return true; }
      async isOwner() { return true; }
      async release() {}
    },
    readSyncManifest: async () => ({ entries: [syncEntry('1', 'key:1')] }),
    markEntriesSynced: async () => { throw new Error('disk full'); },
    loadAgentMemoryConfig: async () => ({ command: 'node', args: [] }),
    Client: class {
      async connect() {}
      async callTool(request) {
        if (request.name === 'search') return toolResult({ count: 0, results: [] });
        if (request.name === 'store') return toolResult({ id: 'mem' });
        throw new Error(`unexpected tool ${request.name}`);
      }
      async close() {}
    },
    StdioClientTransport: class {},
    log: (msg) => logCalls.push(msg),
    errLog: (msg) => errCalls.push(msg),
    ENRICHMENT_DIR: '/fake/enrichment',
    PROJECT_ROOT: '/fake/root',
  };

  const exitCode = await main(['node', 'cli/sync.mjs'], deps);

  // A fatal checkpoint abort must never exit 0 in the foreground.
  assert.equal(exitCode, 1);
  assert.ok(errCalls.some(m => /Aborted: checkpoint failed: disk full/.test(m)));
  assert.ok(logCalls.some(m => m.includes('Aborted')));
  assert.ok(!logCalls.some(m => m.includes('Done')));
});

test('main in --background mode verifies ownership at the checkpoint gate, not only timer flags', async () => {
  // Ownership flips between the mutation and its checkpoint — within one
  // entry, where cached heartbeat flags alone can never observe it. The
  // read-only isOwner() probe must abort with zero commits.
  let owner = true;
  const stateWrites = [];
  const committed = [];
  const deps = makeBackgroundDeps({
    entries: [syncEntry('1', 'key:1')],
    stateWrites,
    committed,
    clientCallTool: (request) => {
      if (request.name === 'search') return toolResult({ count: 0, results: [] });
      if (request.name === 'store') {
        owner = false; // takeover right after the mutation
        return toolResult({ id: 'mem' });
      }
      throw new Error(`unexpected tool ${request.name}`);
    },
  });
  deps.SyncLock = class {
    async acquire() { return true; }
    async heartbeat() { return true; }
    async isOwner() { return owner; }
    async release() {}
  };

  const exitCode = await main(['node', 'cli/sync.mjs', '--background'], deps);

  assert.equal(exitCode, 1);
  assert.deepEqual(committed, []); // the applied entry is never checkpointed
  const failed = stateWrites.find(w => w.state.status === 'failed');
  assert.ok(failed);
  assert.equal(failed.state.summary.synced, 0);
  assert.equal(failed.state.summary.pending, 1);
  assert.match(failed.state.lastError ?? '', /ownership lost/);
});

test('main treats an ownership probe read failure as a fatal abort, not a per-entry error', async () => {
  const stateWrites = [];
  const committed = [];
  const deps = makeBackgroundDeps({
    entries: [syncEntry('1', 'key:1')],
    stateWrites,
    committed,
  });
  deps.SyncLock = class {
    async acquire() { return true; }
    async heartbeat() { return true; }
    async isOwner() { throw new Error('EIO: lock unreadable'); }
    async release() {}
  };

  const exitCode = await main(['node', 'cli/sync.mjs', '--background'], deps);

  assert.equal(exitCode, 1);
  assert.deepEqual(committed, []);
  const failed = stateWrites.find(w => w.state.status === 'failed');
  assert.ok(failed);
  // Authority unknown fails closed as a fatal abort, never a soft error.
  assert.equal(failed.state.summary.errors, 0);
  assert.match(failed.state.lastError ?? '', /ownership check failed/);
});
