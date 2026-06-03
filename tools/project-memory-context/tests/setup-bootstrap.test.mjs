import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, cp, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import { readJsonArtifact } from '../src/artifacts.mjs';
import { bootstrapProjectInstall } from '../src/setup-bootstrap.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageRoot));

test('bootstrapProjectInstall registers opencode plugin and writes .mcp.json', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-bootstrap-'));
  await mkdir(join(projectRoot, '.opencode'), { recursive: true });

  const result = await bootstrapProjectInstall({
    projectRoot,
    packageRoot,
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaModel: 'deepseek-coder-v2:16b-ctx32k',
    agents: ['opencode'],
  });

  const installState = await readJsonArtifact(join(projectRoot, '.planning', 'project-memory-context', 'install.json'));
  const localConfig = await readJsonArtifact(join(projectRoot, '.opencode', 'opencode.json'));
  const mcpConfig = await readJsonArtifact(join(projectRoot, '.mcp.json'));
  const commandText = await readFile(join(projectRoot, 'project-memory-context.md'), 'utf8');
  const workflowText = await readFile(join(projectRoot, 'project-memory-context workflow.md'), 'utf8');

  assert.equal(result.configPath, join(projectRoot, '.opencode', 'opencode.json'));
  assert.deepEqual(result.agents, ['opencode']);
  assert.equal(installState.ollamaBaseUrl, 'http://localhost:11434');
  assert.equal(installState.ollamaModel, 'deepseek-coder-v2:16b-ctx32k');
  assert.equal(installState.packageRoot, packageRoot);
  assert.equal(installState.projectRoot, projectRoot);
  assert.ok(localConfig.plugin.includes('@aabadin/project-memory-context'));
  assert.deepEqual(localConfig.mcp['agent-memory'].command, ['npx', '-y', '@aabadin/agent-memory-mcp']);
  assert.equal(localConfig.mcp['agent-memory'].type, 'local');
  assert.equal(localConfig.mcp['agent-memory'].environment.MEMORY_DB_PATH, installState.memoryDbPath);
  assert.equal(mcpConfig.mcpServers['agent-memory'].command, 'npx');
  assert.deepEqual(mcpConfig.mcpServers['agent-memory'].args, ['-y', '@aabadin/agent-memory-mcp']);
  assert.equal(mcpConfig.mcpServers['agent-memory'].env.MEMORY_DB_PATH, installState.memoryDbPath);
  assert.equal(mcpConfig.mcpServers['pmc-query'].command, 'npx');
  assert.deepEqual(mcpConfig.mcpServers['pmc-query'].args, ['--yes', '--package', '@aabadin/project-memory-context', 'pmc-query-server']);
  assert.equal(mcpConfig.mcpServers['pmc-query'].env.PMC_PROJECT_ROOT, projectRoot);
  assert.match(commandText, /project-memory-context workflow\.md/);
  assert.match(workflowText, new RegExp(packageRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('bootstrapProjectInstall creates .opencode/opencode.json when agent=opencode even without .opencode dir', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-bootstrap-noopencode-'));
  assert.equal(existsSync(join(projectRoot, '.opencode')), false, 'should start without .opencode dir');

  const result = await bootstrapProjectInstall({
    projectRoot,
    packageRoot,
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaModel: 'deepseek-coder-v2:16b-ctx32k',
    agents: ['opencode'],
  });

  assert.equal(existsSync(join(projectRoot, '.opencode', 'opencode.json')), true, 'opencode.json should be created');
  const config = JSON.parse(await readFile(join(projectRoot, '.opencode', 'opencode.json'), 'utf8'));
  assert.ok(config.plugin.includes('@aabadin/project-memory-context'));
  assert.equal(config.mcp['agent-memory'].type, 'local');
  assert.deepEqual(config.mcp['agent-memory'].command, ['npx', '-y', '@aabadin/agent-memory-mcp']);

  const mcpConfig = JSON.parse(await readFile(join(projectRoot, '.mcp.json'), 'utf8'));
  assert.equal(mcpConfig.mcpServers['agent-memory'].command, 'npx');
  assert.equal(mcpConfig.mcpServers['pmc-query'].command, 'npx');
  assert.equal(mcpConfig.mcpServers['pmc-query'].env.PMC_PROJECT_ROOT, projectRoot);

  assert.equal(result.configPath, join(projectRoot, '.opencode', 'opencode.json'));
});

test('bootstrapProjectInstall writes configs for multiple agents', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-bootstrap-multi-'));

  const result = await bootstrapProjectInstall({
    projectRoot,
    packageRoot,
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaModel: 'deepseek-coder-v2:16b-ctx32k',
    agents: ['opencode', 'claude-code'],
  });

  assert.ok(existsSync(join(projectRoot, '.opencode', 'opencode.json')), 'opencode.json should exist');
  assert.ok(existsSync(join(projectRoot, '.claude', 'project-memory-context.json')), 'claude enrichment config should exist');
  assert.ok(existsSync(join(projectRoot, '.mcp.json')), '.mcp.json should exist');

  const opencodeConfig = JSON.parse(await readFile(join(projectRoot, '.opencode', 'opencode.json'), 'utf8'));
  assert.equal(opencodeConfig.mcp['agent-memory'].type, 'local');

  const claudeConfig = JSON.parse(await readFile(join(projectRoot, '.claude', 'project-memory-context.json'), 'utf8'));
  assert.equal(claudeConfig.enrichment.localModel.baseUrl, 'http://localhost:11434');

  assert.deepEqual(result.agents, ['opencode', 'claude-code']);
});

test('bootstrapProjectInstall writes .mcp.json and enrichment config for Claude Code', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-bootstrap-'));
  await mkdir(join(projectRoot, '.claude'), { recursive: true });

  const result = await bootstrapProjectInstall({
    projectRoot,
    packageRoot,
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaModel: 'deepseek-coder-v2:16b-ctx32k',
    agents: ['claude-code'],
  });

  const mcpConfig = await readJsonArtifact(join(projectRoot, '.mcp.json'));
  const config = await readJsonArtifact(join(projectRoot, '.claude', 'project-memory-context.json'));

  assert.equal(result.configPath, join(projectRoot, '.mcp.json'));
  assert.equal(mcpConfig.mcpServers['agent-memory'].command, 'npx');
  assert.deepEqual(mcpConfig.mcpServers['agent-memory'].args, ['-y', '@aabadin/agent-memory-mcp']);
  assert.equal(mcpConfig.mcpServers['pmc-query'].command, 'npx');
  assert.deepEqual(mcpConfig.mcpServers['pmc-query'].args, ['--yes', '--package', '@aabadin/project-memory-context', 'pmc-query-server']);
  assert.equal(mcpConfig.mcpServers['pmc-query'].env.PMC_PROJECT_ROOT, projectRoot);
  assert.equal(config.enrichment.localModel.baseUrl, 'http://localhost:11434');
  assert.equal(config.enrichment.localModel.model, 'deepseek-coder-v2:16b-ctx32k');
  assert.equal(existsSync(join(projectRoot, '.opencode', 'opencode.json')), false);
});

