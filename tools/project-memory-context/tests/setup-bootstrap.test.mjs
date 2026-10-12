import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, cp, copyFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import childProcess, { spawnSync } from 'node:child_process';
import os from 'node:os';

import { readJsonArtifact } from '../src/artifacts.mjs';
import { bootstrapProjectInstall } from '../src/setup-bootstrap.mjs';
async function runIsolatedSubprocess(...args) {
  const seam = await import('./helpers/mock-python-seam.mjs');
  return seam.runIsolatedSubprocess(...args);
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(packageRoot));

async function runFixtureScript(source, options = {}) {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'pmc-hermetic-fixture-'));
  const fixturePath = join(fixtureDir, 'fixture.mjs');
  try {
    await writeFile(fixturePath, source, 'utf8');
    const result = await runIsolatedSubprocess(process.execPath, [fixturePath], {
      ...options,
      allowedScripts: [...(options.allowedScripts ?? []), fixturePath],
    });
    const cleanup = result.cleanup;
    result.cleanup = async () => {
      await cleanup?.();
      await rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
    };
    return result;
  } catch (error) {
    await rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

test('parent import leaves child_process/os/fetch identities unchanged', async () => {
  const before = {
    spawn: childProcess.spawn,
    spawnSync: childProcess.spawnSync,
    execFile: childProcess.execFile,
    homedir: os.homedir,
    fetch: globalThis.fetch,
  };
  await import('./helpers/mock-python-seam.mjs');
  assert.equal(childProcess.spawn, before.spawn);
  assert.equal(childProcess.spawnSync, before.spawnSync);
  assert.equal(childProcess.execFile, before.execFile);
  assert.equal(os.homedir, before.homedir);
  assert.equal(globalThis.fetch, before.fetch);
});

test('bootstrapProjectInstall registers opencode plugin and writes .mcp.json', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-bootstrap-'));
  try {
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
  } finally {
    await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test('bootstrapProjectInstall creates .opencode/opencode.json when agent=opencode even without .opencode dir', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-bootstrap-noopencode-'));
  try {
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
  } finally {
    await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test('bootstrapProjectInstall writes configs for multiple agents', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-bootstrap-multi-'));
  try {
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
  } finally {
    await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test('bootstrapProjectInstall writes .mcp.json and enrichment config for Claude Code', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-bootstrap-'));
  try {
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
  } finally {
    await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test('bootstrapProjectInstall writes .mcp.json and enrichment config for Cursor', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-bootstrap-'));
  try {
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
  } finally {
    await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test('bootstrapProjectInstall preserves existing non-opencode config on re-bootstrap', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-bootstrap-'));
  try {
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
  } finally {
    await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  }
});

test('new-project generates project-context artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-bootstrap-'));
  let result;
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', dependencies: {} }), 'utf8');
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }), 'utf8');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'main.ts'), 'export {}', 'utf8');
    await writeFile(join(root, 'README.md'), 'Use pnpm.', 'utf8');

    result = await runIsolatedSubprocess(process.execPath, [
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

    const intentLog = await result.readSentinelLog();
    assert.ok(
      intentLog.some((e) => e.type === 'pip-install'),
      'fake install request should have been observed in sentinel log',
    );
  } finally {
    await result?.cleanup?.();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
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
  let result;
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo' }), 'utf8');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'main.ts'), 'export {}', 'utf8');

    const customPath = join(root, 'my-custom-graphify-bin');
    result = await runIsolatedSubprocess(process.execPath, [
      join('tools', 'project-memory-context', 'cli', 'bootstrap.mjs'),
      root,
      '--stage-a',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60000,
      env: { PMC_GRAPHIFY_PATH: customPath },
    });

    const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    assert.ok(
      combined.includes('my-custom-graphify-bin'),
      `bootstrap should use resolveGraphify which respects PMC_GRAPHIFY_PATH. Got: ${combined.slice(0, 500)}`,
    );

    const intentLog = await result.readSentinelLog();
    assert.ok(
      intentLog.some((e) => e.type === 'pip-install'),
      'fake install request should have been observed in sentinel log',
    );
  } finally {
    await result?.cleanup?.();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test('bootstrap.mjs CLI produces full install structure when run standalone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-bootstrap-standalone-'));
  let result;
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', dependencies: {} }), 'utf8');
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }), 'utf8');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'main.ts'), 'export {}', 'utf8');
    await writeFile(join(root, 'README.md'), 'Use pnpm.', 'utf8');

    result = await runIsolatedSubprocess(process.execPath, [
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

    const intentLog = await result.readSentinelLog();
    assert.ok(
      intentLog.some((e) => e.type === 'pip-install'),
      'fake install request should have been observed in sentinel log',
    );
  } finally {
    await result?.cleanup?.();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test('bootstrap.mjs copies bundled tools when executed from package layout', async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), 'pmc-bootstrap-package-target-'));
  const packageSandbox = await mkdtemp(join(tmpdir(), 'pmc-bootstrap-package-root-'));
  let result;

  try {
    await cp(join(packageRoot, 'cli'), join(packageSandbox, 'cli'), { recursive: true });
    await cp(join(packageRoot, 'src'), join(packageSandbox, 'src'), { recursive: true });
    await cp(join(packageRoot, 'templates'), join(packageSandbox, 'templates'), { recursive: true });
    await cp(join(packageRoot, 'plugin'), join(packageSandbox, 'plugin'), { recursive: true });
    await cp(join(packageRoot, 'mcp'), join(packageSandbox, 'mcp'), { recursive: true });
    await copyFile(join(packageRoot, 'package.json'), join(packageSandbox, 'package.json'));

    result = await runIsolatedSubprocess(process.execPath, [join(packageSandbox, 'cli', 'bootstrap.mjs'), targetRoot], {
      cwd: packageSandbox,
      allowedCliDirs: [join(packageSandbox, 'cli')],
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

    const intentLog = await result.readSentinelLog();
    assert.ok(
      intentLog.some((e) => e.type === 'pip-install'),
      'fake install request should have been observed in sentinel log',
    );
  } finally {
    await result?.cleanup?.();
    await rm(targetRoot, { recursive: true, force: true }).catch(() => {});
    await rm(packageSandbox, { recursive: true, force: true }).catch(() => {});
  }
});

