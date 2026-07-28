import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

const PMC_SESSION_HOOK_SCRIPT = `#!/usr/bin/env node
'use strict';
// pmc-session-start.js — installed by pmc setup
// Runs pmc session-start outside the LLM context window.
// On Claude Code, output is injected as additionalContext (zero agent tokens).
const { execSync } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const pmcDir = join(cwd, '.planning', 'project-memory-context');

if (!existsSync(pmcDir)) {
  process.exit(0);
}

try {
  const escaped = cwd.replace(/"/g, '\\\\"');
  const result = execSync(\`pmc session-start "\${escaped}" --format=claude-code\`, {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result && result.trim()) {
    process.stdout.write(result);
  }
} catch {
  // Silent fail — never block agent startup
}
`;

async function writeIfMissingOrForced(filePath, content, options = {}) {
  const { force = false } = options;
  if (!force && existsSync(filePath)) return false;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return true;
}

async function writeSessionHookScript(globalConfigDir) {
  const hookPath = join(globalConfigDir, 'hooks', 'pmc-session-start.js');
  await mkdir(dirname(hookPath), { recursive: true });
  await writeFile(hookPath, PMC_SESSION_HOOK_SCRIPT, 'utf8');
  return hookPath;
}

async function mergeSessionStartHook(globalConfigDir, hookScriptPath) {
  const settingsPath = join(globalConfigDir, 'settings.json');
  let settings = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  } catch {}

  settings.hooks ??= {};
  settings.hooks.SessionStart ??= [];

  const normalHookPath = hookScriptPath.replace(/\\/g, '/');
  const alreadyRegistered = settings.hooks.SessionStart.some((group) =>
    (group.hooks ?? []).some(
      (h) => typeof h.command === 'string' && h.command.includes('pmc-session-start'),
    ),
  );

  if (!alreadyRegistered) {
    settings.hooks.SessionStart.push({
      hooks: [
        {
          type: 'command',
          command: `node "${normalHookPath}"`,
        },
      ],
    });
  }

  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

export const claudeCodeAdapter = Object.freeze({
  id: 'claude-code',
  legacyId: 'claude-code',
  priority: 20,
  flags: ['--claude'],
  markers: CLIENT_MARKERS['claude-code'],
  paths: {
    projectConfig: (root) => join(root, '.mcp.json'),
    globalConfig: (home) => join(home, '.claude'),
  },
  capabilities: {
    mcp: {
      supported: true,
      format: 'json',
      target: 'projectConfig',
      ownedKeys: ['mcpServers.pmc-query', 'mcpServers.pmc-agent-memory'],
    },
    instructions: {
      supported: true,
      format: 'markdown',
      target: 'CLAUDE.md',
      marker: 'init',
    },
    skills: {
      supported: true,
      format: 'files',
      target: 'globalConfig',
    },
    hooks: {
      supported: true,
      format: 'json',
      target: 'globalConfig',
      ownedKeys: ['hooks.SessionStart.hooks.pmc-session-start'],
    },
  },
  writers: {
    mcp: async () => {},
    instructions: async ({ projectRoot, packageRoot, placeholders, readTemplate }) => {
      const targetPath = join(projectRoot, 'CLAUDE.md');
      const snippet = renderTemplate(await readTemplate(packageRoot, 'claude-code/CLAUDE.md.snippet'), placeholders);

      let existing = '';
      if (existsSync(targetPath)) {
        existing = await readFile(targetPath, 'utf8');
      }

      if (hasBlockMarker(existing, 'init')) {
        const updated = replaceOrAppendBlock(existing, 'init', stripBlockMarkers(snippet, 'init'));
        await writeFile(targetPath, updated, 'utf8');
        return;
      }

      if (existing.trim()) {
        const updated = replaceOrAppendBlock(existing, 'init', stripBlockMarkers(snippet, 'init'));
        await writeFile(targetPath, updated, 'utf8');
        return;
      }

      await writeFile(targetPath, snippet, 'utf8');
    },
    skills: async ({ globalConfigDir, packageRoot, placeholders, readTemplate }) => {
      if (!globalConfigDir) return;
      for (const tpl of COMMAND_TEMPLATES) {
        const rendered = renderTemplate(await readTemplate(packageRoot, tpl), placeholders);
        const fileName = tpl.split('/').at(-1);
        await writeIfMissingOrForced(join(globalConfigDir, 'commands', fileName), rendered, { force: true });
      }

      const pmcSkill = renderTemplate(
        await readTemplate(packageRoot, 'pmc-skill/SKILL.md'),
        placeholders,
      );
      await writeIfMissingOrForced(join(globalConfigDir, 'skills', 'pmc-skill', 'SKILL.md'), pmcSkill, { force: true });

      const enrichAgent = renderTemplate(
        await readTemplate(packageRoot, 'claude-code/agents/enrich.md'),
        placeholders,
      );
      await writeIfMissingOrForced(join(globalConfigDir, 'agents', 'enrich.md'), enrichAgent, { force: true });

      const globalClaudeMdPath = join(globalConfigDir, 'CLAUDE.md');
      const autostartBlock = renderTemplate(
        await readTemplate(packageRoot, 'opencode/autostart-snippet.md'),
        placeholders,
      );
      let existingGlobal = '';
      if (existsSync(globalClaudeMdPath)) {
        existingGlobal = await readFile(globalClaudeMdPath, 'utf8');
      }
      const updatedGlobal = replaceOrAppendBlock(
        existingGlobal.trim(),
        'autostart',
        stripBlockMarkers(autostartBlock, 'autostart').trim(),
      );
      await writeFile(globalClaudeMdPath, updatedGlobal, 'utf8');
    },
    hooks: async ({ globalConfigDir }) => {
      if (!globalConfigDir) return;
      const hookScriptPath = await writeSessionHookScript(globalConfigDir);
      await mergeSessionStartHook(globalConfigDir, hookScriptPath);
    },
  },
  verifiers: {
    mcp: async ({ projectRoot }) => existsSync(join(projectRoot, '.mcp.json')),
    instructions: async ({ projectRoot }) => existsSync(join(projectRoot, 'CLAUDE.md')),
    skills: async ({ globalConfigDir }) => globalConfigDir && existsSync(join(globalConfigDir, 'skills', 'pmc-skill', 'SKILL.md')),
    hooks: async ({ globalConfigDir }) => globalConfigDir && existsSync(join(globalConfigDir, 'hooks', 'pmc-session-start.js')),
  },
});