test('bootstrapProjectInstall writes .mcp.json and enrichment config for Cursor', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-bootstrap-'));
  await mkdir(join(projectRoot, '.cursor'), { recursive: true });

  const result = await bootstrapProjectInstall({
    projectRoot,
    packageRoot,
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaModel: 'deepseek-coder-v2:16b-ctx32k',
    agents: ['cursor'],
  });

  const mcpConfig = await readJsonArtifact(join(projectRoot, '.mcp.json'));
  const config = await readJsonArtifact(join(projectRoot, '.cursor', 'project-memory-context.json'));

  assert.equal(result.configPath, join(projectRoot, '.mcp.json'));
  assert.equal(existsSync(join(projectRoot, '.cursor', 'project-memory-context.json')), true);
  assert.equal(existsSync(join(projectRoot, '.mcp.json')), true);
  assert.equal(mcpConfig.mcpServers['agent-memory'].command, 'npx');
  assert.deepEqual(mcpConfig.mcpServers['agent-memory'].args, ['-y', '@aabadin/agent-memory-mcp']);
  assert.equal(mcpConfig.mcpServers['pmc-query'].command, 'npx');
  assert.deepEqual(mcpConfig.mcpServers['pmc-query'].args, ['--yes', '--package', '@aabadin/project-memory-context', 'pmc-query-server']);
  assert.equal(mcpConfig.mcpServers['pmc-query'].env.PMC_PROJECT_ROOT, projectRoot);
  assert.equal(config.enrichment.localModel.baseUrl, 'http://localhost:11434');
  assert.equal(config.enrichment.localModel.model, 'deepseek-coder-v2:16b-ctx32k');
  assert.equal(existsSync(join(projectRoot, '.opencode', 'opencode.json')), false);
});

