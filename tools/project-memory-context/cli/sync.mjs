#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readSyncManifest, markEntriesSynced, getPendingEntries } from '../src/sync-manifest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.cwd();
const ENRICHMENT_DIR = resolve(PROJECT_ROOT, '.planning/project-memory-context/enrichment');
const LOOKUP_LIMIT = 100;

async function loadAgentMemoryConfig() {
  const mcpPath = resolve(PROJECT_ROOT, '.mcp.json');
  let raw;
  try {
    raw = JSON.parse(await readFile(mcpPath, 'utf8'));
  } catch {
    throw new Error(`Could not read .mcp.json at ${mcpPath}`);
  }
  const server = raw?.mcpServers?.['agent-memory'];
  if (!server) throw new Error('No "agent-memory" server found in .mcp.json');
  return server;
}

function uniqueTags(tags = [], keyTag) {
  return [...new Set([...tags, keyTag].filter(Boolean))];
}

export function parseToolResult(result) {
  if (result?.isError) {
    const message = result.content?.[0]?.text ?? 'unknown error';
    throw new Error(message);
  }

  const text = result?.content?.[0]?.text;
  if (!text) {
    return null;
  }

  return JSON.parse(text);
}

export async function findMemoriesByKeyTag(client, keyTag) {
  const result = await client.callTool({
    name: 'search',
    arguments: {
      query: keyTag,
      tags: [keyTag],
      limit: LOOKUP_LIMIT,
    },
  });

  const data = parseToolResult(result) ?? { results: [] };
  return data.results.map((match) => match.memory);
}

export async function applySyncEntry(client, entry) {
  if (entry.action === 'upsert') {
    const matches = (await findMemoriesByKeyTag(client, entry.key_tag))
      .slice()
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const payload = {
      content: entry.content,
      category: entry.category || 'architecture',
      tags: uniqueTags(entry.tags, entry.key_tag),
    };

    if (matches.length > 0) {
      const [primary, ...duplicates] = matches;
      await client.callTool({
        name: 'update',
        arguments: {
          id: primary.id,
          ...payload,
        },
      }).then(parseToolResult);

      for (const memory of duplicates) {
        await client.callTool({
          name: 'delete',
          arguments: { id: memory.id },
        }).then(parseToolResult);
      }

      return;
    }

    await client.callTool({ name: 'store', arguments: payload }).then(parseToolResult);
    return;
  }

  if (entry.action === 'delete') {
    const matches = await findMemoriesByKeyTag(client, entry.key_tag);
    for (const memory of matches) {
      await client.callTool({
        name: 'delete',
        arguments: { id: memory.id },
      }).then(parseToolResult);
    }
    return;
  }

  throw new Error(`Unsupported sync action: ${entry.action}`);
}

export async function syncPendingEntries(client, pending, { markSynced = async () => {}, onProgress = () => {}, onError = () => {} } = {}) {
  let synced = 0;
  let errors = 0;

  for (const entry of pending) {
    try {
      await applySyncEntry(client, entry);
      await markSynced([entry.id]);
      synced += 1;
      onProgress({ synced, total: pending.length, entry });
    } catch (error) {
      errors += 1;
      onError({ error, entry, synced, total: pending.length });
    }
  }

  return { synced, errors };
}

async function main() {
  const manifest = await readSyncManifest(ENRICHMENT_DIR);
  const pending = getPendingEntries(manifest);

  if (pending.length === 0) {
    console.log('[sync] Nothing to sync.');
    return 0;
  }

  const mcpConfig = await loadAgentMemoryConfig();
  console.log(`[sync] ${pending.length} pending entries — starting agent-memory server...`);

  const transport = new StdioClientTransport({
    command: mcpConfig.command,
    args: mcpConfig.args ?? [],
    env: { ...process.env, ...(mcpConfig.env ?? {}) },
  });

  const client = new Client({ name: 'pmc-sync', version: '1.0.0' });

  try {
    await client.connect(transport);
  } catch (err) {
    throw new Error(`Failed to connect to agent-memory: ${err.message}`);
  }

  const { synced, errors } = await syncPendingEntries(client, pending, {
    markSynced: (ids) => markEntriesSynced(ENRICHMENT_DIR, ids),
    onProgress: ({ synced: applied, total }) => {
      process.stdout.write(`\r[sync] ${applied}/${total} synced...`);
    },
    onError: ({ error, entry }) => {
      console.error(`\n[sync] Entry ${entry.id} failed: ${error.message}`);
    },
  });

  await client.close();
  console.log(`\n[sync] Done. synced=${synced} errors=${errors}`);
  return errors > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => {
    if (code !== 0) process.exit(code);
  }).catch(err => {
    console.error('[sync] FATAL:', err.message);
    process.exit(1);
  });
}
