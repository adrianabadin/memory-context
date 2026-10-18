import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { buildInjectedPmcConfig } from '../../plugin-config.mjs';
import {
  replaceOrAppendBlock,
  stripBlockMarkers,
} from '../../templates/render.mjs';
import { mergeJsonConfig } from '../../config-merge/json.mjs';
import { CLIENT_MARKERS } from '../markers.mjs';

async function writeIfMissingOrForced(filePath, content, options = {}) {
  const { force = false } = options;
  if (!force && existsSync(filePath)) return false;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return true;
}

async function readKimiInstallState(projectRoot) {
  // Mirrors codex/opencode pattern — keep install.json-based state in
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

// Kimi Code reads `.kimi-code/mcp.json` in the STANDARD MCP stdio schema:
// `{ command: string, args: string[], env: object, cwd?: string }`.
// `buildInjectedPmcConfig` emits the OpenCode-style envelope
// `{ type, command: string[], enabled, environment }`, so project each
// PMC server entry into the standard shape before writing. The projection
// is local to this adapter — other adapters keep the OpenCode envelope.
function toKimiStdioServer(entry) {
  const [command, ...args] = entry.command ?? [];
  return {
    command,
    args,
    ...(entry.environment ? { env: entry.environment } : {}),
  };
}

async function writeKimiMcpConfig({ projectRoot, installState }) {
  // Kimi's `mcp.json` is a STANDALONE file whose top level is a bare
  // serverName -> serverConfig map — NO `mcpServers` / `mcp` wrapper.
  // The shared JSON merge helper losslessly preserves user-owned keys.
  const targetPath = join(projectRoot, '.kimi-code', 'mcp.json');
  const injected = buildInjectedPmcConfig({ installState }).mcp;
  const servers = Object.fromEntries(
    Object.entries(injected).map(([name, entry]) => [name, toKimiStdioServer(entry)]),
  );
  return mergeJsonConfig(targetPath, servers);
}

const SKILL_TEMPLATES = [
  'pmc-skill/SKILL.md',
];

export const kimiAdapter = Object.freeze({
  id: 'kimi',
  legacyId: null,
  priority: 70,
  flags: ['--kimi'],
  markers: CLIENT_MARKERS.kimi,
  paths: {
    projectConfig: (root) => join(root, '.kimi-code', 'mcp.json'),
    globalConfig: (home) => join(home, '.kimi-code'),
    skillsDir: (root) => join(root, '.agents', 'skills'),
    // Literal-target alias consumed by `plan.mjs` to populate `targetPath`
    // for the `instructions` capability. Adding it keeps the planner output
    // complete and matches the existing pattern used by opencode / codex.
    'AGENTS.md': (root) => join(root, 'AGENTS.md'),
  },
  capabilities: {
    mcp: {
      supported: true,
      format: 'json',
      target: 'projectConfig',
      ownedKeys: ['pmc-query', 'pmc-agent-memory'],
    },
    instructions: {
      supported: true,
      format: 'markdown',
      target: 'AGENTS.md',
      marker: 'autostart',
    },
    skills: {
      supported: true,
      format: 'files',
      target: 'skillsDir',
    },
    // No hooks capability: unlike codex, there is no established PMC-known
    // kimi hooks schema to splice losslessly (kimi's `.kimi-code/local.toml`
    // is user-owned and never touched by PMC). `PROBE_TABLE.kimiVersion`
    // stays available for a future version-gated hooks/mcp capability.
  },
  writers: {
    mcp: async ({ projectRoot }) => {
      const installState = await readKimiInstallState(projectRoot);
      return writeKimiMcpConfig({ projectRoot, installState });
    },
    instructions: async ({ projectRoot, packageRoot, placeholders, readTemplate }) => {
      const agentsMdPath = join(projectRoot, 'AGENTS.md');
      const autostartBlock = stripBlockMarkers(
        await readTemplate(packageRoot, 'opencode/autostart-snippet.md'),
        'autostart',
      );

      let existing = '';
      if (existsSync(agentsMdPath)) {
        existing = await readFile(agentsMdPath, 'utf8');
        existing = existing.replace(/<!-- pmc:autostart -->[\s\S]*?<!-- \/pmc:autostart -->\n?/g, '');
      }

      const updated = replaceOrAppendBlock(
        existing.trim(),
        'autostart',
        autostartBlock.trim(),
      );
      await writeFile(agentsMdPath, updated, 'utf8');
    },
    skills: async ({ projectRoot, packageRoot, placeholders, readTemplate }) => {
      const skillsDir = join(projectRoot, '.agents', 'skills');
      for (const tpl of SKILL_TEMPLATES) {
        const rendered = await readTemplate(packageRoot, tpl, placeholders);
        const skillName = tpl.split('/')[0];
        await writeIfMissingOrForced(join(skillsDir, skillName, 'SKILL.md'), rendered, { force: true });
      }
    },
  },
  verifiers: {
    mcp: async ({ projectRoot }) => {
      const targetPath = join(projectRoot, '.kimi-code', 'mcp.json');
      if (!existsSync(targetPath)) return false;
      try {
        const parsed = JSON.parse(await readFile(targetPath, 'utf8'));
        return Object.hasOwn(parsed, 'pmc-query');
      } catch {
        return false;
      }
    },
    instructions: async ({ projectRoot }) => existsSync(join(projectRoot, 'AGENTS.md')),
    skills: async ({ projectRoot }) => existsSync(
      join(projectRoot, '.agents', 'skills', 'pmc-skill', 'SKILL.md'),
    ),
  },
});
