import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findMemoriesByKeyTag,
  applySyncEntry,
  syncPendingEntries,
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
