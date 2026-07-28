import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildInjectedPmcConfig } from '../../plugin-config.mjs';
import { renderTemplate, hasBlockMarker, replaceOrAppendBlock, stripBlockMarkers } from '../../templates/render.mjs';
import { CLIENT_MARKERS } from '../markers.mjs';

const COMMAND_TEMPLATES = [
  'opencode/commands/map-project.md',
  'opencode/commands/get-context.md',
  'opencode/commands/sync-context.md',
  'opencode/commands/sanitize.md',
  'opencode/commands/enrich.md',
  'opencode/commands/enrich-status.md',
  'opencode/commands/pmc-doctor.md',
  'opencode/commands/init-project.md',
  'opencode/commands/retry-errors.md',
  'opencode/commands/view-context.md',
  'opencode/commands/refresh-context.md',
];

async function writeIfMissingOrForced(filePath, content, options = {}) {
  const { force = false } = options;
  if (!force && existsSync(filePath)) return false;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return true;
}

async function readOpencodeInstallState(projectRoot) {
  try {
    return JSON.parse(
      await readFile(join(projectRoot, '.planning', 'project-memory-context', 'install.json'), 'utf8'),
    );
  } catch {
    return {
      projectRoot,
      memoryDbPath: join(projectRoot, '.planning', 'project-memory-context', 'memory-db'),
    };
  }
}

async function writeOpencodeProjectConfig({ projectRoot, installState }) {
  const configPath = join(projectRoot, '.opencode', 'opencode.json');
  let existing = {};
  try {
    existing = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {}

  const injected = buildInjectedPmcConfig({ installState });
  const merged = {
    ...existing,
    $schema: 'https://opencode.ai/config.json',
    mcp: { ...(existing.mcp ?? {}), ...injected.mcp },
  };

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
}

export const opencodeAdapter = Object.freeze({
  id: 'opencode',
  legacyId: 'opencode',
  priority: 10,
  flags: ['--opencode'],
  markers: CLIENT_MARKERS.opencode,
  paths: {
    projectConfig: (root) => join(root, '.opencode', 'opencode.json'),
    globalConfig: (home) => join(home, '.config', 'opencode'),
  },
  capabilities: {
    mcp: {
      supported: true,
      format: 'json',
      target: 'projectConfig',
      ownedKeys: ['mcp.pmc-query', 'mcp.pmc-agent-memory'],
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
      target: 'globalConfig',
    },
    hooks: {
      supported: true,
      format: 'files',
      target: 'projectConfig',
    },
  },
  writers: {
    mcp: async ({ projectRoot }) => {
      const installState = await readOpencodeInstallState(projectRoot);
      await writeOpencodeProjectConfig({ projectRoot, installState });
    },
    instructions: async ({ projectRoot, packageRoot, placeholders, readTemplate }) => {
      const agentsMdPath = join(projectRoot, 'AGENTS.md');
      const autostartBlock = renderTemplate(
        await readTemplate(packageRoot, 'opencode/autostart-snippet.md'),
        placeholders,
      );

      let existing = '';
      if (existsSync(agentsMdPath)) {
        existing = await readFile(agentsMdPath, 'utf8');
        existing = existing.replace(/<!-- pmc-autostart -->[\s\S]*?<!-- \/pmc-autostart -->\n?/g, '');
        existing = existing.replace(/<!-- pmc:autostart -->[\s\S]*?(?:<!-- \/pmc:autostart -->\s*)+/g, '');
      }

      const updated = replaceOrAppendBlock(existing.trim(), 'autostart', stripBlockMarkers(autostartBlock, 'autostart').trim());
      await writeFile(agentsMdPath, updated, 'utf8');
    },
    skills: async ({ globalConfigDir, packageRoot, placeholders, readTemplate }) => {
      if (!globalConfigDir) return;
      for (const tpl of COMMAND_TEMPLATES) {
        const rendered = renderTemplate(await readTemplate(packageRoot, tpl), placeholders);
        const fileName = tpl.split('/').at(-1);
        await writeIfMissingOrForced(join(globalConfigDir, 'commands', fileName), rendered, { force: true });
      }

      const enrichTemplate = renderTemplate(
        await readTemplate(packageRoot, 'opencode/agent/enrich.md'),
        placeholders,
      );
      await writeIfMissingOrForced(join(globalConfigDir, 'agents', 'enrich.md'), enrichTemplate, { force: true });

      const pmcSkill = renderTemplate(
        await readTemplate(packageRoot, 'pmc-skill/SKILL.md'),
        placeholders,
      );
      await writeIfMissingOrForced(join(globalConfigDir, 'skills', 'pmc-skill', 'SKILL.md'), pmcSkill, { force: true });
    },
    hooks: async ({ projectRoot, packageRoot, placeholders, readTemplate }) => {
      const pluginImportUrl = pathToFileURL(join(packageRoot, 'plugin', 'index.mjs')).href;
      const pluginContent = renderTemplate(
        await readTemplate(packageRoot, 'opencode/plugins/pmc.mjs'),
        { ...placeholders, PMC_PLUGIN_IMPORT: pluginImportUrl },
      );
      await writeIfMissingOrForced(join(projectRoot, '.opencode', 'plugins', 'pmc.mjs'), pluginContent, { force: true });
    },
  },
  verifiers: {
    mcp: async ({ projectRoot }) => existsSync(join(projectRoot, '.opencode', 'opencode.json')),
    instructions: async ({ projectRoot }) => existsSync(join(projectRoot, 'AGENTS.md')),
    skills: async ({ globalConfigDir }) => globalConfigDir && existsSync(join(globalConfigDir, 'skills', 'pmc-skill', 'SKILL.md')),
    hooks: async ({ projectRoot }) => existsSync(join(projectRoot, '.opencode', 'plugins', 'pmc.mjs')),
  },
});
