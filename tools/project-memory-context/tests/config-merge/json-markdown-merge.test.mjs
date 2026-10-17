import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { mergeJsonConfig } from '../../src/config-merge/json.mjs';
import { mergeMarkdownBlock } from '../../src/config-merge/markdown.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pmc-merge-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('mergeJsonConfig returns malformed: true without touching disk when file has invalid JSON', async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, 'config.json');
    const invalidContent = '{ malformed json: true, ';
    await writeFile(filePath, invalidContent, 'utf8');

    const result = await mergeJsonConfig(filePath, { mcpServers: { 'pmc-query': {} } });

    assert.deepEqual(result, { malformed: true });
    const content = await readFile(filePath, 'utf8');
    assert.equal(content, invalidContent);
  });
});

test('mergeJsonConfig preserves unowned keys, updates owned keys, and is idempotent', async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, 'config.json');
    const existing = {
      unowned: 'preserve-me',
      mcpServers: {
        other: { command: 'other' },
        'pmc-query': { command: 'old' },
      },
    };
    await writeFile(filePath, JSON.stringify(existing, null, 2) + '\n', 'utf8');

    const updates = {
      mcpServers: {
        'pmc-query': { command: 'node', args: ['query.mjs'] },
        'pmc-agent-memory': { command: 'node', args: ['memory.mjs'] },
      },
    };

    // First merge
    const res1 = await mergeJsonConfig(filePath, updates);
    assert.equal(res1.status, 'installed');

    const afterRes1 = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(afterRes1.unowned, 'preserve-me');
    assert.deepEqual(afterRes1.mcpServers.other, { command: 'other' });
    assert.deepEqual(afterRes1.mcpServers['pmc-query'], { command: 'node', args: ['query.mjs'] });
    assert.deepEqual(afterRes1.mcpServers['pmc-agent-memory'], { command: 'node', args: ['memory.mjs'] });

    // Second merge (idempotent)
    const res2 = await mergeJsonConfig(filePath, updates);
    assert.equal(res2.status, 'unchanged');
  });
});

test('mergeMarkdownBlock splices block into existing content preserving outer text and is idempotent', async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, 'AGENTS.md');
    const existing = '# Header\n\nExisting body text.\n';
    await writeFile(filePath, existing, 'utf8');

    const blockContent = '<!-- pmc:autostart -->\n## PMC Autostart\n<!-- /pmc:autostart -->';

    // First merge (appends block)
    const res1 = await mergeMarkdownBlock(filePath, blockContent, 'autostart');
    assert.equal(res1.status, 'installed');

    const after1 = await readFile(filePath, 'utf8');
    assert.ok(after1.startsWith('# Header\n\nExisting body text.\n'));
    assert.ok(after1.includes('<!-- pmc:autostart -->'));

    // Second merge (idempotent)
    const res2 = await mergeMarkdownBlock(filePath, blockContent, 'autostart');
    assert.equal(res2.status, 'unchanged');
  });
});