test('bootstrapProjectInstall preserves existing non-opencode config on re-bootstrap', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-bootstrap-'));
  await mkdir(join(projectRoot, '.claude'), { recursive: true });
  await writeFile(join(projectRoot, '.claude', 'project-memory-context.json'), JSON.stringify({
    enrichment: {
      preferredModes: ['cloud-api'],
      cloudApi: {
        baseUrl: 'https://api.example.test/v1',
        model: 'gpt-test',
      },
      localModel: {
        provider: 'ollama',
        baseUrl: 'http://old-host:11434',
        model: 'old-model',
      },
    },
    custom: {
      keep: true,
    },
  }, null, 2));

  await bootstrapProjectInstall({
    projectRoot,
    packageRoot,
    ollamaBaseUrl: 'http://localhost:11434',
    ollamaModel: 'deepseek-coder-v2:16b-ctx32k',
    agents: ['claude-code'],
  });

  const config = await readJsonArtifact(join(projectRoot, '.claude', 'project-memory-context.json'));
  const mcpConfig = await readJsonArtifact(join(projectRoot, '.mcp.json'));

  assert.deepEqual(config.enrichment.preferredModes, ['cloud-api']);
  assert.equal(config.enrichment.cloudApi.baseUrl, 'https://api.example.test/v1');
  assert.equal(config.enrichment.cloudApi.model, 'gpt-test');
  assert.equal(config.enrichment.localModel.baseUrl, 'http://localhost:11434');
  assert.equal(config.enrichment.localModel.model, 'deepseek-coder-v2:16b-ctx32k');
  assert.equal(config.custom.keep, true);
  assert.equal(mcpConfig.mcpServers['agent-memory'].command, 'npx');
  assert.equal(mcpConfig.mcpServers['pmc-query'].command, 'npx');
  assert.equal(mcpConfig.mcpServers['pmc-query'].env.PMC_PROJECT_ROOT, projectRoot);
});

test('new-project generates project-context artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-bootstrap-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', dependencies: {} }), 'utf8');
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }), 'utf8');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'main.ts'), 'export {}', 'utf8');
  await writeFile(join(root, 'README.md'), 'Use pnpm.', 'utf8');

  const result = spawnSync(process.execPath, [
    join('tools', 'project-memory-context', 'cli', 'new-project.mjs'),
    root,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60000,
  });

  assert.equal(
    existsSync(join(root, '.planning', 'project-memory-context', 'project-context', 'materialized', 'stack-runtime.json')),
    true,
    `stack-runtime.json should exist. stderr: ${result.stderr ?? ''}`,
  );
  assert.equal(existsSync(join(root, 'tools', 'project-memory-context', 'cli', 'enrich-queue.mjs')), false);
  assert.equal(existsSync(join(root, 'tools', 'project-memory-context', 'src', 'providers', 'local-model-provider.mjs')), false);
  assert.equal(existsSync(join(root, 'tools', 'project-memory-context', 'src', 'providers', 'cloud-api-provider.mjs')), false);
});

test('bootstrap.mjs exports config helpers for programmatic use', async () => {
  const mod = await import('../cli/bootstrap.mjs');
  assert.equal(typeof mod.buildDefaultEnrichmentConfig, 'function');
  assert.equal(typeof mod.mergeEnrichmentConfig, 'function');

  const config = mod.buildDefaultEnrichmentConfig();
  assert.deepEqual(config.preferredModes, ['local-model', 'cloud-api', 'agent-subagent']);
});

test('bootstrap.mjs uses process.execPath for package-local Node scripts', async () => {
  const bootstrapText = await readFile(join(packageRoot, 'cli', 'bootstrap.mjs'), 'utf8');

  assert.match(bootstrapText, /spawnSync\(process\.execPath, \[worklistScript, \.\.\.files\]/);
  assert.match(bootstrapText, /spawnSync\(process\.execPath, \[altWorklistScript, \.\.\.files\]/);
  assert.match(bootstrapText, /spawnSync\(process\.execPath, \[projectContextScript, targetDir\]/);
  assert.doesNotMatch(bootstrapText, /spawnSync\('node', \[(worklistScript|altWorklistScript|projectContextScript)/);
});

test('bootstrap.mjs uses resolveGraphify when running stage-a (respects PMC_GRAPHIFY_PATH)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-resolve-graphify-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo' }), 'utf8');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'main.ts'), 'export {}', 'utf8');

  const customPath = join(root, 'my-custom-graphify-bin');
  const result = spawnSync(process.execPath, [
    join('tools', 'project-memory-context', 'cli', 'bootstrap.mjs'),
    root,
    '--stage-a',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, PMC_GRAPHIFY_PATH: customPath },
  });

  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.ok(
    combined.includes('my-custom-graphify-bin'),
    `bootstrap should use resolveGraphify which respects PMC_GRAPHIFY_PATH. Got: ${combined.slice(0, 500)}`,
  );
});

