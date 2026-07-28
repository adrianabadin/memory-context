import test from 'node:test';
import assert from 'node:assert/strict';
import { join, isAbsolute } from 'node:path';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { planInstallation } from '../../src/clients/plan.mjs';
import { CLIENT_REGISTRY } from '../../src/clients/registry.mjs';
import { PROBE_TABLE } from '../../src/clients/probes.mjs';

const PROJECT = join(tmpdir(), 'pmc-plan-test');

async function touch(p) {
  await writeFile(p, 'seed', 'utf8');
}

test('planInstallation emits immutable plan with one client per detected id and unsupported caps marked skipped', async () => {
  const projectRoot = await mkdtemp(PROJECT);
  try {
    await mkdir(projectRoot, { recursive: true });
    const result = await planInstallation({
      projectRoot,
      registry: CLIENT_REGISTRY,
      probeTable: PROBE_TABLE,
      selectedIds: ['cursor'],
      consent: { dependencies: false },
    });

    assert.ok(result.plan.planId && typeof result.plan.planId === 'string');
    assert.equal(result.plan.consent.dependencies, false);
    assert.equal(result.plan.clients.length, 1);
    const client = result.plan.clients[0];
    assert.equal(client.clientId, 'cursor');
    assert.equal(client.source, 'detected');

    const capsById = Object.fromEntries(client.capabilities.map((c) => [c.capability, c]));
    assert.equal(capsById.mcp.status, 'planned');
    assert.equal(capsById.mcp.ownedKeys.length, 2);
    assert.ok(isAbsolute(capsById.mcp.targetPath));
    assert.equal(capsById.skills.status, 'skipped');
    assert.equal(capsById.skills.reason, 'unsupported');
    assert.equal(capsById.hooks.status, 'skipped');
    assert.equal(capsById.hooks.reason, 'unsupported');

    // Object is frozen
    assert.equal(Object.isFrozen(result.plan), true);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('planInstallation never writes any file (plan-before-write invariant)', async () => {
  const projectRoot = await mkdtemp(PROJECT);
  try {
    await touch(join(projectRoot, 'AGENTS.md')); // pre-existing marker
    const before = await stat(projectRoot).then((s) => s.mtimeMs);

    await planInstallation({
      projectRoot,
      registry: CLIENT_REGISTRY,
      probeTable: PROBE_TABLE,
      selectedIds: ['opencode'],
      consent: { dependencies: false },
    });

    const after = await stat(projectRoot).then((s) => s.mtimeMs);
    assert.equal(before, after, 'planning must not modify the projectRoot directory');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('planInstallation marks version-gated capabilities as skipped via probe', async () => {
  const projectRoot = await mkdtemp(PROJECT);
  try {
    const { plan } = await planInstallation({
      projectRoot,
      registry: [
        {
          id: 'probe-host',
          legacyId: null,
          priority: 1,
          flags: ['--probe-host'],
          markers: { project: [], instructionFiles: [] },
          paths: {
            projectConfig: (root) => join(root, '.probe', 'config.json'),
            globalConfig: (home) => join(home, '.probe'),
          },
          capabilities: {
            hooks: { supported: 'version-gated', probe: 'failingProbe', ownedKeys: ['hooks.pmc'] },
          },
          writers: { hooks: async () => {} },
          verifiers: { hooks: async () => false },
        },
      ],
      probeTable: {
        ...PROBE_TABLE,
        failingProbe: async () => ({ status: 'skipped', reason: 'version-threshold-unverified' }),
      },
      selectedIds: ['probe-host'],
      consent: { dependencies: false },
    });

    const [client] = plan.clients;
    const [hooks] = client.capabilities;
    assert.equal(hooks.capability, 'hooks');
    assert.equal(hooks.status, 'skipped');
    assert.equal(hooks.reason, 'version-threshold-unverified');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('planInstallation fails closed when consent denies a declared dependency', async () => {
  const projectRoot = await mkdtemp(PROJECT);
  try {
    const { plan } = await planInstallation({
      projectRoot,
      registry: [
        {
          id: 'dep-host',
          legacyId: null,
          priority: 1,
          flags: ['--dep-host'],
          markers: { project: [], instructionFiles: [] },
          paths: {
            projectConfig: (root) => join(root, '.dep', 'config.json'),
            globalConfig: (home) => join(home, '.dep'),
          },
          capabilities: {
            mcp: { supported: true, format: 'json', target: 'projectConfig', ownedKeys: ['mcpServers.pmc-query'], requiresDependency: true },
          },
          writers: { mcp: async () => {} },
          verifiers: { mcp: async () => false },
        },
      ],
      probeTable: PROBE_TABLE,
      selectedIds: ['dep-host'],
      consent: { dependencies: false },
    });

    const [client] = plan.clients;
    const [mcp] = client.capabilities;
    assert.equal(mcp.status, 'skipped');
    assert.equal(mcp.reason, 'dependency-consent-denied');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

async function mkdir(p, opts) {
  const { mkdir } = await import('node:fs/promises');
  return mkdir(p, opts);
}
