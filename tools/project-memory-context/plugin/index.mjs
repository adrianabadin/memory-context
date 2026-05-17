import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildInjectedPmcConfig } from '../src/plugin-config.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function readInstallState(projectRoot) {
  const file = join(projectRoot, '.planning', 'project-memory-context', 'install.json');
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export default async ({ directory }) => {
  return {
    config: async (cfg) => {
      const installState = await readInstallState(directory);
      if (!installState) return;

      const injected = buildInjectedPmcConfig({ packageRoot, installState });
      cfg.mcp = {
        ...(cfg.mcp ?? {}),
        ...injected.mcp,
      };
    },
  };
};
