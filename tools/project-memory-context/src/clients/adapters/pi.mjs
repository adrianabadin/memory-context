import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildInjectedPmcConfig } from '../../plugin-config.mjs';
import { mergeJsonConfig } from '../../config-merge/json.mjs';
import { CLIENT_MARKERS } from '../markers.mjs';

// Pi 1.3 NATIVE MCP (S22, user-authorized source/fixture update of the earlier
// bridge-era adapter). Pi reads project MCP servers natively from
// `.pi/mcp.json` — the standard `{ mcpServers: { <name>: { command, args,
// env, cwd?, exposure?, timeout? } } }` stdio schema — after project trust is
// granted for the folder. PMC writes BOTH `pmc-query` and `pmc-agent-memory`
// into that file via the injected-config stdio projection with a lossless
// merge (foreign keys/servers preserved, malformed existing JSON never
// overwritten, byte-identical idempotence).
//
// SUPERSEDED bridge-era behavior (kept verbatim in the ledger history): the
// old adapter registered `npm:pi-mcp-adapter` / the PMC npm package in
// `.pi/settings.json` and wrote the shared `.mcp.json` that the external
// pi-mcp-adapter bridge consumed. Pi 1.3 no longer needs either: no npm
// package entries are added, `.pi/settings.json` is never read or written,
// and there is no Pi-only shared `.mcp.json` writer anymore (claude-code and
// cursor keep their shared `.mcp.json` behavior unchanged).
//
// External-bridge conflict: an installed `pi-mcp-adapter` extension registers
// `/mcp` and REPLACES Pi's builtin MCP support, so `.pi/mcp.json` is not read
// in sessions while it is installed. Removing/migrating that bridge is a
// separate manual user decision — this adapter never auto-removes packages or
// host configuration.

async function readPiInstallState(projectRoot) {
  // Mirrors opencode/codex/kimi pattern — keep install.json-based state in
  // `.planning/project-memory-context`.
  try {
    const raw = await readFile(
      join(projectRoot, '.planning', 'project-memory-context', 'install.json'),
      'utf8',
    );
    return JSON.parse(raw);
  } catch {
    return {
      projectRoot,
      memoryDbPath: join(projectRoot, '.planning', 'project-memory-context', 'memory-db'),
    };
  }
}

// `buildInjectedPmcConfig` emits the OpenCode-style envelope
// `{ type, command: string[], enabled, environment }`; Pi 1.3's native
// `.pi/mcp.json` wants the standard MCP stdio shape
// `{ command: string, args: string[], env: object }` (the same conversion
// Pi's own docs prescribe for OpenCode entries). The projection is local to
// this adapter — other adapters keep the OpenCode envelope.
function toStdioServer(entry) {
  const [command, ...args] = entry.command ?? [];
  return {
    command,
    args,
    ...(entry.environment ? { env: entry.environment } : {}),
  };
}

async function writePiMcpJson({ projectRoot, installState }) {
  const injected = buildInjectedPmcConfig({ installState }).mcp;
  const servers = Object.fromEntries(
    Object.entries(injected).map(([name, entry]) => [name, toStdioServer(entry)]),
  );
  // Lossless merge into the NATIVE `.pi/mcp.json` — user-owned top-level
  // keys, foreign servers and nested per-server keys survive; a malformed
  // existing file is reported as `{ malformed: true }` and never overwritten.
  return mergeJsonConfig(join(projectRoot, '.pi', 'mcp.json'), { mcpServers: servers });
}

export const piAdapter = Object.freeze({
  id: 'pi',
  legacyId: null,
  priority: 80,
  flags: ['--pi'],
  markers: CLIENT_MARKERS.pi,
  paths: {
    // Pi 1.3 native project MCP config.
    projectConfig: (root) => join(root, '.pi', 'mcp.json'),
    // INERT compatibility alias: `plan.mjs` special-cases this literal key to
    // populate `targetPath` for literal-target capabilities, and the previous
    // bridge-era `instructions` capability targeted `.pi/settings.json`. No
    // capability references it anymore (the settings/packages writer is
    // removed); it is retained as documented dead code so the shared planner
    // needs no churn.
    '.pi/settings.json': (root) => join(root, '.pi', 'settings.json'),
  },
  capabilities: {
    mcp: {
      // Only capability: the native `.pi/mcp.json` in the standard
      // `mcpServers` envelope. No instructions/skills/hooks: PMC no longer
      // edits `.pi/settings.json`, adds npm packages, or writes a shared
      // `.mcp.json` for Pi.
      supported: true,
      format: 'json',
      target: 'projectConfig',
      ownedKeys: ['mcpServers.pmc-query', 'mcpServers.pmc-agent-memory'],
    },
  },
  writers: {
    mcp: async ({ projectRoot }) => {
      const installState = await readPiInstallState(projectRoot);
      return writePiMcpJson({ projectRoot, installState });
    },
  },
  verifiers: {
    mcp: async ({ projectRoot }) => {
      // Reads the NATIVE config only — the shared `.mcp.json` and
      // `.pi/settings.json` are never Pi verification surfaces.
      const targetPath = join(projectRoot, '.pi', 'mcp.json');
      if (!existsSync(targetPath)) return false;
      try {
        const parsed = JSON.parse(await readFile(targetPath, 'utf8'));
        const servers = parsed?.mcpServers ?? {};
        return Object.hasOwn(servers, 'pmc-query')
          && Object.hasOwn(servers, 'pmc-agent-memory');
      } catch {
        return false;
      }
    },
  },
});
