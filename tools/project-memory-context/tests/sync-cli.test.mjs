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
      async release() {
        lockCalls.push({ action: 'release' });
      }
    },
    writeSyncState: async (path, state) => {
      stateWrites.push({ path, state: JSON.parse(JSON.stringify(state)) });
    },
    readSyncManifest: async () => ({ entries: [{ id: '1', action: 'upsert', key_tag: 'key:1', content: 'c' }] }),
    markEntriesSynced: async () => {},
    loadAgentMemoryConfig: async () => ({ command: 'node', args: [] }),
    Client: class {
      async connect() {}
      async callTool() {
        return toolResult({ id: 'mem-1' });
      }
      async close() {}
    },
    StdioClientTransport: class {},
    log: (msg) => logCalls.push(msg),
    ENRICHMENT_DIR: '/fake/enrichment',
    PROJECT_ROOT: '/fake/root',
  };

  const exitCode = await main(['node', 'cli/sync.mjs', '--background'], deps);

  assert.equal(exitCode, 0);
  assert.deepEqual(lockCalls, [
    { action: 'acquire', pid: process.pid },
    { action: 'release' }
  ]);
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
