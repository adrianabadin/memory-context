import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ensureProjectMemoryContextDirs,
  writeJsonArtifact,
  readJsonArtifact,
} from '../src/artifacts.mjs';
import { buildIntakeContext } from '../src/intake-context.mjs';

test('ensureProjectMemoryContextDirs creates expected directory tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-artifacts-'));
  const dirs = await ensureProjectMemoryContextDirs(root);

  assert.equal(dirs.base.endsWith(join('.planning', 'project-memory-context')), true);
  assert.equal(dirs.intake.endsWith('intake'), true);
  assert.equal(dirs.graph.endsWith('graph'), true);
  assert.equal(dirs.enrichment.endsWith('enrichment'), true);
  assert.equal(dirs.runs.endsWith('runs'), true);

  assert.equal(dirs.projectContext, join(root, '.planning', 'project-memory-context', 'project-context'));
  assert.equal(dirs.projectContextDetected, join(dirs.projectContext, 'detected'));
  assert.equal(dirs.projectContextDeclared, join(dirs.projectContext, 'declared'));
  assert.equal(dirs.projectContextMaterialized, join(dirs.projectContext, 'materialized'));
  assert.equal(dirs.projectContextMarkdown, join(dirs.projectContext, 'markdown'));
  assert.equal(dirs.projectContextState, join(dirs.projectContext, 'state'));
});

test('writeJsonArtifact persists readable JSON payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-json-'));
  const dirs = await ensureProjectMemoryContextDirs(root);
  const file = join(dirs.intake, 'latest-context.json');

  await writeJsonArtifact(file, { project: 'demo', goals: ['map'] });

  const parsed = await readJsonArtifact(file);
  assert.deepEqual(parsed, { project: 'demo', goals: ['map'] });
});

test('buildIntakeContext normalizes project description and goals', () => {
  const intake = buildIntakeContext({
    projectDescription: ' Existing billing platform ',
    mappingGoals: [' architecture ', ' memory context '],
    focusAreas: ['api', 'domain'],
  });

  assert.equal(intake.projectDescription, 'Existing billing platform');
  assert.deepEqual(intake.mappingGoals, ['architecture', 'memory context']);
  assert.deepEqual(intake.focusAreas, ['api', 'domain']);
  assert.equal(typeof intake.createdAt, 'string');
});
