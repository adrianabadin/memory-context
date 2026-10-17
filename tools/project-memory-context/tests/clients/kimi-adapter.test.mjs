import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
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

import { kimiAdapter } from '../../src/clients/adapters/kimi.mjs';

import { planInstallation } from '../../src/clients/plan.mjs';
import { executePlan } from '../../src/clients/execute.mjs';
import { verifyInstallation } from '../../src/clients/verify.mjs';

const PROJECT_ROOT_CWD = process.cwd();
const CONTEXT_ROOTS = {
  projectRoot: join(PROJECT_ROOT_CWD, 'project'),
  homeDir: join(PROJECT_ROOT_CWD, 'home'),
};

async function withKimiOnlyTree(fn) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-kimi-prj-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'pmc-kimi-home-'));
  await mkdir(join(projectRoot, '.kimi-code'), { recursive: true });
  try {
    await fn({ projectRoot, homeDir });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

test('kimiAdapter: exported as a frozen object with deterministic id, priority, flags and paths', () => {
  assert.equal(kimiAdapter.id, 'kimi');
  assert.equal(kimiAdapter.legacyId, null);
  assert.equal(Object.isFrozen(kimiAdapter), true);
  assert.deepEqual([...kimiAdapter.flags], ['--kimi']);
  assert.equal(kimiAdapter.priority, 70);
  assert.equal(typeof kimiAdapter.paths.projectConfig, 'function');
  assert.equal(typeof kimiAdapter.paths.globalConfig, 'function');
  assert.equal(typeof kimiAdapter.paths.skillsDir, 'function');

  // Path comparisons must be platform-aware — Windows path.join yields `\…`.
  const endsWith = (actual, tail) => actual.endsWith(tail.split('/').join(sep));
  assert.ok(
    endsWith(kimiAdapter.paths.projectConfig('/tmp/x'), '/tmp/x/.kimi-code/mcp.json'),
    `projectConfig should end with /tmp/x/.kimi-code/mcp.json, got ${kimiAdapter.paths.projectConfig('/tmp/x')}`,
  );
  assert.ok(
    endsWith(kimiAdapter.paths.skillsDir('/tmp/x'), '/tmp/x/.agents/skills'),
    `skillsDir should end with /tmp/x/.agents/skills, got ${kimiAdapter.paths.skillsDir('/tmp/x')}`,
  );
});

test('kimiAdapter: contract declares JSON mcp at projectConfig with top-level PMC-owned keys, instructions and skills, and no hooks', () => {
  assert.equal(kimiAdapter.capabilities.mcp.supported, true);
  assert.equal(kimiAdapter.capabilities.mcp.format, 'json');
  assert.equal(kimiAdapter.capabilities.mcp.target, 'projectConfig');
  assert.deepEqual(
    [...kimiAdapter.capabilities.mcp.ownedKeys].sort(),
    ['pmc-agent-memory', 'pmc-query'],
  );

  assert.equal(kimiAdapter.capabilities.instructions.supported, true);
  assert.equal(kimiAdapter.capabilities.instructions.format, 'markdown');
  assert.equal(kimiAdapter.capabilities.instructions.target, 'AGENTS.md');
  assert.equal(kimiAdapter.capabilities.instructions.marker, 'autostart');

  assert.equal(kimiAdapter.capabilities.skills.supported, true);
  assert.equal(kimiAdapter.capabilities.skills.format, 'files');
  assert.equal(kimiAdapter.capabilities.skills.target, 'skillsDir');

  assert.equal(kimiAdapter.capabilities.hooks, undefined);

  for (const name of ['mcp', 'instructions', 'skills']) {
    assert.equal(typeof kimiAdapter.writers[name], 'function', `writers.${name} must be a function`);
    assert.equal(typeof kimiAdapter.verifiers[name], 'function', `verifiers.${name} must be a function`);
  }
});

test('kimiAdapter: validateAdapterContract accepts with context roots', () => {
  assert.equal(validateAdapterContract(kimiAdapter, PROBE_TABLE, CONTEXT_ROOTS), true);
});

test('kimiAdapter: registration in CLIENT_REGISTRY passes validateRegistry with no priority or flag collision', () => {
  assert.ok(CLIENT_REGISTRY.includes(kimiAdapter));
  assert.equal(validateRegistry(CLIENT_REGISTRY, PROBE_TABLE, CONTEXT_ROOTS), true);
  assert.equal(getAdapter('kimi'), kimiAdapter);
});

test('CLIENT_MARKERS.kimi exposes project marker .kimi-code and an empty instructions-file set', () => {
  assert.deepEqual(CLIENT_MARKERS.kimi, { project: ['.kimi-code'], instructionFiles: [] });
});

test('PROBE_TABLE.kimiVersion default returns {status:"skipped", reason:"version-threshold-unverified"}', async () => {
  const r = await PROBE_TABLE.kimiVersion();
  assert.deepEqual(r, { status: 'skipped', reason: 'version-threshold-unverified' });
});

test('kimiAdapter mcp writer: writes .kimi-code/mcp.json as a bare top-level server map with BOTH PMC servers, preserving foreign keys', async () => {
  await withKimiOnlyTree(async ({ projectRoot }) => {
    const adapter = getAdapter('kimi');
    const ctx = {
      projectRoot,
      homeDir: projectRoot,
      globalConfigDir: projectRoot,
      packageRoot: PROJECT_ROOT_CWD,
      placeholders: { PMC_BIN: 'pmc' },
      readTemplate: async () => '# Template\n',
    };

    const configPath = join(projectRoot, '.kimi-code', 'mcp.json');
    // Seed a user-owned server to prove lossless preservation.
    const seed = { 'my-own-server': { command: 'node', args: ['srv.js'] } };
    await writeFile(configPath, JSON.stringify(seed, null, 2) + '\n', 'utf8');

    const outcome = await adapter.writers.mcp(ctx);
    assert.ok(['installed', 'unchanged'].includes(outcome.status), `expected installed/unchanged, got ${outcome.status}`);

    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    // Bare top-level map — NO mcpServers / mcp wrapper.
    assert.equal(parsed.mcpServers, undefined);
    assert.equal(parsed.mcp, undefined);
    // Both PMC servers land at the top level in the STANDARD MCP stdio shape:
    // { command: string, args: string[], env: object } — no OpenCode envelope.
    assert.ok(parsed['pmc-query'], 'pmc-query must exist at top level');
    assert.ok(parsed['pmc-agent-memory'], 'pmc-agent-memory must exist at top level');
    for (const name of ['pmc-query', 'pmc-agent-memory']) {
      const server = parsed[name];
      assert.equal(typeof server.command, 'string', `${name}.command must be a string`);
      assert.ok(Array.isArray(server.args), `${name}.args must be an array`);
      assert.ok(server.args.every((a) => typeof a === 'string'), `${name}.args entries must be strings`);
      assert.equal(typeof server.env, 'object', `${name}.env must be an object`);
      // OpenCode-style envelope keys must NOT leak into kimi's schema.
      assert.equal(server.type, undefined, `${name} must not have a type key`);
      assert.equal(server.enabled, undefined, `${name} must not have an enabled key`);
      assert.equal(server.environment, undefined, `${name} must not have an environment key`);
    }
    assert.equal(parsed['pmc-query'].command, 'npx');
    assert.deepEqual(parsed['pmc-query'].args, [
      '--yes',
      '--package',
      '@aabadin/project-memory-context',
      'pmc-query-server',
    ]);
    assert.deepEqual(parsed['pmc-query'].env, {
      PMC_PROJECT_ROOT: projectRoot,
    });
    assert.equal(parsed['pmc-agent-memory'].command, 'npx');
    assert.deepEqual(parsed['pmc-agent-memory'].args, ['-y', '@aabadin/agent-memory-mcp']);
    assert.deepEqual(parsed['pmc-agent-memory'].env, {
      MEMORY_DB_PATH: join(projectRoot, '.planning', 'project-memory-context', 'memory-db'),
      EMBEDDING_MODEL: 'Xenova/bge-m3',
      EMBEDDING_DIMENSIONS: '1024',
      EMBEDDING_POOLING: 'cls',
    });
    // Foreign content survives.
    assert.deepEqual(parsed['my-own-server'], seed['my-own-server']);
    // Verifier accepts the file.
    assert.equal(await adapter.verifiers.mcp(ctx), true);

    // Idempotency: a second run leaves byte-identical content.
    const firstBytes = await readFile(configPath, 'utf8');
    const second = await adapter.writers.mcp(ctx);
    assert.equal(second.status, 'unchanged');
    assert.equal(await readFile(configPath, 'utf8'), firstBytes);
  });
});

test('kimiAdapter instructions writer: creates AGENTS.md with autostart block when missing', async () => {
  await withKimiOnlyTree(async ({ projectRoot }) => {
    const adapter = getAdapter('kimi');
    const ctx = {
      projectRoot,
      homeDir: projectRoot,
      globalConfigDir: projectRoot,
      packageRoot: PROJECT_ROOT_CWD,
      placeholders: { PMC_BIN: 'pmc' },
      readTemplate: async () => '<!-- pmc:autostart -->\nPMC AUTOSTART\n<!-- /pmc:autostart -->\n',
    };

    assert.equal(existsSync(join(projectRoot, 'AGENTS.md')), false);

    await adapter.writers.instructions(ctx);

    const text = await readFile(join(projectRoot, 'AGENTS.md'), 'utf8');
    assert.ok(text.includes('PMC AUTOSTART'));
    assert.ok(text.includes('<!-- pmc:autostart -->'));
    assert.ok(text.includes('<!-- /pmc:autostart -->'));
  });
});

test('kimiAdapter skills writer: writes SKILL.md into .agents/skills/<name>/ and is verifiable', async () => {
  await withKimiOnlyTree(async ({ projectRoot }) => {
    const adapter = getAdapter('kimi');
    const ctx = {
      projectRoot,
      homeDir: projectRoot,
      globalConfigDir: projectRoot,
      packageRoot: PROJECT_ROOT_CWD,
      placeholders: { PMC_BIN: 'pmc' },
      readTemplate: async (_root, tplPath) => `<!-- ${tplPath} body -->\n`,
    };

    assert.equal(await adapter.verifiers.skills(ctx), false);
    await adapter.writers.skills(ctx);
    assert.equal(await adapter.verifiers.skills(ctx), true);

    const skillPath = join(projectRoot, '.agents', 'skills', 'pmc-skill', 'SKILL.md');
    assert.equal(existsSync(skillPath), true);
    const text = await readFile(skillPath, 'utf8');
    assert.ok(text.includes('pmc-skill/SKILL.md body'));
  });
});

test('kimiAdapter: planner resolves targetPaths and never plans a hooks capability', async () => {
  await withKimiOnlyTree(async ({ projectRoot }) => {
    const { plan } = await planInstallation({
      projectRoot,
      registry: CLIENT_REGISTRY,
      probeTable: PROBE_TABLE,
      selectedIds: ['kimi'],
      consent: { dependencies: true },
    });

    const kimiClient = plan.clients.find((c) => c.clientId === 'kimi');
    assert.ok(kimiClient);

    const byCap = Object.fromEntries(kimiClient.capabilities.map((c) => [c.capability, c]));
    assert.equal(byCap.mcp.status, 'planned');
    assert.equal(byCap.mcp.targetPath, join(projectRoot, '.kimi-code', 'mcp.json'));
    assert.equal(byCap.instructions.status, 'planned');
    assert.equal(byCap.instructions.targetPath, join(projectRoot, 'AGENTS.md'));
    assert.equal(byCap.skills.status, 'planned');
    assert.equal(byCap.skills.targetPath, join(projectRoot, '.agents', 'skills'));
    assert.equal(byCap.hooks, undefined);
  });
});

test('kimiAdapter characterization: full plan→execute→verify on a kimi-only tree produces deterministic installed/skipped report', async () => {
  await withKimiOnlyTree(async ({ projectRoot, homeDir }) => {
    const { plan } = await planInstallation({
      projectRoot,
      homeDir,
      registry: CLIENT_REGISTRY,
      probeTable: PROBE_TABLE,
      selectedIds: ['kimi'],
      consent: { dependencies: true },
    });

    // Deterministic template loader — byte-identical content across runs.
    const loadTemplate = async (_root, tplPath) => {
      if (tplPath === 'opencode/autostart-snippet.md') {
        return '<!-- pmc:autostart -->\nAUTOSTART\n<!-- /pmc:autostart -->\n';
      }
      if (tplPath === 'pmc-skill/SKILL.md') {
        return '# PMC SKILL\n';
      }
      return `# Template ${tplPath}\n`;
    };

    const execution = await executePlan({
      plan,
      registry: CLIENT_REGISTRY,
      projectRoot,
      homeDir,
      placeholders: { PMC_BIN: 'pmc' },
      readTemplate: loadTemplate,
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
    assert.equal(byCap.skills.status, 'installed');
    assert.equal(verify.exitCode, 0);

    const mcpPath = join(projectRoot, '.kimi-code', 'mcp.json');
    const parsedMcp = JSON.parse(await readFile(mcpPath, 'utf8'));
    assert.ok(parsedMcp['pmc-query']);
    assert.ok(parsedMcp['pmc-agent-memory']);
    for (const name of ['pmc-query', 'pmc-agent-memory']) {
      assert.equal(typeof parsedMcp[name].command, 'string');
      assert.ok(Array.isArray(parsedMcp[name].args));
      assert.equal(typeof parsedMcp[name].env, 'object');
      assert.equal(parsedMcp[name].type, undefined);
      assert.equal(parsedMcp[name].enabled, undefined);
      assert.equal(parsedMcp[name].environment, undefined);
    }

    // Second run: mcp and instructions byte-compare as unchanged.
    const baseline = new Map([
      [mcpPath, await readFile(mcpPath, 'utf8')],
      [join(projectRoot, 'AGENTS.md'), await readFile(join(projectRoot, 'AGENTS.md'), 'utf8')],
    ]);

    const second = await executePlan({
      plan: { ...plan, planId: 'plan-second' },
      registry: CLIENT_REGISTRY,
      projectRoot,
      homeDir,
      placeholders: { PMC_BIN: 'pmc' },
      readTemplate: loadTemplate,
    });

    const secondVerify = await verifyInstallation({
      plan: { ...plan, planId: 'plan-second' },
      execution: second,
      registry: CLIENT_REGISTRY,
      baselineProvider: async (p) => {
        const st = existsSync(p) ? statSync(p) : null;
        if (!st || !st.isFile()) return undefined;
        const cached = baseline.get(p);
        if (cached !== undefined) return cached;
        return await readFile(p, 'utf8');
      },
    });

    const secondByCap = Object.fromEntries(
      secondVerify.clients[0].capabilities.map((c) => [c.capability, c]),
    );

    assert.equal(secondByCap.mcp.status, 'unchanged');
    assert.equal(secondByCap.instructions.status, 'unchanged');
    assert.equal(secondByCap.skills.status, 'installed');
    assert.equal(secondVerify.exitCode, 0);
  });
});

test('kimiAdapter: malformed existing .kimi-code/mcp.json fails the mcp capability at verify without rewriting the file', async () => {
  await withKimiOnlyTree(async ({ projectRoot, homeDir }) => {
    const configPath = join(projectRoot, '.kimi-code', 'mcp.json');
    const broken = '{ "pmc-query": { oops }';
    await writeFile(configPath, broken, 'utf8');

    const { plan } = await planInstallation({
      projectRoot,
      homeDir,
      registry: CLIENT_REGISTRY,
      probeTable: PROBE_TABLE,
      selectedIds: ['kimi'],
      consent: { dependencies: true },
    });

    const execution = await executePlan({
      plan,
      registry: CLIENT_REGISTRY,
      projectRoot,
      homeDir,
      readTemplate: async () => '<!-- pmc:autostart -->\nAUTOSTART\n<!-- /pmc:autostart -->\n',
    });
    const verify = await verifyInstallation({ plan, execution, registry: CLIENT_REGISTRY });

    const kimi = verify.clients.find((c) => c.clientId === 'kimi');
    const mcpCap = kimi.capabilities.find((c) => c.capability === 'mcp');
    assert.equal(mcpCap.status, 'failed');
    // Broken JSON was never rewritten.
    assert.equal(await readFile(configPath, 'utf8'), broken);
    // Other capabilities unaffected.
    const instructionsCap = kimi.capabilities.find((c) => c.capability === 'instructions');
    assert.ok(['installed', 'unchanged'].includes(instructionsCap.status));
    assert.equal(verify.exitCode, 1);
  });
});
