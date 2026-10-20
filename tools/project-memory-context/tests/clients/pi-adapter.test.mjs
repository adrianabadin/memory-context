import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { CLIENT_REGISTRY, validateRegistry, getAdapter } from '../../src/clients/registry.mjs';
import { PROBE_TABLE } from '../../src/clients/probes.mjs';
import { CLIENT_MARKERS } from '../../src/clients/markers.mjs';
import { validateAdapterContract } from '../../src/clients/adapter-contract.mjs';
import { piAdapter } from '../../src/clients/adapters/pi.mjs';
import { planInstallation } from '../../src/clients/plan.mjs';
import { executePlan } from '../../src/clients/execute.mjs';
import { verifyInstallation } from '../../src/clients/verify.mjs';

const PROJECT_ROOT_CWD = process.cwd();
const CONTEXT_ROOTS = {
  projectRoot: join(PROJECT_ROOT_CWD, 'project'),
  homeDir: join(PROJECT_ROOT_CWD, 'home'),
};

async function withPiOnlyTree(fn) {
  // Fixtures stay inside the worktree; never resolve the real home or host config.
  const root = await mkdtemp(join(PROJECT_ROOT_CWD, '.s22-fixture-'));
  const projectRoot = join(root, 'project');
  const homeDir = join(root, 'home');
  await mkdir(join(projectRoot, '.pi'), { recursive: true });
  await mkdir(homeDir);
  try {
    await fn({ projectRoot, homeDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function piContext(projectRoot) {
  return {
    projectRoot, homeDir: projectRoot, globalConfigDir: projectRoot,
    packageRoot: PROJECT_ROOT_CWD, placeholders: { PMC_BIN: 'pmc' },
    readTemplate: async () => '# Template\n',
  };
}

async function install(projectRoot, homeDir) {
  const { plan } = await planInstallation({
    projectRoot, homeDir, registry: CLIENT_REGISTRY, probeTable: PROBE_TABLE,
    selectedIds: ['pi'], consent: { dependencies: false },
  });
  const execution = await executePlan({
    plan, registry: CLIENT_REGISTRY, projectRoot, homeDir,
    placeholders: { PMC_BIN: 'pmc' }, readTemplate: async () => '# Template\n',
  });
  const verification = await verifyInstallation({ plan, execution, registry: CLIENT_REGISTRY });
  return { plan, execution, verification };
}

test('piAdapter: frozen identity, priority, flags and native path; settings alias is inert', () => {
  assert.equal(piAdapter.id, 'pi');
  assert.equal(piAdapter.legacyId, null);
  assert.equal(Object.isFrozen(piAdapter), true);
  assert.deepEqual([...piAdapter.flags], ['--pi']);
  assert.equal(piAdapter.priority, 80);
  const endsWith = (actual, tail) => actual.endsWith(tail.split('/').join(sep));
  assert.ok(endsWith(piAdapter.paths.projectConfig('/tmp/x'), '/tmp/x/.pi/mcp.json'));
  assert.ok(endsWith(piAdapter.paths['.pi/settings.json']('/tmp/x'), '/tmp/x/.pi/settings.json'));
});

test('piAdapter: only native MCP capability, no settings/package writer or verifier', () => {
  assert.deepEqual(Object.keys(piAdapter.capabilities), ['mcp']);
  assert.equal(piAdapter.capabilities.mcp.supported, true);
  assert.equal(piAdapter.capabilities.mcp.format, 'json');
  assert.equal(piAdapter.capabilities.mcp.target, 'projectConfig');
  assert.deepEqual([...piAdapter.capabilities.mcp.ownedKeys].sort(), [
    'mcpServers.pmc-agent-memory', 'mcpServers.pmc-query',
  ]);
  assert.deepEqual(Object.keys(piAdapter.writers), ['mcp']);
  assert.deepEqual(Object.keys(piAdapter.verifiers), ['mcp']);
});

test('piAdapter: adapter and registry contracts remain valid', () => {
  assert.equal(validateAdapterContract(piAdapter, PROBE_TABLE, CONTEXT_ROOTS), true);
  assert.ok(CLIENT_REGISTRY.includes(piAdapter));
  assert.equal(validateRegistry(CLIENT_REGISTRY, PROBE_TABLE, CONTEXT_ROOTS), true);
  assert.equal(getAdapter('pi'), piAdapter);
  assert.deepEqual(CLIENT_MARKERS.pi, { project: ['.pi'], instructionFiles: [] });
});

test('piAdapter: native stdio projection preserves foreign keys and is byte-idempotent', async () => {
  await withPiOnlyTree(async ({ projectRoot }) => {
    const ctx = piContext(projectRoot);
    const configPath = join(projectRoot, '.pi', 'mcp.json');
    const seed = {
      customTopLevel: { keep: true },
      mcpServers: {
        foreign: { command: 'node', args: ['srv.js'], exposure: 'hidden' },
        'pmc-query': { timeout: 42, toolExposure: { '*': 'deferred' } },
      },
    };
    await writeFile(configPath, JSON.stringify(seed, null, 2) + '\n');
    const outcome = await piAdapter.writers.mcp(ctx);
    assert.equal(outcome.status, 'installed');
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(parsed.customTopLevel, seed.customTopLevel);
    assert.deepEqual(parsed.mcpServers.foreign, seed.mcpServers.foreign);
    assert.equal(parsed.mcpServers['pmc-query'].timeout, 42);
    assert.deepEqual(parsed.mcpServers['pmc-query'].toolExposure, { '*': 'deferred' });
    for (const name of ['pmc-query', 'pmc-agent-memory']) {
      const server = parsed.mcpServers[name];
      assert.equal(typeof server.command, 'string');
      assert.ok(Array.isArray(server.args));
      assert.ok(server.args.every((arg) => typeof arg === 'string'));
      assert.equal(typeof server.env, 'object');
      for (const key of ['type', 'enabled', 'environment']) assert.equal(server[key], undefined);
    }
    assert.deepEqual(parsed.mcpServers['pmc-query'].args, [
      '--yes', '--package', '@aabadin/project-memory-context', 'pmc-query-server',
    ]);
    assert.equal(parsed.mcpServers['pmc-query'].command, 'npx');
    assert.deepEqual(parsed.mcpServers['pmc-query'].env, { PMC_PROJECT_ROOT: projectRoot });
    assert.equal(parsed.mcpServers['pmc-agent-memory'].command, 'npx');
    assert.deepEqual(parsed.mcpServers['pmc-agent-memory'].args, ['-y', '@aabadin/agent-memory-mcp']);
    assert.deepEqual(parsed.mcpServers['pmc-agent-memory'].env, {
      MEMORY_DB_PATH: join(projectRoot, '.planning', 'project-memory-context', 'memory-db'),
      EMBEDDING_MODEL: 'Xenova/bge-m3', EMBEDDING_DIMENSIONS: '1024', EMBEDDING_POOLING: 'cls',
    });
    assert.equal(await piAdapter.verifiers.mcp(ctx), true);
    const before = await readFile(configPath);
    assert.equal((await piAdapter.writers.mcp(ctx)).status, 'unchanged');
    assert.deepEqual(await readFile(configPath), before);
    assert.equal(existsSync(join(projectRoot, '.mcp.json')), false);
  });
});

test('piAdapter: malformed native JSON is rejected without overwriting bytes', async () => {
  await withPiOnlyTree(async ({ projectRoot }) => {
    const path = join(projectRoot, '.pi', 'mcp.json');
    const bytes = '{"mcpServers": broken\n';
    await writeFile(path, bytes);
    assert.deepEqual(await piAdapter.writers.mcp(piContext(projectRoot)), { malformed: true });
    assert.equal(await readFile(path, 'utf8'), bytes);
    assert.equal(await piAdapter.verifiers.mcp(piContext(projectRoot)), false);
    const result = await install(projectRoot, projectRoot);
    assert.notEqual(result.verification.exitCode, 0);
    assert.equal(await readFile(path, 'utf8'), bytes);
    assert.equal(existsSync(join(projectRoot, '.pi', 'settings.json')), false);
    assert.equal(existsSync(join(projectRoot, '.mcp.json')), false);
  });
});

test('piAdapter: planner targets only .pi/mcp.json without dependency consent', async () => {
  await withPiOnlyTree(async ({ projectRoot, homeDir }) => {
    const { plan } = await planInstallation({
      projectRoot, homeDir, registry: CLIENT_REGISTRY, probeTable: PROBE_TABLE,
      selectedIds: ['pi'], consent: { dependencies: false },
    });
    assert.deepEqual(plan.clients[0].capabilities.map(({ capability, status, targetPath }) =>
      ({ capability, status, targetPath })), [
      { capability: 'mcp', status: 'planned', targetPath: join(projectRoot, '.pi', 'mcp.json') },
    ]);
  });
});

test('piAdapter: full fresh pipeline writes native MCP only and repeats byte-identically', async () => {
  await withPiOnlyTree(async ({ projectRoot, homeDir }) => {
    const first = await install(projectRoot, homeDir);
    assert.equal(first.verification.exitCode, 0);
    assert.deepEqual(first.verification.clients[0].capabilities.map((cap) => cap.capability), ['mcp']);
    const path = join(projectRoot, '.pi', 'mcp.json');
    const bytes = await readFile(path);
    const mcp = JSON.parse(bytes);
    assert.ok(mcp.mcpServers['pmc-query']);
    assert.ok(mcp.mcpServers['pmc-agent-memory']);
    const second = await install(projectRoot, homeDir);
    assert.equal(second.verification.exitCode, 0);
    assert.deepEqual(await readFile(path), bytes);
    for (const root of [projectRoot, homeDir]) {
      for (const file of ['.mcp.json', '.pi/settings.json', '.pi/packages.json']) {
        assert.equal(existsSync(join(root, file)), false, `${root}/${file}`);
      }
    }
  });
});

test('piAdapter: existing settings/packages and shared MCP remain byte-identical, even malformed', async () => {
  await withPiOnlyTree(async ({ projectRoot, homeDir }) => {
    const preserved = new Map([
      [join(projectRoot, '.pi', 'settings.json'), '{"packages":["npm:pi-mcp-adapter","npm:pi-mcp-adapter","npm:@aabadin/project-memory-context","npm:foreign"], "model": "keep"}\n'],
      [join(projectRoot, '.pi', 'packages.json'), 'malformed package file\n'],
      [join(projectRoot, '.mcp.json'), '{ "mcpServers": { "foreign": {} } }\n'],
      [join(homeDir, 'settings.json'), 'malformed host fixture\n'],
    ]);
    for (const [path, bytes] of preserved) await writeFile(path, bytes);
    assert.equal((await install(projectRoot, homeDir)).verification.exitCode, 0);
    for (const [path, bytes] of preserved) assert.equal(await readFile(path, 'utf8'), bytes);
    await writeFile(join(projectRoot, '.pi', 'settings.json'), 'malformed settings\n');
    assert.equal((await install(projectRoot, homeDir)).verification.exitCode, 0);
    assert.equal(await readFile(join(projectRoot, '.pi', 'settings.json'), 'utf8'), 'malformed settings\n');
    for (const [path, bytes] of preserved) {
      if (!path.endsWith(join('.pi', 'settings.json'))) assert.equal(await readFile(path, 'utf8'), bytes);
    }
  });
});

test('piAdapter: verifier reads native config only, missing or incomplete files fail closed', async () => {
  await withPiOnlyTree(async ({ projectRoot }) => {
    const ctx = piContext(projectRoot);
    assert.equal(await piAdapter.verifiers.mcp(ctx), false);
    await writeFile(join(projectRoot, '.mcp.json'), JSON.stringify({ mcpServers: {
      'pmc-query': {}, 'pmc-agent-memory': {},
    } }));
    assert.equal(await piAdapter.verifiers.mcp(ctx), false);
    await writeFile(join(projectRoot, '.pi', 'mcp.json'), '{"mcpServers":{"pmc-query":{}}}');
    assert.equal(await piAdapter.verifiers.mcp(ctx), false);
  });
});

test('piAdapter: .pi marker and explicit --pi selection remain unchanged', async () => {
  const { selectClients } = await import('../../src/clients/detect.mjs');
  await withPiOnlyTree(async ({ projectRoot }) => {
    const result = selectClients({ projectRoot, registry: CLIENT_REGISTRY, exists: existsSync });
    assert.equal(result.source, 'detected');
    assert.ok(result.clientIds.includes('pi'));
    const flagged = selectClients({ projectRoot, registry: CLIENT_REGISTRY, exists: existsSync, flags: ['--pi'] });
    assert.equal(flagged.source, 'flag');
    assert.deepEqual(flagged.clientIds, ['pi']);
  });
});
