import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { buildInjectedPmcConfig } from '../../plugin-config.mjs';
import { mergeJsonConfig } from '../../config-merge/json.mjs';
import { writeAtomic } from '../../config-merge/atomic-write.mjs';
import { CLIENT_MARKERS } from '../markers.mjs';

// The two npm package NAMES Pi must register in `.pi/settings.json`.
// `pi-mcp-adapter` consumes the shared project `.mcp.json` at runtime, so Pi
// never gets its own MCP server block — it reuses the same `.mcp.json` that
// claude-code/cursor rely on (see the `mcp` capability below).
const PI_REQUIRED_PACKAGES = Object.freeze([
  'npm:@aabadin/project-memory-context',
  'npm:pi-mcp-adapter',
]);

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

// The shared `.mcp.json` is consumed by standard MCP clients (claude-code,
// cursor, Pi via pi-mcp-adapter), so project each PMC server entry from the
// OpenCode-style envelope into the standard MCP stdio shape. Same projection
// kimi.mjs uses for its standalone `mcp.json`.
function toStdioServer(entry) {
  const [command, ...args] = entry.command ?? [];
  return {
    command,
    args,
    ...(entry.environment ? { env: entry.environment } : {}),
  };
}

async function writeSharedMcpJson({ projectRoot, installState }) {
  const injected = buildInjectedPmcConfig({ installState }).mcp;
  const servers = Object.fromEntries(
    Object.entries(injected).map(([name, entry]) => [name, toStdioServer(entry)]),
  );
  // Lossless merge into the SHARED `.mcp.json` — the same file the
  // claude-code/cursor adapters target via `paths.projectConfig`. Foreign
  // (user-owned) top-level keys and servers survive.
  return mergeJsonConfig(join(projectRoot, '.mcp.json'), { mcpServers: servers });
}

// Faithful port of the author's `ensurePiConfig`: register the required npm
// package names in `.pi/settings.json`'s `packages` array — first occurrence
// of a required entry wins (dedup), later duplicates are dropped, foreign
// packages and every other key in the file are preserved verbatim.
async function ensurePiSettings({ projectRoot }) {
  const configPath = join(projectRoot, '.pi', 'settings.json');

  let config = {};
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    config = {};
  }

  const seen = new Set();
  const packages = (Array.isArray(config.packages) ? config.packages : [])
    .filter((entry) => {
      if (!PI_REQUIRED_PACKAGES.includes(entry)) return true;
      if (seen.has(entry)) return false;
      seen.add(entry);
      return true;
    });
  for (const entry of PI_REQUIRED_PACKAGES) {
    if (!seen.has(entry)) packages.push(entry);
  }

  const newContent = `${JSON.stringify({ ...config, packages }, null, 2)}\n`;

  let existingContent = null;
  try {
    existingContent = await readFile(configPath, 'utf8');
  } catch {}
  if (existingContent === newContent) {
    return { status: 'unchanged' };
  }

  await mkdir(dirname(configPath), { recursive: true });
  await writeAtomic(configPath, newContent);
  return { status: 'installed' };
}

export const piAdapter = Object.freeze({
  id: 'pi',
  legacyId: null,
  priority: 80,
  flags: ['--pi'],
  markers: CLIENT_MARKERS.pi,
  paths: {
    // Same shared `.mcp.json` claude-code/cursor target via projectConfig.
    projectConfig: (root) => join(root, '.mcp.json'),
    // Literal-target alias consumed by `plan.mjs` to populate `targetPath`
    // for the `instructions` capability. Adding it keeps the planner output
    // complete and matches the pattern used by kimi / codex.
    '.pi/settings.json': (root) => join(root, '.pi', 'settings.json'),
  },
  capabilities: {
    mcp: {
      // Identical declaration to claude-code/cursor: the shared project
      // `.mcp.json` in the standard `mcpServers` envelope.
      supported: true,
      format: 'json',
      target: 'projectConfig',
      ownedKeys: ['mcpServers.pmc-query', 'mcpServers.pmc-agent-memory'],
    },
    instructions: {
      // Pi has no AGENTS.md-style instruction file; its primary per-project
      // integration file IS `.pi/settings.json` (a JSON settings file). The
      // `instructions` slot is where kimi/codex/opencode carry their host's
      // primary integration file, and the contract accepts `format: 'json'`.
      // No templates to install — the file only registers npm package names.
      supported: true,
      format: 'json',
      target: '.pi/settings.json',
    },
    // No skills / hooks: Pi's design registers package names only — no
    // template files, no established PMC-known Pi hooks schema.
  },
  writers: {
    mcp: async ({ projectRoot }) => {
      const installState = await readPiInstallState(projectRoot);
      return writeSharedMcpJson({ projectRoot, installState });
    },
    instructions: async ({ projectRoot }) => ensurePiSettings({ projectRoot }),
  },
  verifiers: {
    mcp: async ({ projectRoot }) => {
      const targetPath = join(projectRoot, '.mcp.json');
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
    instructions: async ({ projectRoot }) => {
      const targetPath = join(projectRoot, '.pi', 'settings.json');
      if (!existsSync(targetPath)) return false;
      try {
        const parsed = JSON.parse(await readFile(targetPath, 'utf8'));
        const packages = Array.isArray(parsed.packages) ? parsed.packages : [];
        return PI_REQUIRED_PACKAGES.every((entry) => packages.includes(entry));
      } catch {
        return false;
      }
    },
  },
});