test('bootstrap.mjs CLI produces full install structure when run standalone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-bootstrap-standalone-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', dependencies: {} }), 'utf8');
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }), 'utf8');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'main.ts'), 'export {}', 'utf8');
  await writeFile(join(root, 'README.md'), 'Use pnpm.', 'utf8');

  const result = spawnSync(process.execPath, [
    join('tools', 'project-memory-context', 'cli', 'bootstrap.mjs'),
    root,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60000,
  });

  assert.equal(
    existsSync(join(root, '.planning', 'project-memory-context', 'project-context', 'materialized', 'stack-runtime.json')),
    true,
    `stack-runtime.json should exist. stderr: ${result.stderr ?? ''}`,
  );
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(existsSync(join(root, 'tools', 'project-memory-context', 'cli', 'enrich-queue.mjs')), false);
  assert.equal(existsSync(join(root, 'tools', 'project-memory-context', 'cli', 'bootstrap.mjs')), false);
  assert.equal(existsSync(join(root, 'tools', 'project-memory-context', 'src', 'providers', 'local-model-provider.mjs')), false);
  assert.match(combined, /pmc enrich \./);
  assert.doesNotMatch(combined, /node tools\/project-memory-context\/cli\/enrich-queue\.mjs/);
});

test('bootstrap.mjs copies bundled tools when executed from package layout', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'pmc-bootstrap-package-target-'));
  const packageSandbox = await mkdtemp(join(tmpdir(), 'pmc-bootstrap-package-root-'));

  await cp(join(packageRoot, 'cli'), join(packageSandbox, 'cli'), { recursive: true });
  await cp(join(packageRoot, 'src'), join(packageSandbox, 'src'), { recursive: true });
  await cp(join(packageRoot, 'templates'), join(packageSandbox, 'templates'), { recursive: true });
  await cp(join(packageRoot, 'plugin'), join(packageSandbox, 'plugin'), { recursive: true });
  await cp(join(packageRoot, 'mcp'), join(packageSandbox, 'mcp'), { recursive: true });
  await copyFile(join(packageRoot, 'package.json'), join(packageSandbox, 'package.json'));

  const result = spawnSync(process.execPath, [join(packageSandbox, 'cli', 'bootstrap.mjs'), targetRoot], {
    cwd: packageSandbox,
    encoding: 'utf8',
    timeout: 60000,
  });

  assert.equal(result.status, 0, result.stderr ?? result.stdout ?? 'bootstrap failed');
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(
    existsSync(join(targetRoot, 'tools', 'project-memory-context', 'cli', 'enrich-queue.mjs')),
    false,
    `enrich-queue.mjs should not be copied. stderr: ${result.stderr ?? ''}`,
  );
  assert.equal(
    existsSync(join(targetRoot, 'tools', 'project-memory-context', 'src', 'providers', 'local-model-provider.mjs')),
    false,
    `local-model-provider.mjs should not be copied. stderr: ${result.stderr ?? ''}`,
  );
  assert.match(combined, /pmc enrich \./);
  assert.doesNotMatch(combined, /node tools\/project-memory-context\/cli\/enrich-queue\.mjs/);
});

test('bootstrap.mjs stage-b ignores .next build artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-bootstrap-ignore-next-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', dependencies: {} }), 'utf8');
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, '.next', 'server', 'app'), { recursive: true });
  await writeFile(join(root, 'src', 'main.ts'), 'export function sourceSymbol() { return 1; }', 'utf8');
  await writeFile(join(root, '.next', 'server', 'app', 'generated.js'), 'export function buildArtifact() { return 2; }', 'utf8');

  const result = spawnSync(process.execPath, [
    join('tools', 'project-memory-context', 'cli', 'bootstrap.mjs'),
    root,
    '--stage-b',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60000,
  });

  assert.equal(result.status, 0, result.stderr ?? result.stdout ?? 'bootstrap failed');
  const worklist = JSON.parse(await readFile(join(root, '.planning', 'project-memory-context', 'enrichment', 'worklist.json'), 'utf8'));
  assert.equal(worklist.some((entry) => entry.filePath.startsWith('.next/')), false, 'worklist should exclude .next build artifacts');
  assert.equal(worklist.some((entry) => entry.filePath === 'src/main.ts'), true, 'worklist should include real source files');
});

test('deprecated enrich wrapper CLIs warn and delegate to pmc enrich behavior', async () => {
  const wrappers = [
    'enrich-sync.mjs',
    'enrich-orchestrator.mjs',
    'batch-enrich.mjs',
    'enrich-batch.mjs',
  ];

  for (const wrapper of wrappers) {
    const result = spawnSync(process.execPath, [join('tools', 'project-memory-context', 'cli', wrapper), '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60000,
    });

    const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.equal(result.status, 0, `${wrapper} should delegate successfully. Output: ${combined}`);
    assert.match(combined, /pmc enrich \./, `${wrapper} should print migration guidance`);
    assert.match(combined, /Usage: pmc enrich/, `${wrapper} should delegate to enrich help output`);
    assert.doesNotMatch(combined, /node tools\/project-memory-context\/cli\//, `${wrapper} should not point at package-internal CLI paths`);
  }
});