test('bootstrap.mjs stage-b ignores .next build artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pmc-bootstrap-ignore-next-'));
  let result;
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', dependencies: {} }), 'utf8');
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.next', 'server', 'app'), { recursive: true });
    await writeFile(join(root, 'src', 'main.ts'), 'export function sourceSymbol() { return 1; }', 'utf8');
    await writeFile(join(root, '.next', 'server', 'app', 'generated.js'), 'export function buildArtifact() { return 2; }', 'utf8');

    result = await runIsolatedSubprocess(process.execPath, [
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

    const intentLog = await result.readSentinelLog();
    assert.ok(
      intentLog.some((e) => e.type === 'pip-install'),
      'fake install request should have been observed in sentinel log',
    );
  } finally {
    await result?.cleanup?.();
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test('controlled hermetic boundary rejects unknown external process execution without host forwarding', async () => {
  let result;
  try {
    result = await runIsolatedSubprocess('git', ['status'], {
      cwd: repoRoot,
      timeout: 5000,
    });
    assert.notEqual(result.status, 0);
    const combined = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`;
    assert.match(
      combined,
      /Hermetic test boundary: execution of unknown external process is denied/,
      'should deny unknown external command execution',
    );
    const intentLog = await result.readSentinelLog();
    assert.ok(
      intentLog.some((e) => e.type === 'denied-spawn' && e.command === 'git'),
      'should record denied command in sentinel log',
    );
  } finally {
    await result?.cleanup?.();
  }
});

test('controlled hermetic boundary blocks direct network interfaces and DNS in child process', async () => {
  const script = `
    import { lookup } from 'node:dns';
    import { connect } from 'node:net';
    import { get } from 'node:http';
    import { connect as connectHttp2 } from 'node:http2';

    let dnsBlocked = false;
    try {
      lookup('example.com', () => {});
    } catch (err) {
      dnsBlocked = err.message.includes('network access is disabled');
    }

    let netBlocked = false;
    try {
      connect(80, '127.0.0.1');
    } catch (err) {
      netBlocked = err.message.includes('network access is disabled');
    }

    let httpBlocked = false;
    try {
      get('http://127.0.0.1');
    } catch (err) {
      httpBlocked = err.message.includes('network access is disabled');
    }

    let http2Blocked = false;
    try {
      connectHttp2('http://127.0.0.1');
    } catch (err) {
      http2Blocked = err.message.includes('network access is disabled');
    }

    if (dnsBlocked && netBlocked && httpBlocked && http2Blocked) {
      console.error('ALL_INTERFACES_BLOCKED');
      process.exit(0);
    }
    console.error(JSON.stringify({ dnsBlocked, netBlocked, httpBlocked, http2Blocked }));
    process.exit(1);
  `;
  let result;
  try {
    result = await runFixtureScript(script, { timeout: 5000 });
    assert.equal(result.status, 0, `network interfaces should be blocked. stderr: ${result.stderr}`);
    assert.match(
      result.stderr ?? '',
      /ALL_INTERFACES_BLOCKED/,
      'net, http, http2, and dns should be blocked by controlled hermetic boundary',
    );
  } finally {
    await result?.cleanup?.();
  }
});

test('controlled hermetic boundary propagates safety to grandchild Node processes', async () => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'pmc-hermetic-grandchild-'));
  const childPath = join(fixtureDir, 'child.mjs');
  const grandchildPath = join(fixtureDir, 'grandchild.mjs');
  const grandchildScript = `
    import { spawnSync } from 'node:child_process';
    const result = spawnSync('curl', ['https://example.com'], { encoding: 'utf8' });
    console.error(result.stderr || result.error?.message || '');
    process.exit(result.status ?? 1);
  `;
  const childScript = `
    import { spawnSync } from 'node:child_process';
    const result = spawnSync(process.execPath, [${JSON.stringify(grandchildPath)}], { encoding: 'utf8' });
    console.error(result.stderr || '');
    process.exit(result.status ?? 0);
  `;
  let result;
  try {
    await writeFile(childPath, childScript, 'utf8');
    await writeFile(grandchildPath, grandchildScript, 'utf8');
    result = await runIsolatedSubprocess(process.execPath, [childPath], {
      allowedScripts: [childPath, grandchildPath],
      timeout: 10000,
    });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr ?? '',
      /Hermetic test boundary: execution of unknown external process is denied: curl/,
      'grandchild process should inherit denied external process boundary',
    );
  } finally {
    await result?.cleanup?.();
    await rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('controlled hermetic boundary isolates home roots and application configuration environment', async () => {
  const script = `
    import os from 'node:os';
    console.log(JSON.stringify({
      homedir: os.homedir(),
      envHome: process.env.HOME,
      envUserProfile: process.env.USERPROFILE,
      envAppData: process.env.APPDATA,
      envLocalAppdata: process.env.LOCALAPPDATA,
      envXdgConfig: process.env.XDG_CONFIG_HOME,
      codexHome: process.env.CODEX_HOME,
      opencodeConfigDir: process.env.OPENCODE_CONFIG_DIR,
    }));
  `;
  let result;
  try {
    result = await runFixtureScript(script, { timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout.trim());
    assert.equal(data.homedir, result.fakeHome, 'os.homedir() must match isolated fakeHome');
    assert.equal(data.envHome, result.fakeHome, 'process.env.HOME must match isolated fakeHome');
    assert.equal(data.envUserProfile, result.fakeHome, 'process.env.USERPROFILE must match isolated fakeHome');
    assert.equal(data.codexHome, undefined, 'host CODEX_HOME must be cleared');
    assert.equal(data.opencodeConfigDir, undefined, 'host OPENCODE_CONFIG_DIR must be cleared');
  } finally {
    await result?.cleanup?.();
  }
});

test('controlled hermetic boundary fakes and logs Python probe and pip-install installer intent', async () => {
  const script = `
    import { execFileSync, spawnSync } from 'node:child_process';
    const pyVer = execFileSync('python', ['--version'], { encoding: 'utf8' });
    console.log('PY_VER:' + pyVer.trim());
    const pipRes = spawnSync('python', ['-m', 'pip', 'install', 'git+https://example.test/repo.git'], { encoding: 'utf8' });
    console.log('PIP_STATUS:' + pipRes.status);
    console.log('PIP_OUT:' + pipRes.stdout.trim());
  `;
  let result;
  try {
    result = await runFixtureScript(script, { timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PY_VER:Python 3\.11\.0/);
    assert.match(result.stdout, /PIP_STATUS:0/);
    assert.match(result.stdout, /PIP_OUT:Successfully installed graphifyy/);

    const intentLog = await result.readSentinelLog();
    assert.ok(intentLog.some((e) => e.type === 'python-probe'), 'python probe intent must be logged');
    assert.ok(intentLog.some((e) => e.type === 'pip-install'), 'pip-install intent must be logged');
  } finally {
    await result?.cleanup?.();
  }
});

test('controlled hermetic boundary denies direct external installer execution without host launch', async () => {
  const fakeBinDir = await mkdtemp(join(tmpdir(), 'pmc-harmless-installer-'));
  const fakePip = join(fakeBinDir, process.platform === 'win32' ? 'pip.cmd' : 'pip');
  await writeFile(
    fakePip,
    process.platform === 'win32'
      ? '@echo off\r\necho fake-pip-executed\r\nexit /b 0\r\n'
      : '#!/bin/sh\necho fake-pip-executed\nexit 0\n',
    { mode: 0o755 },
  );

  let result;
  try {
    result = await runIsolatedSubprocess('pip', ['install', 'harmless-pkg'], {
      cwd: repoRoot,
      env: { PATH: fakeBinDir },
      timeout: 5000,
    });

    assert.notEqual(result.status, 0, 'direct pip invocation via runIsolatedSubprocess must fail closed');
    assert.equal(result.error?.code, 'EACCES', 'error code should be EACCES');
    assert.match(
      result.stderr ?? '',
      /Hermetic test boundary: execution of direct external installer is denied|Hermetic test boundary: execution of unknown external process is denied/,
      'should deny direct installer execution',
    );
    assert.doesNotMatch(result.stdout ?? '', /fake-pip-executed/, 'fake installer fixture must never be executed');

    const intentLog = await result.readSentinelLog();
    assert.ok(
      intentLog.some((e) => e.type === 'denied-spawn'),
      'denied spawn intent must be logged',
    );
  } finally {
    await result?.cleanup?.();
    await rm(fakeBinDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('controlled hermetic boundary denies shell execution and preload bypass flags', async () => {
  let resShell;
  let resNoOpt;
  let resArbScript;
  const arbDir = await mkdtemp(join(tmpdir(), 'pmc-arbitrary-script-'));
  const arbScript = join(arbDir, 'arbitrary.js');
  await writeFile(arbScript, 'console.log("EXECUTED_ARBITRARY");', 'utf8');

  try {
    // 1. shell: true must be denied
    resShell = await runIsolatedSubprocess(process.execPath, [arbScript], {
      shell: true,
      timeout: 5000,
    });
    assert.notEqual(resShell.status, 0, 'shell: true must be denied');
    assert.match(resShell.stderr ?? '', /shell execution is denied/);

    // 2. --no-node-options must be denied
    resNoOpt = await runIsolatedSubprocess(process.execPath, ['--no-node-options', arbScript], {
      timeout: 5000,
    });
    assert.notEqual(resNoOpt.status, 0, '--no-node-options must be denied');
    assert.match(resNoOpt.stderr ?? '', /--no-node-options flag is denied/);

    // 3. arbitrary script in tmpdir must be denied
    resArbScript = await runIsolatedSubprocess(process.execPath, [arbScript], {
      timeout: 5000,
    });
    assert.notEqual(resArbScript.status, 0, 'arbitrary script in tmpdir must be denied');
    assert.match(resArbScript.stderr ?? '', /uncontrolled script is denied/);
  } finally {
    await resShell?.cleanup?.();
    await resNoOpt?.cleanup?.();
    await resArbScript?.cleanup?.();
    await rm(arbDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('controlled hermetic boundary pins owned home and discards caller override', async () => {
  const script = `
    import os from 'node:os';
    console.log(JSON.stringify({
      homedir: os.homedir(),
      envHome: process.env.HOME,
      isolatedHome: process.env.PMC_TEST_ISOLATED_HOME,
    }));
  `;
  let result;
  try {
    result = await runFixtureScript(script, {
      env: { PMC_TEST_ISOLATED_HOME: 'C:\\fake\\unowned\\caller\\home' },
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout.trim());
    assert.notEqual(data.isolatedHome, 'C:\\fake\\unowned\\caller\\home', 'caller must not be able to override PMC_TEST_ISOLATED_HOME');
    assert.equal(data.homedir, result.fakeHome, 'homedir must match runner-pinned fakeHome');
    assert.equal(data.envHome, result.fakeHome, 'HOME must match runner-pinned fakeHome');
  } finally {
    await result?.cleanup?.();
  }
});

test('controlled hermetic boundary rejects sibling and unknown script paths under path containment', async () => {
  const siblingScript = join(`${repoRoot}-sibling`, 'tools', 'project-memory-context', 'cli', 'bootstrap.mjs');
  const fixtureDir = await mkdtemp(join(tmpdir(), 'pmc-safe-option-fixture-'));
  const harmlessScript = join(fixtureDir, 'harmless.mjs');
  await writeFile(harmlessScript, "console.log('harmless fixture ran');", 'utf8');
  let result;
  let optionResult;
  try {
    result = await runIsolatedSubprocess(process.execPath, [siblingScript], {
      timeout: 5000,
    });
    assert.notEqual(result.status, 0, 'sibling script must be rejected');
    assert.match(
      result.stderr ?? result.error?.message ?? '',
      /Hermetic test boundary: execution of uncontrolled script is denied|Hermetic test boundary: script outside controlled root is denied/,
      'should deny script from sibling directory matching prefix',
    );

    optionResult = await runIsolatedSubprocess(process.execPath, ['--unknown-node-option', harmlessScript], {
      cwd: fixtureDir,
      allowedScripts: [harmlessScript],
      timeout: 5000,
    });
    assert.notEqual(optionResult.status, 0, 'unknown Node option must be rejected before the harmless fixture runs');
    assert.match(optionResult.stderr ?? '', /unknown or disallowed option/);
  } finally {
    await result?.cleanup?.();
    await optionResult?.cleanup?.();
    await rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
  }
});
