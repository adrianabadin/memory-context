import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { getSymbolSource, loadSourceCache, computeCodeHash, clearInProcessCache } from '../src/retrieval/source-cache.mjs';

// ── Helpers ────────────────────────────────────────────────────────

async function createFixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-source-cache-'));
  const enrichmentDir = join(projectRoot, '.planning', 'project-memory-context', 'enrichment');
  await mkdir(enrichmentDir, { recursive: true });
  return { projectRoot, enrichmentDir };
}

function sha1(code) {
  return createHash('sha1').update(code).digest('hex');
}

// ── Tests ──────────────────────────────────────────────────────────

test('computeCodeHash uses sha1 matching regex-extractor', () => {
  const code = 'function foo() { return 1; }';
  const expected = sha1(code);
  assert.equal(computeCodeHash(code), expected);
});

test('getSymbolSource returns fresh result when hash matches', async () => {
  clearInProcessCache();
  const { projectRoot, enrichmentDir } = await createFixture();

  const srcFile = 'src/example.mjs';
  const lines = ['// line 1', 'function foo() {', '  return 42;', '}', '// line 5'];
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await writeFile(join(projectRoot, srcFile), lines.join('\n'), 'utf-8');

  const range = { startLine: 2, endLine: 4 };
  const slice = lines.slice(1, 4).join('\n');
  const codeHash = sha1(slice);

  const result = await getSymbolSource({ projectRoot, filePath: srcFile, range, codeHash, enrichmentDir });

  assert.equal(result.code, slice);
  assert.equal(result.fresh, true);
  assert.equal(result.source, 'disk');
  assert.equal(result.verified, true);
  assert.equal(result.currentHash, codeHash);
  assert.equal(result.error, undefined);
});

test('getSymbolSource detects stale (hash mismatch)', async () => {
  clearInProcessCache();
  const { projectRoot, enrichmentDir } = await createFixture();

  const srcFile = 'src/stale.mjs';
  const lines = ['function bar() {', '  return 99;', '}'];
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await writeFile(join(projectRoot, srcFile), lines.join('\n'), 'utf-8');

  const range = { startLine: 1, endLine: 3 };
  const staleHash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // deliberately wrong

  const result = await getSymbolSource({ projectRoot, filePath: srcFile, range, codeHash: staleHash, enrichmentDir });

  assert.equal(result.fresh, false);
  assert.notEqual(result.currentHash, staleHash);
  assert.equal(result.expectedHash, staleHash);
  assert.equal(result.source, 'disk');
  assert.ok(result.code != null);
});

test('getSymbolSource handles missing file gracefully', async () => {
  clearInProcessCache();
  const { projectRoot, enrichmentDir } = await createFixture();

  const result = await getSymbolSource({
    projectRoot,
    filePath: 'nonexistent/file.mjs',
    range: { startLine: 1, endLine: 3 },
    codeHash: null,
    enrichmentDir,
  });

  assert.equal(result.code, null);
  assert.ok(result.error);
  assert.equal(result.source, 'disk');
});

test('getSymbolSource handles out-of-range gracefully', async () => {
  clearInProcessCache();
  const { projectRoot, enrichmentDir } = await createFixture();

  const srcFile = 'src/short.mjs';
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await writeFile(join(projectRoot, srcFile), 'const x = 1;\n', 'utf-8');

  const result = await getSymbolSource({
    projectRoot,
    filePath: srcFile,
    range: { startLine: 5, endLine: 10 },
    codeHash: null,
    enrichmentDir,
  });

  assert.equal(result.code, null);
  assert.ok(result.error);
});

test('getSymbolSource persists to source-cache.json', async () => {
  clearInProcessCache();
  const { projectRoot, enrichmentDir } = await createFixture();

  const srcFile = 'src/persist.mjs';
  const content = 'export const answer = 42;\n';
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await writeFile(join(projectRoot, srcFile), content, 'utf-8');

  const range = { startLine: 1, endLine: 1 };
  await getSymbolSource({ projectRoot, filePath: srcFile, range, codeHash: null, enrichmentDir });

  const entries = await loadSourceCache(enrichmentDir);
  const hashes = Object.keys(entries);
  assert.equal(hashes.length, 1);
  assert.equal(entries[hashes[0]].filePath, srcFile);
  assert.ok(entries[hashes[0]].code != null);
});

test('trust mode returns cache hit without disk read', async () => {
  clearInProcessCache();
  const { projectRoot, enrichmentDir } = await createFixture();

  // Pre-populate the cache with a fake entry
  const fakeHash = 'feedfeedfeedfeedfeedfeedfeedfeedfeedfe';
  const fakeCode = 'function cached() {}';
  const cacheFile = join(enrichmentDir, 'source-cache.json');
  await writeFile(cacheFile, JSON.stringify({
    entries: { [fakeHash]: { code: fakeCode, filePath: 'src/fake.mjs', range: { startLine: 1, endLine: 1 }, cachedAt: new Date().toISOString() } },
    updatedAt: new Date().toISOString(),
  }), 'utf-8');

  const result = await getSymbolSource({
    projectRoot,
    filePath: 'src/fake.mjs',
    range: { startLine: 1, endLine: 1 },
    codeHash: fakeHash,
    enrichmentDir,
    trust: true,
  });

  assert.equal(result.code, fakeCode);
  assert.equal(result.source, 'cache');
  assert.equal(result.verified, false);
  assert.equal(result.fresh, null); // not verified
});

test('getSymbolSource with no codeHash returns fresh: null', async () => {
  clearInProcessCache();
  const { projectRoot, enrichmentDir } = await createFixture();

  const srcFile = 'src/nohash.mjs';
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await writeFile(join(projectRoot, srcFile), 'const z = 0;\n', 'utf-8');

  const result = await getSymbolSource({
    projectRoot,
    filePath: srcFile,
    range: { startLine: 1, endLine: 1 },
    codeHash: null,
    enrichmentDir,
  });

  assert.equal(result.fresh, null);
  assert.ok(result.code != null);
  assert.equal(result.source, 'disk');
});

test('missing filePath returns error', async () => {
  clearInProcessCache();
  const { projectRoot, enrichmentDir } = await createFixture();

  const result = await getSymbolSource({ projectRoot, filePath: null, range: { startLine: 1, endLine: 1 }, codeHash: null, enrichmentDir });
  assert.equal(result.code, null);
  assert.ok(result.error);
});
