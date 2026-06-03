import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export { detectAgentType } from './platform.mjs';

export function renderTemplate(content, placeholders) {
  return Object.entries(placeholders).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
    content,
  );
}

const SUPPORTED_AGENTS = new Set(['opencode', 'claude-code', 'cursor', 'generic', 'antigravity']);

function resolvePackageRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

async function loadBinNames(packageRoot) {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  return {
    PMC_BIN: Object.keys(packageJson.bin ?? {})[0] ?? 'pmc',
    AGENT_MEMORY_CMD: 'npx -y @aabadin/agent-memory-mcp',
  };
}

async function buildPlaceholders(projectRoot, packageRoot) {
  const binNames = await loadBinNames(packageRoot);
  return {
    ...binNames,
    PROJECT_ROOT: projectRoot,
    CONFIG_DIR: '.pmc',
  };
}

async function readTemplate(packageRoot, templatePath) {
  return readFile(join(packageRoot, 'templates', templatePath), 'utf8');
}

async function writeIfMissingOrForced(filePath, content, options = {}) {
  const { force = false } = options;
  if (!force && existsSync(filePath)) return false;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return true;
}

function hasBlockMarker(content, marker) {
  return content.includes(`<!-- pmc:${marker} -->`);
}

function replaceOrAppendBlock(content, marker, block) {
  const open = `<!-- pmc:${marker} -->`;
  const close = `<!-- /pmc:${marker} -->`;
  const regex = new RegExp(`${open}[\\s\\S]*?${close}`, 'g');

  if (regex.test(content)) {
    return content.replace(regex, `${open}\n${block}\n${close}`);
  }

  return `${content}\n\n${open}\n${block}\n${close}\n`;
}

function stripBlockMarkers(content, marker) {
  return content
    .replace(new RegExp(`<!-- pmc:${marker} -->|<!-- /pmc:${marker} -->`, 'g'), '')
    .trim();
}

function wrapBlock(marker, block) {
  return `<!-- pmc:${marker} -->\n${block}\n<!-- /pmc:${marker} -->\n`;
}

async function installWithBlockMarker({ projectRoot, packageRoot, placeholders, targetFile, templatePath, marker = 'init' }) {
  const targetPath = join(projectRoot, targetFile);
  const snippet = renderTemplate(await readTemplate(packageRoot, templatePath), placeholders);

  let existing = '';
  if (existsSync(targetPath)) {
    existing = await readFile(targetPath, 'utf8');
  }

  if (hasBlockMarker(existing, marker)) {
    const updated = replaceOrAppendBlock(existing, marker, stripBlockMarkers(snippet, marker));
    await writeFile(targetPath, updated, 'utf8');
    return;
  }

  if (existing.trim()) {
    const updated = replaceOrAppendBlock(existing, marker, stripBlockMarkers(snippet, marker));
    await writeFile(targetPath, updated, 'utf8');
    return;
  }

  await writeFile(targetPath, snippet, 'utf8');
}

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

async function installOpencode({ projectRoot, packageRoot, placeholders, globalConfigDir }) {
  const globalDir = globalConfigDir;

  for (const tpl of COMMAND_TEMPLATES) {
    const rendered = renderTemplate(await readTemplate(packageRoot, tpl), placeholders);
    const fileName = tpl.split('/').at(-1);
    await writeIfMissingOrForced(join(globalDir, 'commands', fileName), rendered, { force: true });
  }

  const enrichTemplate = renderTemplate(
    await readTemplate(packageRoot, 'opencode/agent/enrich.md'),
    placeholders,
  );
  await writeIfMissingOrForced(join(globalDir, 'agents', 'enrich.md'), enrichTemplate, { force: true });

  const pmcSkill = renderTemplate(
    await readTemplate(packageRoot, 'pmc-skill/SKILL.md'),
    placeholders,
  );
  await writeIfMissingOrForced(join(globalDir, 'skills', 'pmc-skill', 'SKILL.md'), pmcSkill, { force: true });

  const agentsMdPath = join(projectRoot, 'AGENTS.md');
  const autostartBlock = renderTemplate(
    await readTemplate(packageRoot, 'opencode/autostart-snippet.md'),
    placeholders,
  );

  let existing = '';
  if (existsSync(agentsMdPath)) {
    existing = await readFile(agentsMdPath, 'utf8');
    // Remove legacy dash-separated blocks if present
    existing = existing.replace(/<!-- pmc-autostart -->[\s\S]*?<!-- \/pmc-autostart -->\n?/g, '');
    // Clean up malformed nested blocks from older versions
    existing = existing.replace(/<!-- pmc:autostart -->[\s\S]*?(?:<!-- \/pmc:autostart -->\s*)+/g, '');
  }

  const updated = replaceOrAppendBlock(existing.trim(), 'autostart', stripBlockMarkers(autostartBlock, 'autostart').trim());
  await writeFile(agentsMdPath, updated, 'utf8');
}

async function installClaudeCode({ projectRoot, packageRoot, placeholders, globalConfigDir }) {
  if (globalConfigDir) {
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

    // Install the SessionStart hook (writes hook script + merges settings.json)
    const hookScriptPath = await writeSessionHookScript(globalConfigDir);
    await mergeSessionStartHook(globalConfigDir, hookScriptPath);
  }

  await installWithBlockMarker({
    packageRoot,
    placeholders,
    projectRoot,
    targetFile: 'CLAUDE.md',
    templatePath: 'claude-code/CLAUDE.md.snippet',
  });
}

