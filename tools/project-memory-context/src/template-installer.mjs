import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAdapter } from './clients/registry.mjs';
import {
  renderTemplate,
  hasBlockMarker,
  replaceOrAppendBlock,
  stripBlockMarkers,
  wrapBlock,
} from './templates/render.mjs';

export { detectAgentType } from './platform.mjs';
export {
  renderTemplate,
  hasBlockMarker,
  replaceOrAppendBlock,
  stripBlockMarkers,
  wrapBlock,
};

function resolvePackageRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

async function loadBinNames(packageRoot) {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  return {
    PMC_BIN: Object.keys(packageJson.bin ?? {})[0] ?? 'pmc',
    AGENT_MEMORY_CMD: 'npx -y @aabadin/agent-memory-mcp',
  };
}

async function buildPlaceholders(projectRoot, packageRoot) {
  const binNames = await loadBinNames(packageRoot);
  return {
    ...binNames,
    PROJECT_ROOT: projectRoot,
    CONFIG_DIR: '.pmc',
  };
}

async function readTemplate(packageRoot, templatePath) {
  return readFile(join(packageRoot, 'templates', templatePath), 'utf8');
}

export async function installAgentTemplates({
  projectRoot,
  agent,
  packageRoot,
  globalConfigDir,
}) {
  const adapter = getAdapter(agent);
  if (!adapter) {
    throw new Error(`Unsupported agent type: ${agent}. Supported: opencode, claude-code, cursor, generic, antigravity`);
  }

  if (agent === 'opencode' && !globalConfigDir) {
    throw new Error('globalConfigDir is required for agent: opencode');
  }

  const pkgRoot = packageRoot ?? resolvePackageRoot();
  const placeholders = await buildPlaceholders(projectRoot, pkgRoot);

  const context = {
    projectRoot,
    globalConfigDir,
    packageRoot: pkgRoot,
    placeholders,
    readTemplate,
  };

  for (const [capName, writer] of Object.entries(adapter.writers)) {
    if (typeof writer === 'function') {
      await writer(context);
    }
  }
}
