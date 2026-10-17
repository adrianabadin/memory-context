import { isAbsolute, relative, resolve } from 'node:path';

export function isPathInside(parentDir, targetPath) {
  const resolvedParent = resolve(parentDir);
  const resolvedTarget = resolve(targetPath);
  const rel = relative(resolvedParent, resolvedTarget);
  return Boolean(rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function isValidPmcOwnedKey(key) {
  if (typeof key !== 'string') return false;
  const segments = key.split('.');
  return segments.some((segment) => segment === 'pmc' || segment.startsWith('pmc-'));
}

export function validateAdapterContract(adapter, probeTable = {}, contextRoots = null) {
  if (!adapter || typeof adapter !== 'object') {
    throw new Error('Adapter must be an object');
  }

  const { id, legacyId, priority, flags, markers, paths, capabilities, writers, verifiers } = adapter;

  if (!id || typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) {
    throw new Error(`Invalid adapter id: ${id} (must be unique kebab-case)`);
  }

  if (legacyId !== null && typeof legacyId !== 'string') {
    throw new Error(`Invalid legacyId for ${id}: must be string or null`);
  }

  if (!Number.isInteger(priority)) {
    throw new Error(`Invalid priority for ${id}: must be integer`);
  }

  if (!Array.isArray(flags) || flags.some((f) => typeof f !== 'string' || !f.startsWith('--'))) {
    throw new Error(`Invalid flags for ${id}: must be array of string flags`);
  }

  if (!markers || typeof markers !== 'object') {
    throw new Error(`Invalid markers for ${id}`);
  }

  if (!paths || typeof paths !== 'object') {
    throw new Error(`Invalid paths for ${id}`);
  }

  if (!capabilities || typeof capabilities !== 'object') {
    throw new Error(`Invalid capabilities for ${id}`);
  }

  if (!writers || typeof writers !== 'object') {
    throw new Error(`Invalid writers for ${id}`);
  }

  if (!verifiers || typeof verifiers !== 'object') {
    throw new Error(`Invalid verifiers for ${id}`);
  }

  for (const [capName, capDef] of Object.entries(capabilities)) {
    if (capDef.supported !== false) {
      if (typeof writers[capName] !== 'function') {
        throw new Error(`Adapter ${id} capability ${capName} is supported but lacks a writer function`);
      }
      if (typeof verifiers[capName] !== 'function') {
        throw new Error(`Adapter ${id} capability ${capName} is supported but lacks a verifier function`);
      }

      if (capDef.format && !['json', 'toml', 'markdown', 'files'].includes(capDef.format)) {
        throw new Error(`Adapter ${id} capability ${capName} format ${capDef.format} is invalid`);
      }

      if (capDef.ownedKeys !== undefined) {
        if (
          !Array.isArray(capDef.ownedKeys) ||
          capDef.ownedKeys.length === 0 ||
          !capDef.ownedKeys.every(isValidPmcOwnedKey)
        ) {
          throw new Error(`Adapter ${id} capability ${capName} ownedKeys non-empty and PMC-namespaced required when defined`);
        }
      }

      if (capDef.supported === 'version-gated') {
        if (!capDef.probe || typeof capDef.probe !== 'string') {
          throw new Error(`Adapter ${id} capability ${capName} is version-gated but missing probe name`);
        }
        if (probeTable && !(capDef.probe in probeTable)) {
          throw new Error(`Adapter ${id} capability ${capName} probe ${capDef.probe} not in probe table`);
        }
      }
    }
  }

  if (contextRoots !== null && typeof contextRoots === 'object') {
    const projectRoot = contextRoots.projectRoot;
    const homeDir = contextRoots.homeDir;

    if (paths.projectConfig) {
      if (!projectRoot) {
        throw new Error(`Adapter ${id} path validation failed: projectRoot context required when validating paths`);
      }
      const pPath = paths.projectConfig(projectRoot);
      if (!isPathInside(projectRoot, pPath)) {
        throw new Error(`Adapter ${id} projectConfig path traversal: ${pPath} is outside ${projectRoot}`);
      }
    }

    if (paths.globalConfig) {
      if (!homeDir) {
        throw new Error(`Adapter ${id} path validation failed: homeDir context required when validating paths`);
      }
      const gPath = paths.globalConfig(homeDir);
      if (!isPathInside(homeDir, gPath)) {
        throw new Error(`Adapter ${id} globalConfig path traversal: ${gPath} is outside ${homeDir}`);
      }
    }
  }

  return true;
}
