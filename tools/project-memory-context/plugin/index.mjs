import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildInjectedPmcConfig } from '../src/plugin-config.mjs';

async function readInstallState(projectRoot) {
  try {
    return JSON.parse(await readFile(join(projectRoot, '.planning', 'project-memory-context', 'install.json'), 'utf8'));
  } catch {
    return null;
  }
}

export default async ({ directory }) => {
  return {
    config: async (cfg) => {
      const installState = await readInstallState(directory);
      if (!installState) return;

      const injected = buildInjectedPmcConfig({ installState });
      cfg.mcp = {
        ...(cfg.mcp ?? {}),
        ...injected.mcp,
      };
    },
  };
};
