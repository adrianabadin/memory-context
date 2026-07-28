import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { buildInjectedPmcConfig } from '../../plugin-config.mjs';
import {
  replaceOrAppendBlock,
  stripBlockMarkers,
} from '../../templates/render.mjs';
import { mergeTomlConfig, mergeTomlBlock } from '../../config-merge/toml.mjs';
import { CLIENT_MARKERS } from '../markers.mjs';

async function writeIfMissingOrForced(filePath, content, options = {}) {
  const { force = false } = options;
  if (!force && existsSync(filePath)) return false;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return true;
}

async function readCodexInstallState(projectRoot) {
  // Mirrors opencode pattern — keep install.json-based state in `.planning/project-memory-context`.
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

function codexMcpSection(installState) {
  // `mcp_servers` is Codex's TOML-friendly alias for the OpenCode/Claude `mcp` / `mcpServers` keys.
  return buildInjectedPmcConfig({ installState }).mcp;
}

async function writeCodexMcpConfig({ projectRoot, installState }) {
  const targetPath = join(projectRoot, '.codex', 'config.toml');
  const section = codexMcpSection(installState);
  return mergeTomlConfig(
    targetPath,
    { mcp_servers: section },
    'mcp',
  );
}

async function writeCodexGlobalHooks({ homeDir }) {
  if (!homeDir) return { status: 'skipped' };
  // Per design: Codex hooks live alongside MCP in the GLOBAL `~/.codex/config.toml`,
  // gated by `probes.codexVersion`. Today the probe returns the safe
  // `version-threshold-unverified` default so this writer is never invoked from
  // the pipeline. The block stays lossless on second run.
  const targetPath = join(homeDir, '.codex', 'config.toml');
  const block = [
    '[hooks]',
    '# pmc-managed hooks (gated by Codex version probe).',
    '# Replace this section on hook schema updates; PMC will splice the next run.',
    '',
  ].join('\n');
  return mergeTomlBlock(targetPath, block, 'hooks');
}

const SKILL_TEMPLATES = [
  'pmc-skill/SKILL.md',
];

export const codexAdapter = Object.freeze({
  id: 'codex',
  legacyId: null,
  priority: 60,
  flags: ['--codex'],
  markers: CLIENT_MARKERS.codex,
  paths: {
    projectConfig: (root) => join(root, '.codex', 'config.toml'),
    globalConfig: (home) => join(home, '.codex', 'config.toml'),
    skillsDir: (root) => join(root, '.agents', 'skills'),
    // Literal-target alias consumed by `plan.mjs` to populate `targetPath`
    // for the `instructions` capability. Adding it keeps the planner output
    // complete and matches the existing pattern used by opencode / claude-code.
    'AGENTS.md': (root) => join(root, 'AGENTS.md'),
  },
  capabilities: {
    mcp: {
      supported: true,
      format: 'toml',
      target: 'projectConfig',
      ownedKeys: ['mcp_servers.pmc-query', 'mcp_servers.pmc-agent-memory'],
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
    hooks: {
      supported: 'version-gated',
      probe: 'codexVersion',
    },
  },
  writers: {
    mcp: async ({ projectRoot }) => {
      const installState = await readCodexInstallState(projectRoot);
      return writeCodexMcpConfig({ projectRoot, installState });
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
    hooks: async ({ homeDir }) => writeCodexGlobalHooks({ homeDir }),
  },
  verifiers: {
    mcp: async ({ projectRoot }) => existsSync(join(projectRoot, '.codex', 'config.toml'))
      && /\[mcp_servers\.pmc-query\]/.test(
        await readFile(join(projectRoot, '.codex', 'config.toml'), 'utf8').catch(() => ''),
      ),
    instructions: async ({ projectRoot }) => existsSync(join(projectRoot, 'AGENTS.md')),
    skills: async ({ projectRoot }) => existsSync(
      join(projectRoot, '.agents', 'skills', 'pmc-skill', 'SKILL.md'),
    ),
    hooks: async ({ homeDir }) => Boolean(homeDir)
      && existsSync(join(homeDir, '.codex', 'config.toml'))
      && /\[hooks\]/.test(
        await readFile(join(homeDir, '.codex', 'config.toml'), 'utf8').catch(() => ''),
      ),
  },
});
