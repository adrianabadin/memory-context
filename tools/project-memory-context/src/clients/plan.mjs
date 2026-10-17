import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { getAdapter } from './registry.mjs';

const UNSUPPORTED_CAPS = new Set(['mcp', 'instructions', 'skills', 'hooks']);

async function resolveCapability({
  capabilityName,
  capabilitySpec,
  adapter,
  contextRoots,
  probeTable,
  consent,
}) {
  if (capabilitySpec.supported === false) {
    return {
      capability: capabilityName,
      status: 'skipped',
      reason: 'unsupported',
      format: undefined,
      targetPath: undefined,
      ownedKeys: undefined,
    };
  }

  if (capabilitySpec.requiresDependency === true && consent?.dependencies !== true) {
    return {
      capability: capabilityName,
      status: 'skipped',
      reason: 'dependency-consent-denied',
      format: capabilitySpec.format,
      targetPath: undefined,
      ownedKeys: capabilitySpec.ownedKeys ? [...capabilitySpec.ownedKeys] : undefined,
    };
  }

  let targetPath = undefined;
  if (capabilitySpec.target) {
    const target = adapter.paths?.[capabilitySpec.target];
    if (typeof target === 'function') {
      if (capabilitySpec.target === 'projectConfig') {
        targetPath = target(contextRoots.projectRoot);
      } else if (capabilitySpec.target === 'globalConfig') {
        targetPath = target(contextRoots.homeDir);
      } else if (capabilitySpec.target === 'AGENTS.md' || capabilitySpec.target === 'CLAUDE.md' || capabilitySpec.target === '.cursorrules' || capabilitySpec.target === 'README-SETUP.md') {
        targetPath = join(contextRoots.projectRoot, capabilitySpec.target);
      } else if (capabilitySpec.target === 'skillsDir') {
        targetPath = target(contextRoots.projectRoot);
      }
    }
  }

  if (capabilitySpec.supported === 'version-gated') {
    const probeName = capabilitySpec.probe;
    const probeFn = probeTable?.[probeName];
    if (typeof probeFn !== 'function') {
      return {
        capability: capabilityName,
        status: 'skipped',
        reason: 'missing-probe',
        format: capabilitySpec.format,
        targetPath,
        ownedKeys: capabilitySpec.ownedKeys ? [...capabilitySpec.ownedKeys] : undefined,
      };
    }
    const probeResult = await probeFn();
    if (probeResult?.status !== 'available') {
      return {
        capability: capabilityName,
        status: 'skipped',
        reason: probeResult?.reason ?? 'version-threshold-unverified',
        format: capabilitySpec.format,
        targetPath,
        ownedKeys: capabilitySpec.ownedKeys ? [...capabilitySpec.ownedKeys] : undefined,
      };
    }
  }

  return {
    capability: capabilityName,
    status: 'planned',
    reason: undefined,
    format: capabilitySpec.format,
    targetPath,
    ownedKeys: capabilitySpec.ownedKeys ? [...capabilitySpec.ownedKeys] : undefined,
  };
}

export async function planInstallation({
  projectRoot,
  homeDir,
  selectedIds,
  registry,
  probeTable,
  consent = { dependencies: false },
  exists,
  source = 'detected',
  clientSources,
} = {}) {
  if (!Array.isArray(selectedIds) || selectedIds.length === 0) {
    selectedIds = ['generic'];
  }

  const probe = exists ?? existsSync;
  const contextRoots = {
    projectRoot,
    homeDir: homeDir ?? projectRoot,
  };

  const clients = [];
  for (let index = 0; index < selectedIds.length; index++) {
    const clientId = selectedIds[index];
    const adapter = getAdapter(clientId, registry);
    if (!adapter) {
      clients.push({
        clientId,
        priority: Number.POSITIVE_INFINITY,
        source: source === 'flag' ? 'flag' : 'detected',
        capabilities: [],
        error: `Unknown client id: ${clientId}`,
      });
      continue;
    }

    const capabilities = [];
    const capabilityEntries = Object.entries(adapter.capabilities ?? {});
    for (const [name, spec] of capabilityEntries) {
      if (!UNSUPPORTED_CAPS.has(name)) continue;
      capabilities.push(
        await resolveCapability({
          capabilityName: name,
          capabilitySpec: spec,
          adapter,
          contextRoots,
          probeTable,
          consent,
        }),
      );
    }

    clients.push({
      clientId,
      priority: adapter.priority ?? Number.POSITIVE_INFINITY,
      source: clientSources?.[clientId] ?? source,
      capabilities,
    });
  }

  const plan = Object.freeze({
    planId: randomUUID(),
    projectRoot,
    homeDir: contextRoots.homeDir,
    platform: process.platform,
    consent: { dependencies: consent.dependencies === true },
    clients: Object.freeze(clients.map((c) => Object.freeze({
      ...c,
      capabilities: Object.freeze(c.capabilities.map((cap) => Object.freeze(cap))),
    }))),
    companions: Object.freeze([]),
  });

  return { plan };
}
