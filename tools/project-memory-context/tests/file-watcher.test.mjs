import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldWatch, debounce } from '../src/file-watcher.mjs';

test('shouldWatch accepts source files and rejects ignored paths', () => {
  assert.equal(shouldWatch('src/app.ts'), true);
  assert.equal(shouldWatch('src/app.mjs'), true);
  assert.equal(shouldWatch('src/app.js'), true);
  assert.equal(shouldWatch('src/app.cs'), true);
  assert.equal(shouldWatch('src/app.py'), false);
  assert.equal(shouldWatch('node_modules/foo/index.js'), false);
  assert.equal(shouldWatch('.planning/state.json'), false);
  assert.equal(shouldWatch('.planning/source.ts'), false);
  assert.equal(shouldWatch('.worktrees/branch/src/app.ts'), false);
  assert.equal(shouldWatch('graphify-out/graph.json'), false);
  assert.equal(shouldWatch('graphify-out/bundle.js'), false);
  assert.equal(shouldWatch('.graphify_analysis.json'), false);
  assert.equal(shouldWatch('.graphify_test.ts'), false);
  assert.equal(shouldWatch('dist/bundle.js'), false);
  assert.equal(shouldWatch('.opencode/plugins/pmc.ts'), false);
  assert.equal(shouldWatch('nested/.opencode/config.js'), false);
  assert.equal(shouldWatch('README.md'), false);
});

test('debounce delays execution', async () => {
  let count = 0;
  const fn = debounce(() => { count++; }, 50);
  fn();
  fn();
  fn();
  assert.equal(count, 0);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(count, 1);
});
