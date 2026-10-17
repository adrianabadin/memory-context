import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { computeFileHashes } from '../src/file-hash-store.mjs';
import { detectStructureContext } from '../src/extractors/structure-extractor.mjs';
import { shouldWatch } from '../src/file-watcher.mjs';
import { shouldIgnoreDir, IGNORED_DIRS, ALLOWED_HIDDEN_DIRS_NAMES } from '../src/walk-ignores.mjs';
import { readJsonArtifact, writeJsonArtifact } from '../src/artifacts.mjs';
import { findSourceFiles } from '../cli/sanitize.mjs';
import { findFiles } from '../cli/bootstrap.mjs';
import { extractTopLevelSymbols } from '../src/symbol-extractor.mjs';

const FIXTURE_DIR = resolve('tests/fixtures/layered-app');

test('layered-app fixture: computeFileHashes excludes .planning/** and .worktrees/**', async () => {
  const hashes = await computeFileHashes(FIXTURE_DIR);
  const keys = Object.keys(hashes);

  const planningKeys = keys.filter((k) => k.startsWith('.planning') || k.includes('/.planning/'));
  const worktreeKeys = keys.filter((k) => k.startsWith('.worktrees') || k.includes('/.worktrees/'));

  assert.deepEqual(planningKeys, [], 'must not contain any .planning keys');
  assert.deepEqual(worktreeKeys, [], 'must not contain any .worktrees keys');
  // Must still contain regular source files
  assert.ok(keys.includes('src/services/user.service.ts'), 'must contain valid source file');
});

test('layered-app fixture: detectStructureContext excludes .planning and .worktrees', async () => {
  const structure = await detectStructureContext(FIXTURE_DIR);

  assert.equal(structure.rootDirectories.includes('.planning'), false);
  assert.equal(structure.rootDirectories.includes('.worktrees'), false);
  assert.equal(structure.keySubtrees.some((k) => k.startsWith('.planning')), false);
  assert.equal(structure.keySubtrees.some((k) => k.startsWith('.worktrees')), false);
  assert.ok(structure.rootDirectories.includes('src'));
});

test('file-watcher: shouldWatch rejects .planning, .worktrees, graphify-out, and .graphify_*.json', () => {
  // Accepted
  assert.equal(shouldWatch('src/controllers/user.controller.ts'), true);
  assert.equal(shouldWatch('src/services/user.service.ts'), true);

  // Rejected non-source / generated scopes
  assert.equal(shouldWatch('.planning/project-memory-context/enrichment/x.memory.json'), false);
  assert.equal(shouldWatch('.planning/some-code.ts'), false);
  assert.equal(shouldWatch('.worktrees/copy/src/services/user.service.ts'), false);
  assert.equal(shouldWatch('graphify-out/graph.json'), false);
  assert.equal(shouldWatch('graphify-out/generated.js'), false);
  assert.equal(shouldWatch('.graphify_analysis.json'), false);
  assert.equal(shouldWatch('.graphify_test.js'), false);
  assert.equal(shouldWatch('.opencode/plugins/pmc.mjs'), false);
  assert.equal(shouldWatch('.opencode/plugin.ts'), false);
});

