import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { readJsonArtifact } from '../src/artifacts.mjs';
import { bootstrapProjectInstall } from '../src/setup-bootstrap.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('bootstrapProjectInstall writes install state, local opencode config, and command templates', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-bootstrap-'));

  await bootstrapProjectInstall({
    projectRoot,
    packageRoot,
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaModel: 'deepseek-coder-v2:16b-ctx32k',
  });

  const installState = await readJsonArtifact(join(projectRoot, '.planning', 'project-memory-context', 'install.json'));
  const localConfig = await readJsonArtifact(join(projectRoot, '.opencode', 'opencode.json'));
  const commandText = await readFile(join(projectRoot, 'project-memory-context.md'), 'utf8');
  const workflowText = await readFile(join(projectRoot, 'project-memory-context workflow.md'), 'utf8');

  assert.equal(installState.ollamaBaseUrl, 'http://localhost:11434');
  assert.equal(installState.ollamaModel, 'deepseek-coder-v2:16b-ctx32k');
  assert.equal(installState.packageRoot, packageRoot);
  assert.ok(localConfig.plugin.includes('opencode-project-memory-context'));
  assert.match(commandText, /project-memory-context workflow\.md/);
  assert.match(workflowText, new RegExp(packageRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
