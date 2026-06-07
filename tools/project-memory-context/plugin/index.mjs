import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildInjectedPmcConfig } from '../src/plugin-config.mjs';
import { createOpencodeRefreshHookController } from '../src/opencode-refresh-hook.mjs';
import { runSessionStartRuntime } from '../src/session-start-runtime.mjs';

async function readInstallState(projectRoot) {
  try {
    return JSON.parse(await readFile(join(projectRoot, '.planning', 'project-memory-context', 'install.json'), 'utf8'));
  } catch {
    return null;
  }
}

export default async ({ directory, __testOverrides } = {}) => {
  const readState = __testOverrides?.readInstallState ?? readInstallState;
  const createController = __testOverrides?.createController ??
    ((projectRoot) => createOpencodeRefreshHookController({ projectRoot }));
  const runStartup = __testOverrides?.runSessionStartRuntime ?? runSessionStartRuntime;

  let controller = null;

  return {
    config: async (cfg) => {
      const installState = await readState(directory);
      if (!installState) return;

      const injected = buildInjectedPmcConfig({ installState });
      cfg.mcp = {
        ...(cfg.mcp ?? {}),
        ...injected.mcp,
      };

      controller = createController(directory, installState);
      await controller.rehydrate();

      try {
        await runStartup(directory, { mode: 'opencode-plugin' });
      } catch {
        // Silent by design: PMC startup must never block OpenCode startup.
      }
    },

    'tool.execute.after': async (input) => {
      if (!controller) return;
      await controller.onToolExecuteAfter(input);
    },
  };
};
