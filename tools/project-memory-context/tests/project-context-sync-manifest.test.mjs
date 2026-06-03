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

test('CLI appends 9 project-context entries to sync-manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-sync-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', packageManager: 'npm@10', dependencies: { next: '^15.0.0' }, devDependencies: { typescript: '^5.0.0' } }), 'utf8');
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022' } }), 'utf8');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'main.ts'), 'export {}\n', 'utf8');
  await writeFile(join(root, 'README.md'), 'Use pnpm.\n', 'utf8');

  const result = spawnSync(process.execPath, [CLI, root], { cwd: CWD, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `CLI failed: ${result.stderr}`);

  const sync = JSON.parse(await readFile(join(root, '.planning', 'project-memory-context', 'enrichment', 'sync-manifest.json'), 'utf8'));
  const projectContextEntries = sync.entries.filter((entry) => entry.source === 'project-context');

  assert.equal(projectContextEntries.length, 9);
  assert.equal(projectContextEntries[0].key_tag.startsWith('key:project-context:'), true);
  assert.equal(projectContextEntries[0].category, 'architecture');
});
