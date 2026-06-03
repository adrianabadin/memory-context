import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectStructureContext } from '../src/extractors/structure-extractor.mjs';

test('detectStructureContext captures root directories and key subtrees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-structure-'));
  await mkdir(join(root, 'src', 'services'), { recursive: true });
  await mkdir(join(root, 'src', 'components'), { recursive: true });
  await mkdir(join(root, 'tests'), { recursive: true });
  await writeFile(join(root, 'src', 'main.ts'), 'export {}\n', 'utf8');

  const result = await detectStructureContext(root);

  assert.deepEqual(result.rootDirectories.sort(), ['src', 'tests']);
  assert.equal(result.entryPoints.includes('src/main.ts'), true);
  assert.equal(result.keySubtrees.includes('src/services'), true);
});

test('detectStructureContext ignores generated build directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-structure-ignore-'));
  await mkdir(join(root, 'src', 'app'), { recursive: true });
  await mkdir(join(root, '.next', 'server'), { recursive: true });
  await mkdir(join(root, 'graphify-out', 'cache'), { recursive: true });
  await writeFile(join(root, 'src', 'index.ts'), 'export {}\n', 'utf8');

  const result = await detectStructureContext(root);

  assert.equal(result.rootDirectories.includes('.next'), false);
  assert.equal(result.rootDirectories.includes('graphify-out'), false);
  assert.equal(result.keySubtrees.some((item) => item.startsWith('.next/')), false);
  assert.equal(result.keySubtrees.some((item) => item.startsWith('graphify-out/')), false);
  assert.equal(result.rootDirectories.includes('src'), true);
});
