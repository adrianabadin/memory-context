import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const CLI = join('tools', 'project-memory-context', 'cli', 'project-context.mjs');
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const CWD = dirname(dirname(packageRoot));

async function bootstrap(root) {
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', packageManager: 'npm@10', dependencies: { next: '^15.0.0' }, devDependencies: { typescript: '^5.0.0' } }), 'utf8');
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022' } }), 'utf8');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'main.ts'), 'export {}\n', 'utf8');
  await writeFile(join(root, 'README.md'), 'Use pnpm.\n', 'utf8');
  const r = spawnSync(process.execPath, [CLI, root], { cwd: CWD, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, `Bootstrap failed: ${r.stderr}`);
}

test('refresh mode only rewrites invalidated memories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-refresh-'));
  await bootstrap(root);

  const initialStack = JSON.parse(await readFile(join(root, '.planning', 'project-memory-context', 'project-context', 'materialized', 'stack-runtime.json'), 'utf8'));
  const initialRules = JSON.parse(await readFile(join(root, '.planning', 'project-memory-context', 'project-context', 'materialized', 'technical-rules.json'), 'utf8'));

  await writeFile(join(root, 'README.md'), 'Use npm. Avoid globals.\n', 'utf8');

  const r = spawnSync(process.execPath, [CLI, '--refresh', root], { cwd: CWD, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, `Refresh failed: ${r.stderr}`);

  const refreshedStack = JSON.parse(await readFile(join(root, '.planning', 'project-memory-context', 'project-context', 'materialized', 'stack-runtime.json'), 'utf8'));
  const refreshedRules = JSON.parse(await readFile(join(root, '.planning', 'project-memory-context', 'project-context', 'materialized', 'technical-rules.json'), 'utf8'));

  assert.equal(refreshedStack.content_hash, initialStack.content_hash, 'stack should not change');
  assert.notEqual(refreshedRules.content_hash, initialRules.content_hash, 'rules should change');
});