async function installCursor({ projectRoot, packageRoot, placeholders }) {
  await installWithBlockMarker({
    packageRoot,
    placeholders,
    projectRoot,
    targetFile: '.cursorrules',
    templatePath: 'cursor/.cursorrules.snippet',
  });
}

async function installAntigravity({ projectRoot, packageRoot, placeholders, globalConfigDir }) {
  // Commands + skills → .agents/skills/<name>/SKILL.md (Agent Skills Standard)
  // Each subfolder name matches the `name` field in frontmatter, which registers it as a
  // slash command in Antigravity. The model can also invoke skills autonomously based on
  // the `description` field (disable-model-invocation absent = both user-invocable and model-invocable).
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

  // AGENTS.md → inject autostart block
  const agentsMdPath = join(projectRoot, 'AGENTS.md');
  const autostartBlock = renderTemplate(
    await readTemplate(packageRoot, 'antigravity/autostart-snippet.md'),
    placeholders,
  );

  let existing = '';
  if (existsSync(agentsMdPath)) {
    existing = await readFile(agentsMdPath, 'utf8');
    // Clean up malformed nested blocks from older versions
    existing = existing.replace(/<!-- pmc:autostart -->[\s\S]*?(?:<!-- \/pmc:autostart -->\s*)+/g, '');
  }

  const updated = replaceOrAppendBlock(existing.trim(), 'autostart', stripBlockMarkers(autostartBlock, 'autostart').trim());
  await writeFile(agentsMdPath, updated, 'utf8');
}

async function installGeneric({ projectRoot, packageRoot, placeholders }) {
  const marker = 'generic';
  const readmePath = join(projectRoot, 'README-SETUP.md');
  const statePath = join(projectRoot, '.pmc', 'generic-readme-installed');
  const readme = renderTemplate(
    await readTemplate(packageRoot, 'generic/README-SETUP.md'),
    placeholders,
  );
  const block = stripBlockMarkers(readme, marker);

  if (existsSync(statePath)) {
    if (!existsSync(readmePath)) {
      await writeFile(readmePath, wrapBlock(marker, block), 'utf8');
      return;
    }

    const existing = await readFile(readmePath, 'utf8');
    if (hasBlockMarker(existing, marker)) {
      await writeFile(readmePath, replaceOrAppendBlock(existing, marker, block), 'utf8');
    } else {
      await writeFile(readmePath, replaceOrAppendBlock(existing, marker, block), 'utf8');
    }
    return;
  }

  if (existsSync(readmePath)) {
    const existing = await readFile(readmePath, 'utf8');
    if (existing.trim()) {
      await writeFile(readmePath, replaceOrAppendBlock(existing, marker, block), 'utf8');
    } else {
      await writeFile(readmePath, wrapBlock(marker, block), 'utf8');
    }
  } else {
    await writeFile(readmePath, wrapBlock(marker, block), 'utf8');
  }

  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, 'installed\n', 'utf8');
}

/**
 * The hook script written to `<globalConfigDir>/hooks/pmc-session-start.js`.
 * Uses CommonJS (not ESM) so it works without any module resolution context.
 * Uses execSync (which shells through cmd.exe on Windows, handling .cmd wrappers).
 */
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

/**
 * Write the session hook script to `<globalConfigDir>/hooks/pmc-session-start.js`.
 * Always overwrites so that updates to the hook content are applied on reinstall.
 */
async function writeSessionHookScript(globalConfigDir) {
  const hookPath = join(globalConfigDir, 'hooks', 'pmc-session-start.js');
  await mkdir(dirname(hookPath), { recursive: true });
  await writeFile(hookPath, PMC_SESSION_HOOK_SCRIPT, 'utf8');
  return hookPath;
}

/**
 * Merge a PMC SessionStart hook into `<globalConfigDir>/settings.json`.
 * Idempotent: skips if `pmc-session-start` is already registered.
 * Normalises the hook script path to forward slashes for cross-platform consistency.
 */
async function mergeSessionStartHook(globalConfigDir, hookScriptPath) {
  const settingsPath = join(globalConfigDir, 'settings.json');
  let settings = {};
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  } catch {
    // settings.json missing or corrupt — start fresh
  }

  settings.hooks ??= {};
  settings.hooks.SessionStart ??= [];

  // Check idempotency — skip if already registered
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

const INSTALLERS = {
  antigravity: installAntigravity,
  'claude-code': installClaudeCode,
  cursor: installCursor,
  generic: installGeneric,
  opencode: installOpencode,
};

export async function installAgentTemplates({
  projectRoot,
  agent,
  packageRoot,
  globalConfigDir,
}) {
  if (!SUPPORTED_AGENTS.has(agent)) {
    throw new Error(`Unsupported agent type: ${agent}. Supported: ${[...SUPPORTED_AGENTS].join(', ')}`);
  }

  if (agent === 'opencode' && !globalConfigDir) {
    throw new Error('globalConfigDir is required for agent: opencode');
  }

  const pkgRoot = packageRoot ?? resolvePackageRoot();
  const placeholders = await buildPlaceholders(projectRoot, pkgRoot);

  await INSTALLERS[agent]({
    globalConfigDir,
    packageRoot: pkgRoot,
    placeholders,
    projectRoot,
  });
}