test('owned-temp: walkers exclude non-source scopes and graphify generated files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-non-source-scopes-'));

  // Normal source file
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'index.ts'), 'export const a = 1;\n', 'utf8');

  // Ignored scopes
  await mkdir(join(root, '.planning', 'project-memory-context', 'enrichment'), { recursive: true });
  await writeFile(join(root, '.planning', 'project-memory-context', 'enrichment', 'sym.ts'), 'export const b = 2;\n', 'utf8');

  await mkdir(join(root, '.worktrees', 'worktree-1', 'src'), { recursive: true });
  await writeFile(join(root, '.worktrees', 'worktree-1', 'src', 'index.ts'), 'export const c = 3;\n', 'utf8');

  await mkdir(join(root, 'graphify-out'), { recursive: true });
  await writeFile(join(root, 'graphify-out', 'out.ts'), 'export const d = 4;\n', 'utf8');

  await writeFile(join(root, '.graphify_analysis.json'), '{"nodes":[]}\n', 'utf8');
  await writeFile(join(root, '.graphify_custom.ts'), 'export const e = 5;\n', 'utf8');

  await mkdir(join(root, '.opencode', 'plugins'), { recursive: true });
  await writeFile(join(root, '.opencode', 'plugins', 'pmc.ts'), 'export const f = 6;\n', 'utf8');

  // Test computeFileHashes excludes .opencode, .planning, .worktrees, graphify-out
  const hashes = await computeFileHashes(root);
  const hashKeys = Object.keys(hashes);
  assert.deepEqual(hashKeys, ['src/index.ts']);

  // Test detectStructureContext ignores .planning, .worktrees, and graphify-out
  const structure = await detectStructureContext(root);
  assert.equal(structure.rootDirectories.includes('.planning'), false);
  assert.equal(structure.rootDirectories.includes('.worktrees'), false);
  assert.equal(structure.rootDirectories.includes('graphify-out'), false);
  assert.ok(structure.rootDirectories.includes('src'));

  // Test findSourceFiles from sanitize excludes .opencode, .planning, .worktrees
  if (typeof findSourceFiles === 'function') {
    const sanitizeFiles = await findSourceFiles(root);
    assert.deepEqual(sanitizeFiles, ['src/index.ts']);
  }

  // Test findFiles from bootstrap excludes .opencode, .planning, .worktrees
  if (typeof findFiles === 'function') {
    const bootstrapFiles = findFiles(root, ['.ts'], root);
    assert.deepEqual(bootstrapFiles, ['src/index.ts']);
  }

  await rm(root, { recursive: true, force: true });
});

test('declared intake reads: explicit paths under .planning/ remain readable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-declared-intake-'));
  const intakeDir = join(root, '.planning', 'project-memory-context', 'intake');
  const declaredDir = join(root, '.planning', 'project-memory-context', 'project-context', 'declared');

  const intakePayload = { projectDescription: 'Test project', mappingGoals: ['eval'] };
  const rulesPayload = { rules: ['Do not mutate outside surface'] };

  await writeJsonArtifact(join(intakeDir, 'latest-context.json'), intakePayload);
  await writeJsonArtifact(join(declaredDir, 'technical-rules.json'), rulesPayload);

  // Read via explicit paths
  const loadedIntake = await readJsonArtifact(join(intakeDir, 'latest-context.json'));
  const loadedRules = await readJsonArtifact(join(declaredDir, 'technical-rules.json'));

  assert.deepEqual(loadedIntake, intakePayload);
  assert.deepEqual(loadedRules, rulesPayload);

  await rm(root, { recursive: true, force: true });
});

test('layered-app fixture: source walkers and symbol extraction yield 0 polluted keys', async () => {
  const sanitizeFiles = await findSourceFiles(FIXTURE_DIR);
  assert.equal(sanitizeFiles.some((f) => f.startsWith('.planning') || f.startsWith('.worktrees')), false);

  const bootstrapFiles = findFiles(FIXTURE_DIR, ['.ts', '.mjs', '.js'], FIXTURE_DIR);
  assert.equal(bootstrapFiles.some((f) => f.startsWith('.planning') || f.startsWith('.worktrees')), false);

  const symbols = [];
  for (const file of sanitizeFiles) {
    const content = await readFile(resolve(FIXTURE_DIR, file), 'utf8');
    const syms = await extractTopLevelSymbols({ filePath: file, content });
    symbols.push(...syms);
  }

  assert.ok(symbols.length > 0, 'must extract valid symbols');
  const polluted = symbols.filter((s) =>
    s.symbolKey.includes('.planning') ||
    s.symbolKey.includes('.worktrees') ||
    s.filePath.includes('.planning') ||
    s.filePath.includes('.worktrees')
  );
  assert.deepEqual(polluted, [], 'fixture symbol extraction must have 0 polluted keys');
});
