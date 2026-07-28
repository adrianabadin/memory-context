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

import { codexAdapter } from '../../src/clients/adapters/codex.mjs';

import { planInstallation } from '../../src/clients/plan.mjs';
import { executePlan } from '../../src/clients/execute.mjs';
import { verifyInstallation } from '../../src/clients/verify.mjs';

const PROJECT_ROOT_CWD = process.cwd();
const CONTEXT_ROOTS = {
  projectRoot: join(PROJECT_ROOT_CWD, 'project'),
  homeDir: join(PROJECT_ROOT_CWD, 'home'),
};

async function withCodexOnlyTree(fn) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-codex-prj-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'pmc-codex-home-'));
  await mkdir(join(projectRoot, '.codex'), { recursive: true });
  try {
    await fn({ projectRoot, homeDir });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

test('codexAdapter: exported as a frozen object with deterministic id, priority, flags and paths', () => {
  assert.equal(codexAdapter.id, 'codex');
  assert.equal(Object.isFrozen(codexAdapter), true);
  assert.deepEqual([...codexAdapter.flags], ['--codex']);
  assert.equal(codexAdapter.priority, 60);
  assert.equal(typeof codexAdapter.paths.projectConfig, 'function');
  assert.equal(typeof codexAdapter.paths.globalConfig, 'function');
  assert.equal(typeof codexAdapter.paths.skillsDir, 'function');

  // Path comparisons must be platform-aware — Windows path.join yields `\…`.
  const endsWith = (actual, tail) => actual.endsWith(tail.split('/').join(sep));
  assert.ok(
    endsWith(codexAdapter.paths.projectConfig('/tmp/x'), '/tmp/x/.codex/config.toml'),
    `projectConfig should end with /tmp/x/.codex/config.toml, got ${codexAdapter.paths.projectConfig('/tmp/x')}`,
  );
  assert.ok(
    endsWith(codexAdapter.paths.globalConfig('/tmp/x'), '/tmp/x/.codex/config.toml'),
    `globalConfig should end with /tmp/x/.codex/config.toml, got ${codexAdapter.paths.globalConfig('/tmp/x')}`,
  );
  assert.ok(
    endsWith(codexAdapter.paths.skillsDir('/tmp/x'), '/tmp/x/.agents/skills'),
    `skillsDir should end with /tmp/x/.agents/skills, got ${codexAdapter.paths.skillsDir('/tmp/x')}`,
  );
});

test('codexAdapter: contract declares instructions, skills, version-gated hooks, and TOML mcp', () => {
  assert.equal(codexAdapter.capabilities.mcp.supported, true);
  assert.equal(codexAdapter.capabilities.mcp.format, 'toml');
  assert.equal(codexAdapter.capabilities.mcp.target, 'projectConfig');
  assert.deepEqual(
    [...codexAdapter.capabilities.mcp.ownedKeys].sort(),
    ['mcp_servers.pmc-agent-memory', 'mcp_servers.pmc-query'],
  );

  assert.equal(codexAdapter.capabilities.instructions.supported, true);
  assert.equal(codexAdapter.capabilities.instructions.format, 'markdown');
  assert.equal(codexAdapter.capabilities.instructions.target, 'AGENTS.md');
  assert.equal(codexAdapter.capabilities.instructions.marker, 'autostart');

  assert.equal(codexAdapter.capabilities.skills.supported, true);
  assert.equal(codexAdapter.capabilities.skills.format, 'files');
  assert.equal(codexAdapter.capabilities.skills.target, 'skillsDir');

  assert.equal(codexAdapter.capabilities.hooks.supported, 'version-gated');
  assert.equal(codexAdapter.capabilities.hooks.probe, 'codexVersion');

  for (const name of ['mcp', 'instructions', 'skills', 'hooks']) {
    assert.equal(typeof codexAdapter.writers[name], 'function', `writers.${name} must be a function`);
    assert.equal(typeof codexAdapter.verifiers[name], 'function', `verifiers.${name} must be a function`);
  }
});

test('codexAdapter: validateAdapterContract accepts with context roots', () => {
  assert.equal(validateAdapterContract(codexAdapter, PROBE_TABLE, CONTEXT_ROOTS), true);
});

test('codexAdapter: registration in CLIENT_REGISTRY passes validateRegistry with no priority or flag collision', () => {
  assert.ok(CLIENT_REGISTRY.includes(codexAdapter));
  assert.equal(validateRegistry(CLIENT_REGISTRY, PROBE_TABLE, CONTEXT_ROOTS), true);
  assert.equal(getAdapter('codex'), codexAdapter);
});

test('CLIENT_MARKERS.codex exposes project marker .codex and an empty instructions-file set', () => {
  assert.deepEqual(CLIENT_MARKERS.codex, { project: ['.codex'], instructionFiles: [] });
});

test('PROBE_TABLE.codexVersion default returns {status:"skipped", reason:"version-threshold-unverified"}', async () => {
  const r = await PROBE_TABLE.codexVersion();
  assert.deepEqual(r, { status: 'skipped', reason: 'version-threshold-unverified' });
});

test('codexAdapter mcp writer: splices PMC-owned keys into .codex/config.toml preserving foreign content', async () => {
  await withCodexOnlyTree(async ({ projectRoot }) => {
    const adapter = getAdapter('codex');
    const ctx = {
      projectRoot,
      homeDir: projectRoot,
      globalConfigDir: projectRoot,
      packageRoot: PROJECT_ROOT_CWD,
      placeholders: { PMC_BIN: 'pmc' },
      readTemplate: async () => '# Template\n',
    };

    const configPath = join(projectRoot, '.codex', 'config.toml');
    const seed = ['# foreign comment', 'model = "gpt-5"', '[other]', 'name = "left-alone"', ''].join('\n');
    await writeFile(configPath, seed, 'utf8');

    // Pre-condition: TOML cannot yet reference PMC owned keys
    const before = await readFile(configPath, 'utf8');
    assert.ok(!before.includes('pmc-query'));

    await adapter.writers.mcp(ctx);
    const updated = await readFile(configPath, 'utf8');

    // PMC-owned block opened and closed
    assert.ok(updated.includes('# pmc:mcp'));
    assert.ok(updated.includes('# /pmc:mcp'));
    // Both PMC mcp server entries land
    assert.ok(updated.includes('[mcp_servers.pmc-query]'));
    assert.ok(updated.includes('[mcp_servers.pmc-agent-memory]'));
    // Foreign content survives
    assert.ok(updated.includes('# foreign comment'));
    assert.ok(updated.includes('model = "gpt-5"'));
    assert.ok(updated.includes('[other]'));
    assert.ok(updated.includes('name = "left-alone"'));
  });
});

test('codexAdapter instructions writer: creates AGENTS.md with autostart block when missing', async () => {
  await withCodexOnlyTree(async ({ projectRoot }) => {
    const adapter = getAdapter('codex');
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

test('codexAdapter skills writer: writes SKILL.md into .agents/skills/<name>/ and is verifiable', async () => {
  await withCodexOnlyTree(async ({ projectRoot }) => {
    const adapter = getAdapter('codex');
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

test('codexAdapter hooks capability is version-gated and the probe returns the safe skipped default', async () => {
  const probe = PROBE_TABLE.codexVersion;
  const r = await probe();
  assert.equal(r.status, 'skipped');
  assert.equal(r.reason, 'version-threshold-unverified');

  // Planning should mark hooks as skipped, not planned.
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-codex-plan-'));
  try {
    const { plan } = await planInstallation({
      projectRoot,
      registry: CLIENT_REGISTRY,
      probeTable: PROBE_TABLE,
      selectedIds: ['codex'],
      consent: { dependencies: true },
    });
    const codexClient = plan.clients.find((c) => c.clientId === 'codex');
    assert.ok(codexClient, 'plan must include codex client');
    const hooksCap = codexClient.capabilities.find((c) => c.capability === 'hooks');
    assert.equal(hooksCap.status, 'skipped');
    assert.equal(hooksCap.reason, 'version-threshold-unverified');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('codexAdapter: planner never invents an instruction filename outside AGENTS.md', async () => {
  await withCodexOnlyTree(async ({ projectRoot }) => {
    const { plan } = await planInstallation({
      projectRoot,
      registry: CLIENT_REGISTRY,
      probeTable: PROBE_TABLE,
      selectedIds: ['codex'],
      consent: { dependencies: true },
    });

    const codexClient = plan.clients.find((c) => c.clientId === 'codex');
    assert.ok(codexClient);

    for (const cap of codexClient.capabilities) {
      if (cap.capability === 'instructions') {
        assert.equal(cap.targetPath, join(projectRoot, 'AGENTS.md'));
      }
      if (cap.capability === 'mcp') {
        assert.equal(cap.targetPath, join(projectRoot, '.codex', 'config.toml'));
      }
      if (cap.capability === 'skills') {
        assert.equal(cap.targetPath, join(projectRoot, '.agents', 'skills'));
      }
      if (cap.capability === 'hooks') {
        assert.equal(cap.status, 'skipped');
      }
    }
  });
});

test('codexAdapter characterization: full plan→execute→verify on a codex-only tree produces deterministic installed/unchanged/skipped report', async () => {
  await withCodexOnlyTree(async ({ projectRoot, homeDir }) => {
    const { plan } = await planInstallation({
      projectRoot,
      homeDir,
      registry: CLIENT_REGISTRY,
      probeTable: PROBE_TABLE,
      selectedIds: ['codex'],
      consent: { dependencies: true },
    });

    // Use a deterministic template loader across both runs so the writers always
    // emit byte-identical content. Real `readTemplate` resolves to packaged
    // assets; the loader is purely an injection seam for verification.
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
    assert.equal(byCap.hooks.status, 'skipped');
    assert.equal(verify.exitCode, 0);

    // Capture the on-disk bytes after the first run so the second verification
    // has a real baseline to compare against.
    const configPath = join(projectRoot, '.codex', 'config.toml');
    const agentsPath = join(projectRoot, 'AGENTS.md');
    const skillPath = join(projectRoot, '.agents', 'skills', 'pmc-skill', 'SKILL.md');
    const baseline = new Map([
      [configPath, await readFile(configPath, 'utf8')],
      [agentsPath, await readFile(agentsPath, 'utf8')],
      [skillPath, await readFile(skillPath, 'utf8')],
    ]);

    // Run the same pipeline a second time — every supported capability should
    // serialize to byte-identical bytes and verify as 'unchanged'.
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

    // MCP and instructions target a single file: byte equality with the
    // post-run-1 baseline is observable → status === 'unchanged'.
    assert.equal(secondByCap.mcp.status, 'unchanged');
    assert.equal(secondByCap.instructions.status, 'unchanged');
    // Skills targets the skills directory; verify.mjs cannot byte-compare a
    // directory path, so the status is 'installed' but the on-disk
    // SKILL.md must still be byte-identical to the run-1 baseline.
    assert.equal(secondByCap.skills.status, 'installed');
    assert.equal(
      await readFile(skillPath, 'utf8'),
      baseline.get(skillPath),
      'skills SKILL.md must be byte-identical between runs (deterministic)',
    );
    assert.equal(secondByCap.hooks.status, 'skipped');
    assert.equal(secondVerify.exitCode, 0);
  });
});

test('codexAdapter: malformed existing .codex/config.toml fails the mcp capability without writing and without blocking other clients', async () => {
  await withCodexOnlyTree(async ({ projectRoot, homeDir }) => {
    const configPath = join(projectRoot, '.codex', 'config.toml');
    const broken = '# broken\n[unterminated\n';
    await writeFile(configPath, broken, 'utf8');

    const fakeGoodAdapter = {
      id: 'good',
      priority: 5,
      flags: ['--good'],
      markers: { project: [], instructionFiles: [] },
      paths: {
        projectConfig: (root) => join(root, 'good.json'),
        globalConfig: (home) => join(home, 'good'),
      },
      capabilities: {
        mcp: {
          supported: true,
          format: 'json',
          target: 'projectConfig',
          ownedKeys: ['mcpServers.pmc'],
        },
      },
      writers: {
        mcp: async ({ projectRoot: pr }) => writeFile(join(pr, 'good.json'), '{"ok":true}\n', 'utf8'),
      },
      verifiers: {
        mcp: async ({ projectRoot: pr }) => existsSync(join(pr, 'good.json')),
      },
    };

    const registry = [getAdapter('codex'), fakeGoodAdapter];

    const { plan } = await planInstallation({
      projectRoot,
      homeDir,
      registry,
      probeTable: PROBE_TABLE,
      selectedIds: ['codex', 'good'],
      consent: { dependencies: true },
    });

    const execution = await executePlan({ plan, registry, projectRoot, homeDir });

    const verify = await verifyInstallation({ plan, execution, registry });

    const byClient = Object.fromEntries(verify.clients.map((c) => [c.clientId, c]));

    assert.ok(byClient.codex, 'expected a codex client in the report');
    const codexMcp = byClient.codex.capabilities.find((c) => c.capability === 'mcp');
    assert.equal(codexMcp.status, 'failed', 'malformed TOML must surface as failed for codex mcp');

    // good client unaffected
    const goodMcp = byClient.good.capabilities.find((c) => c.capability === 'mcp');
    assert.ok(['installed', 'unchanged'].includes(goodMcp.status), `good mcp should install, got ${goodMcp.status}`);

    // broken config was never rewritten
    const after = await readFile(configPath, 'utf8');
    assert.equal(after, broken, 'broken TOML must remain byte-identical after failure');

    // global exitCode is non-zero because codex failed
    assert.equal(verify.exitCode, 1);
  });
});
