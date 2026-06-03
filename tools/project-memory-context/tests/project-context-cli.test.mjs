import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageRoot));

test('context wrapper exports runProjectContext', async () => {
  const mod = await import('../cli/context.mjs');
  assert.equal(typeof mod.runProjectContext, 'function');
});

test('project-context CLI bootstrap writes materialized json and markdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-context-cli-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', packageManager: 'npm@10', dependencies: { next: '^15.0.0' }, devDependencies: { typescript: '^5.0.0' } }), 'utf8');
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022' } }), 'utf8');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'main.ts'), 'export {}\n', 'utf8');
  await writeFile(join(root, 'README.md'), 'Use pnpm. Keep domain logic in src/domain.\n', 'utf8');

  const result = spawnSync(process.execPath, [
    join('tools', 'project-memory-context', 'cli', 'project-context.mjs'),
    root,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30000,
  });

  assert.equal(result.status, 0, `CLI failed: ${result.stderr}`);
  const json = JSON.parse(await readFile(join(root, '.planning', 'project-memory-context', 'project-context', 'materialized', 'stack-runtime.json'), 'utf8'));
  const markdown = await readFile(join(root, '.planning', 'project-memory-context', 'project-context', 'markdown', 'STACK-RUNTIME.md'), 'utf8');

  assert.equal(json.kind, 'stack-runtime');
  assert.match(markdown, /^# Project stack and runtime/m);
});
