import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildInjectedPmcConfig } from '../src/plugin-config.mjs';
import { createOpencodeRefreshHookController } from '../src/opencode-refresh-hook.mjs';
import { launchEnrichmentIfNeeded } from '../cli/session-start.mjs';

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
  const launchEnrichment = __testOverrides?.launchEnrichmentIfNeeded ?? launchEnrichmentIfNeeded;

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

      // Zero-token autostart: launch background enrichment + watchdog
      // deterministically (Node `detached+unref`, full PATH) instead of
      // relying on the LLM to `pty_spawn` them — that crashes on Windows
      // because `pmc` resolves to a non-spawnable `pmc.ps1` shim.
      // Errors must never block opencode startup.
      try {
        await launchEnrichment(directory);
      } catch {
        // swallow — never block agent startup on enrichment launch failure
      }
    },

    'tool.execute.after': async (input) => {
      if (!controller) return;
      await controller.onToolExecuteAfter(input);
    },
  };
};
