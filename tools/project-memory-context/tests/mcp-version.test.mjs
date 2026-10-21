import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(TEST_DIR, '..');
const pkg = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8'));

test('getPackageVersion returns installed package.json version', async () => {
  const { getPackageVersion } = await import('../src/package-version.mjs');
  const version = getPackageVersion();
  assert.equal(version, pkg.version);
  assert.notEqual(version, '0.1.5');
  assert.match(version, /^\d+\.\d+\.\d+/);
});

test('MCP pmc-query-server reports installed package version on initialize', async () => {
  const tempDir = mkdtempSync(resolve(tmpdir(), 'pmc-mcp-version-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(PACKAGE_ROOT, 'mcp', 'pmc-query-server.mjs')],
    env: {
      ...process.env,
      PMC_PROJECT_ROOT: tempDir,
    },
  });

  const client = new Client({ name: 'mcp-version-test-client', version: '1.0.0' });

  try {
    await client.connect(transport);
    const serverVersion = client.getServerVersion();

    assert.ok(serverVersion, 'Expected serverVersion object from initialize response');
    assert.equal(serverVersion.name, 'pmc-query');
    assert.equal(serverVersion.version, pkg.version);
    assert.notEqual(serverVersion.version, '0.1.5');

    // Verify 11-tool inventory is preserved
    const toolList = await client.listTools();
    assert.equal(toolList.tools.length, 11);
    const toolNames = toolList.tools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, [
      'pmc_card',
      'pmc_community_card',
      'pmc_entrypoints_for',
      'pmc_feature_card',
      'pmc_file_rollup',
      'pmc_get_dependencies',
      'pmc_get_dependents',
      'pmc_impact',
      'pmc_query_project',
      'pmc_relations',
      'pmc_search_symbols',
    ]);

    // Verify no config or database was written to isolated tempDir
    const createdFiles = readdirSync(tempDir);
    assert.deepEqual(createdFiles, []);
  } finally {
    await client.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
