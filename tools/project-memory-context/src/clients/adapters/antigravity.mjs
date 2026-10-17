import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renderTemplate, replaceOrAppendBlock, stripBlockMarkers } from '../../templates/render.mjs';
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

export const antigravityAdapter = Object.freeze({
  id: 'antigravity',
  legacyId: 'antigravity',
  priority: 40,
  flags: ['--antigravity'],
  markers: CLIENT_MARKERS.antigravity,
  paths: {
    projectConfig: (root) => join(root, '.agents', 'skills'),
    globalConfig: (home) => join(home, '.gemini', 'config'),
  },
  capabilities: {
    mcp: {
      supported: true,
      format: 'json',
      target: 'globalConfig',
      ownedKeys: ['mcpServers.pmc-query', 'mcpServers.pmc-agent-memory'],
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
      target: 'projectConfig',
    },
    hooks: {
      supported: false,
    },
  },
  writers: {
    mcp: async () => {},
    instructions: async ({ projectRoot, packageRoot, placeholders, readTemplate }) => {
      const agentsMdPath = join(projectRoot, 'AGENTS.md');
      const autostartBlock = renderTemplate(
        await readTemplate(packageRoot, 'antigravity/autostart-snippet.md'),
        placeholders,
      );

      let existing = '';
      if (existsSync(agentsMdPath)) {
        existing = await readFile(agentsMdPath, 'utf8');
        existing = existing.replace(/<!-- pmc:autostart -->[\s\S]*?(?:<!-- \/pmc:autostart -->\s*)+/g, '');
      }

      const updated = replaceOrAppendBlock(existing.trim(), 'autostart', stripBlockMarkers(autostartBlock, 'autostart').trim());
      await writeFile(agentsMdPath, updated, 'utf8');
    },
    skills: async ({ projectRoot, globalConfigDir, packageRoot, placeholders, readTemplate }) => {
      const skillsDir = join(projectRoot, '.agents', 'skills');
      const globalSkillsDir = globalConfigDir ? join(globalConfigDir, 'skills') : null;

      async function writeSkill(name, content) {
        await writeIfMissingOrForced(join(skillsDir, name, 'SKILL.md'), content, { force: true });
        if (globalSkillsDir) {
          await writeIfMissingOrForced(join(globalSkillsDir, name, 'SKILL.md'), content, { force: true });
        }
      }

      for (const tpl of COMMAND_TEMPLATES) {
        const rendered = renderTemplate(await readTemplate(packageRoot, tpl), placeholders);
        const baseName = tpl.split('/').at(-1).replace(/\.md$/, '');
        await writeSkill(baseName, rendered);
      }

      const pmcSkill = renderTemplate(
        await readTemplate(packageRoot, 'pmc-skill/SKILL.md'),
        placeholders,
      );
      await writeSkill('pmc-skill', pmcSkill);

      const enrichSkill = renderTemplate(
        await readTemplate(packageRoot, 'antigravity/skills/enrich/SKILL.md'),
        placeholders,
      );
      await writeSkill('enrich', enrichSkill);

      const enrichOndemandSkill = renderTemplate(
        await readTemplate(packageRoot, 'antigravity/skills/enrich-ondemand/SKILL.md'),
        placeholders,
      );
      await writeSkill('enrich-ondemand', enrichOndemandSkill);
    },
  },
  verifiers: {
    mcp: async ({ globalConfigDir }) => globalConfigDir && existsSync(join(globalConfigDir, 'mcp_config.json')),
    instructions: async ({ projectRoot }) => existsSync(join(projectRoot, 'AGENTS.md')),
    skills: async ({ projectRoot }) => existsSync(join(projectRoot, '.agents', 'skills', 'pmc-skill', 'SKILL.md')),
  },
});
