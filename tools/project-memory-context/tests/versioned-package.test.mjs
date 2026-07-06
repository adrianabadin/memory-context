import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(TEST_DIR, '..');

test('package metadata uses the @aabadin scope and pmc binary', () => {
  const pkg = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@aabadin/project-memory-context');
  assert.equal(pkg.main, './src/index.mjs');
  assert.deepEqual(pkg.bin, {
    pmc: 'bin/pmc.mjs',
    'pmc-query-server': 'mcp/pmc-query-server.mjs',
    'pmc-view-context': 'bin/pmc-view-context.mjs',
  });
  assert.deepEqual(pkg.exports, {
    '.': './src/index.mjs',
    './platform': './src/platform.mjs',
    './retrieval': './src/retrieval/query-engine.mjs',
    './plugin': './plugin/index.mjs',
  });
});

test('package entry point exports dispatch and platform helpers', async () => {
  const entry = await import(pathToFileURL(resolve(PACKAGE_ROOT, 'src', 'index.mjs')).href);
  assert.equal(typeof entry.resolveCommand, 'function');
  assert.equal(typeof entry.runCommand, 'function');
  assert.equal(typeof entry.resolveConfigDirs, 'function');
  assert.equal(typeof entry.resolveGraphify, 'function');
  assert.equal(typeof entry.spawnBackground, 'function');
});
