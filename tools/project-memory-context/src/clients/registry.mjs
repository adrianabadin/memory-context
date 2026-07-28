import { PROBE_TABLE } from './probes.mjs';
import { validateAdapterContract } from './adapter-contract.mjs';

export const CLIENT_REGISTRY = Object.freeze([]);

export function validateRegistry(registry = CLIENT_REGISTRY, probeTable = PROBE_TABLE, contextRoots = null) {
  const ids = new Set();
  const legacyIds = new Set();
  const priorities = new Set();
  const flags = new Set();

  for (const adapter of registry) {
    const hasPathFunctions = Boolean(adapter && adapter.paths && (adapter.paths.projectConfig || adapter.paths.globalConfig));
    const isRootsComplete = Boolean(contextRoots && typeof contextRoots === 'object' && contextRoots.projectRoot && contextRoots.homeDir);

    if (hasPathFunctions && !isRootsComplete) {
      throw new Error(`validateRegistry requires complete contextRoots ({ projectRoot, homeDir }) when validating non-empty registry containing path-defining adapter ${adapter?.id}`);
    }

    validateAdapterContract(adapter, probeTable, contextRoots);

    if (ids.has(adapter.id)) {
      throw new Error(`Duplicate adapter id: ${adapter.id}`);
    }
    ids.add(adapter.id);

    if (adapter.legacyId !== null) {
      if (legacyIds.has(adapter.legacyId)) {
        throw new Error(`Duplicate legacyId: ${adapter.legacyId}`);
      }
      legacyIds.add(adapter.legacyId);
    }

    if (priorities.has(adapter.priority)) {
      throw new Error(`Duplicate priority: ${adapter.priority}`);
    }
    priorities.add(adapter.priority);

    for (const flag of adapter.flags) {
      if (flags.has(flag)) {
        throw new Error(`Duplicate flag: ${flag}`);
      }
      flags.add(flag);
    }
  }

  return true;
}

export function getAdapter(idOrLegacyId, registry = CLIENT_REGISTRY) {
  return registry.find((a) => a.id === idOrLegacyId || a.legacyId === idOrLegacyId) ?? null;
}
