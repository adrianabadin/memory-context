import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import {
  CLIENT_REGISTRY,
  validateRegistry,
  getAdapter,
} from '../../src/clients/registry.mjs';
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

const PI_REQUIRED_PACKAGES = [
  'npm:@aabadin/project-memory-context',
  'npm:pi-mcp-adapter',
];

async function withPiOnlyTree(fn) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-pi-prj-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'pmc-pi-home-'));
  await mkdir(join(projectRoot, '.pi'), { recursive: true });
  try {
    await fn({ projectRoot, homeDir });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

function piContext(projectRoot, overrides = {}) {
  return {
    projectRoot,
    homeDir: projectRoot,
    globalConfigDir: projectRoot,
    packageRoot: PROJECT_ROOT_CWD,
    placeholders: { PMC_BIN: 'pmc' },
    readTemplate: async () => '# Template\n',
    ...overrides,
  };
}

test('piAdapter: exported as a frozen object with deterministic id, priority, flags and paths', () => {
  assert.equal(piAdapter.id, 'pi');
  assert.equal(piAdapter.legacyId, null);
  assert.equal(Object.isFrozen(piAdapter), true);
  assert.deepEqual([...piAdapter.flags], ['--pi']);
  assert.equal(piAdapter.priority, 80);
  assert.equal(typeof piAdapter.paths.projectConfig, 'function');
  assert.equal(typeof piAdapter.paths['.pi/settings.json'], 'function');

  // Path comparisons must be platform-aware — Windows path.join yields `\…`.
  const endsWith = (actual, tail) => actual.endsWith(tail.split('/').join(sep));
  assert.ok(
    endsWith(piAdapter.paths.projectConfig('/tmp/x'), '/tmp/x/.mcp.json'),
    `projectConfig should end with /tmp/x/.mcp.json, got ${piAdapter.paths.projectConfig('/tmp/x')}`,
  );
  assert.ok(
    endsWith(piAdapter.paths['.pi/settings.json']('/tmp/x'), '/tmp/x/.pi/settings.json'),
    `'.pi/settings.json' should end with /tmp/x/.pi/settings.json, got ${piAdapter.paths['.pi/settings.json']('/tmp/x')}`,
  );
});

test('piAdapter: contract declares shared-`.mcp.json` json mcp and a json instructions capability targeting .pi/settings.json; no skills/hooks', () => {
  // Same mcp declaration claude-code/cursor use for the shared `.mcp.json`.
  assert.equal(piAdapter.capabilities.mcp.supported, true);
  assert.equal(piAdapter.capabilities.mcp.format, 'json');
  assert.equal(piAdapter.capabilities.mcp.target, 'projectConfig');
  assert.deepEqual(
    [...piAdapter.capabilities.mcp.ownedKeys].sort(),
    ['mcpServers.pmc-agent-memory', 'mcpServers.pmc-query'],
  );

  assert.equal(piAdapter.capabilities.instructions.supported, true);
  assert.equal(piAdapter.capabilities.instructions.format, 'json');
  assert.equal(piAdapter.capabilities.instructions.target, '.pi/settings.json');

  assert.equal(piAdapter.capabilities.skills, undefined);
  assert.equal(piAdapter.capabilities.hooks, undefined);

  for (const name of ['mcp', 'instructions']) {
    assert.equal(typeof piAdapter.writers[name], 'function', `writers.${name} must be a function`);
    assert.equal(typeof piAdapter.verifiers[name], 'function', `verifiers.${name} must be a function`);
  }
});

test('piAdapter: validateAdapterContract accepts with context roots', () => {
  assert.equal(validateAdapterContract(piAdapter, PROBE_TABLE, CONTEXT_ROOTS), true);
});

test('piAdapter: registration in CLIENT_REGISTRY passes validateRegistry with no priority or flag collision', () => {
  assert.ok(CLIENT_REGISTRY.includes(piAdapter));
  assert.equal(validateRegistry(CLIENT_REGISTRY, PROBE_TABLE, CONTEXT_ROOTS), true);
  assert.equal(getAdapter('pi'), piAdapter);
});

test('CLIENT_MARKERS.pi exposes project marker .pi and an empty instructions-file set', () => {
  assert.deepEqual(CLIENT_MARKERS.pi, { project: ['.pi'], instructionFiles: [] });
});

test('piAdapter mcp writer: produces the SHARED .mcp.json with BOTH PMC servers in standard MCP stdio shape, preserving foreign keys', async () => {
  await withPiOnlyTree(async ({ projectRoot }) => {
    const adapter = getAdapter('pi');
    const ctx = piContext(projectRoot);

    const configPath = join(projectRoot, '.mcp.json');
    // Seed a user-owned top-level key and server to prove lossless preservation.
    const seed = { customTopLevel: true, mcpServers: { 'my-own-server': { command: 'node', args: ['srv.js'] } } };
    await writeFile(configPath, JSON.stringify(seed, null, 2) + '\n', 'utf8');

    const outcome = await adapter.writers.mcp(ctx);
    assert.ok(['installed', 'unchanged'].includes(outcome.status), `expected installed/unchanged, got ${outcome.status}`);

    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(parsed.customTopLevel, true);
    assert.deepEqual(parsed.mcpServers['my-own-server'], seed.mcpServers['my-own-server']);
    for (const name of ['pmc-query', 'pmc-agent-memory']) {
      const server = parsed.mcpServers[name];
      assert.ok(server, `mcpServers.${name} must exist`);
      assert.equal(typeof server.command, 'string', `${name}.command must be a string`);
      assert.ok(Array.isArray(server.args), `${name}.args must be an array`);
      assert.ok(server.args.every((a) => typeof a === 'string'), `${name}.args entries must be strings`);
      assert.equal(typeof server.env, 'object', `${name}.env must be an object`);
      // OpenCode-style envelope keys must NOT leak into the shared stdio schema.
      assert.equal(server.type, undefined, `${name} must not have a type key`);
      assert.equal(server.enabled, undefined, `${name} must not have an enabled key`);
      assert.equal(server.environment, undefined, `${name} must not have an environment key`);
    }
    assert.equal(parsed.mcpServers['pmc-query'].command, 'npx');
    assert.deepEqual(parsed.mcpServers['pmc-query'].args, [
      '--yes',
      '--package',
      '@aabadin/project-memory-context',
      'pmc-query-server',
    ]);
    assert.deepEqual(parsed.mcpServers['pmc-query'].env, {
      PMC_PROJECT_ROOT: projectRoot,
    });
    assert.equal(parsed.mcpServers['pmc-agent-memory'].command, 'npx');
    assert.deepEqual(parsed.mcpServers['pmc-agent-memory'].args, ['-y', '@aabadin/agent-memory-mcp']);
    assert.deepEqual(parsed.mcpServers['pmc-agent-memory'].env, {
      MEMORY_DB_PATH: join(projectRoot, '.planning', 'project-memory-context', 'memory-db'),
      EMBEDDING_MODEL: 'Xenova/bge-m3',
      EMBEDDING_DIMENSIONS: '1024',
      EMBEDDING_POOLING: 'cls',
    });
    // Verifier accepts the file.
    assert.equal(await adapter.verifiers.mcp(ctx), true);

    // Idempotency: a second run leaves byte-identical content.
    const firstBytes = await readFile(configPath, 'utf8');
    const second = await adapter.writers.mcp(ctx);
    assert.equal(second.status, 'unchanged');
    assert.equal(await readFile(configPath, 'utf8'), firstBytes);
  });
});

test('piAdapter instructions writer: creates .pi/settings.json with BOTH required npm packages when missing', async () => {
  await withPiOnlyTree(async ({ projectRoot }) => {
    const adapter = getAdapter('pi');
    const ctx = piContext(projectRoot);

    assert.equal(existsSync(join(projectRoot, '.pi', 'settings.json')), false);

    const outcome = await adapter.writers.instructions(ctx);
    assert.ok(['installed', 'unchanged'].includes(outcome.status));

    const parsed = JSON.parse(await readFile(join(projectRoot, '.pi', 'settings.json'), 'utf8'));
    for (const pkg of PI_REQUIRED_PACKAGES) {
      assert.ok(parsed.packages.includes(pkg), `packages must include ${pkg}, got ${JSON.stringify(parsed.packages)}`);
    }
    assert.equal(await adapter.verifiers.instructions(ctx), true);

    // Idempotency: a second run is byte-identical and reported unchanged.
    const firstBytes = await readFile(join(projectRoot, '.pi', 'settings.json'), 'utf8');
    const second = await adapter.writers.instructions(ctx);
    assert.equal(second.status, 'unchanged');
    assert.equal(await readFile(join(projectRoot, '.pi', 'settings.json'), 'utf8'), firstBytes);
  });
});

test('piAdapter instructions writer: dedups required packages and preserves pre-existing packages and other keys', async () => {
  await withPiOnlyTree(async ({ projectRoot }) => {
    const adapter = getAdapter('pi');
    const ctx = piContext(projectRoot);

    const configPath = join(projectRoot, '.pi', 'settings.json');
    const seed = {
      model: 'some-model',
      nested: { keep: true },
      packages: [
        'npm:pi-mcp-adapter',        // pre-existing required entry — kept once
        'npm:pi-mcp-adapter',        // duplicate required entry — dropped
        'npm:some-other-package',    // foreign package — preserved
        'npm:@aabadin/project-memory-context', // pre-existing required entry — kept once
        'npm:@aabadin/project-memory-context', // duplicate required entry — dropped
      ],
    };
    await writeFile(configPath, JSON.stringify(seed, null, 2) + '\n', 'utf8');

    await adapter.writers.instructions(ctx);

    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(parsed.packages, [
      'npm:pi-mcp-adapter',
      'npm:some-other-package',
      'npm:@aabadin/project-memory-context',
    ]);
    // Other keys survive verbatim.
    assert.equal(parsed.model, 'some-model');
    assert.deepEqual(parsed.nested, { keep: true });
    assert.equal(await adapter.verifiers.instructions(ctx), true);
  });
});

test('piAdapter: planner resolves targetPaths for the shared .mcp.json and .pi/settings.json and never plans skills/hooks', async () => {
  await withPiOnlyTree(async ({ projectRoot }) => {
    const { plan } = await planInstallation({
      projectRoot,
      registry: CLIENT_REGISTRY,
      probeTable: PROBE_TABLE,
      selectedIds: ['pi'],
      consent: { dependencies: false },
    });

    const piClient = plan.clients.find((c) => c.clientId === 'pi');
    assert.ok(piClient);

    const byCap = Object.fromEntries(piClient.capabilities.map((c) => [c.capability, c]));
    assert.equal(byCap.mcp.status, 'planned');
    assert.equal(byCap.mcp.targetPath, join(projectRoot, '.mcp.json'));
    assert.equal(byCap.instructions.status, 'planned');
    assert.equal(byCap.instructions.targetPath, join(projectRoot, '.pi', 'settings.json'));
    assert.equal(byCap.skills, undefined);
    assert.equal(byCap.hooks, undefined);
  });
});

test('piAdapter: full plan→execute→verify on a pi-only tree writes .pi/settings.json AND the shared .mcp.json, and is idempotent', async () => {
  await withPiOnlyTree(async ({ projectRoot, homeDir }) => {
    const { plan } = await planInstallation({
      projectRoot,
      homeDir,
      registry: CLIENT_REGISTRY,
      probeTable: PROBE_TABLE,
      selectedIds: ['pi'],
      consent: { dependencies: false },
    });

    const execution = await executePlan({
      plan,
      registry: CLIENT_REGISTRY,
      projectRoot,
      homeDir,
      placeholders: { PMC_BIN: 'pmc' },
      readTemplate: async () => '# Template\n',
    });

    const verify = await verifyInstallation({
      plan,
      execution,
      registry: CLIENT_REGISTRY,
    });

    const byCap = Object.fromEntries(
      verify.clients[0].capabilities.map((c) => [c.capability, c]),
    );
    assert.equal(byCap.mcp.status, 'installed');
    assert.equal(byCap.instructions.status, 'installed');
    assert.equal(verify.exitCode, 0);

    // Shared `.mcp.json` produced with both PMC servers.
    const mcp = JSON.parse(await readFile(join(projectRoot, '.mcp.json'), 'utf8'));
    assert.ok(mcp.mcpServers['pmc-query']);
    assert.ok(mcp.mcpServers['pmc-agent-memory']);

    // `.pi/settings.json` produced with both required npm packages.
    const settings = JSON.parse(await readFile(join(projectRoot, '.pi', 'settings.json'), 'utf8'));
    for (const pkg of PI_REQUIRED_PACKAGES) {
      assert.ok(settings.packages.includes(pkg), `packages must include ${pkg}`);
    }

    // Second run: both capabilities compare as byte-identical unchanged.
    const baseline = new Map([
      [join(projectRoot, '.mcp.json'), await readFile(join(projectRoot, '.mcp.json'), 'utf8')],
      [join(projectRoot, '.pi', 'settings.json'), await readFile(join(projectRoot, '.pi', 'settings.json'), 'utf8')],
    ]);

    const second = await executePlan({
      plan: { ...plan, planId: 'plan-second' },
      registry: CLIENT_REGISTRY,
      projectRoot,
      homeDir,
      placeholders: { PMC_BIN: 'pmc' },
      readTemplate: async () => '# Template\n',
    });

    const secondVerify = await verifyInstallation({
      plan: { ...plan, planId: 'plan-second' },
      execution: second,
      registry: CLIENT_REGISTRY,
      baselineProvider: async (p) => baseline.get(p),
    });

    const secondByCap = Object.fromEntries(
      secondVerify.clients[0].capabilities.map((c) => [c.capability, c]),
    );
    assert.equal(secondByCap.mcp.status, 'unchanged');
    assert.equal(secondByCap.instructions.status, 'unchanged');
    assert.equal(secondVerify.exitCode, 0);
  });
});

test('piAdapter: selectClients detects the .pi project marker as agent pi (markers-based, not platform DETECT_PRIORITY)', async () => {
  const { selectClients } = await import('../../src/clients/detect.mjs');
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-pi-detect-'));
  try {
    await mkdir(join(projectRoot, '.pi'), { recursive: true });
    const result = selectClients({
      projectRoot,
      registry: CLIENT_REGISTRY,
      exists: (p) => existsSync(p),
    });
    assert.equal(result.source, 'detected');
    assert.ok(result.clientIds.includes('pi'), `clientIds must include pi, got ${JSON.stringify(result.clientIds)}`);

    // Explicit --pi flag also selects pi.
    const flagged = selectClients({
      projectRoot,
      registry: CLIENT_REGISTRY,
      exists: (p) => existsSync(p),
      flags: ['--pi'],
    });
    assert.equal(flagged.source, 'flag');
    assert.deepEqual(flagged.clientIds, ['pi']);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
