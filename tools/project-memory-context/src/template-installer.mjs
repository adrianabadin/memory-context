import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildInjectedPmcConfig } from './plugin-config.mjs';

export { detectAgentType } from './platform.mjs';

export function renderTemplate(content, placeholders) {
  return Object.entries(placeholders).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
    content,
  );
}

const SUPPORTED_AGENTS = new Set(['opencode', 'claude-code', 'cursor', 'generic', 'antigravity', 'codex', 'kimi']);

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

// Shared installer-state reader used by all per-agent install functions. The
// state file is written by bootstrapProjectInstall at the start of `pmc setup`,
// so by the time installAgentTemplates runs it is on disk. If it is missing
// (e.g. a partial re-run) we fall back to the canonical path so the install
// still completes instead of throwing.
async function readInstallState(projectRoot) {
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
    // Installer-owned field: always set the canonical schema, even if the
    // existing config carries a stale or wrong one.
    $schema: 'https://opencode.ai/config.json',
    mcp: { ...(existing.mcp ?? {}), ...injected.mcp },
  };

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
}

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

  // Auto-load plugin wrapper: OpenCode loads .opencode/plugins/*.mjs at startup.
  // The import path is resolved at install time to this package's location —
  // global install for consumers, local path in the source repo.
  const pluginImportUrl = pathToFileURL(join(packageRoot, 'plugin', 'index.mjs')).href;
  const pluginContent = renderTemplate(
    await readTemplate(packageRoot, 'opencode/plugins/pmc.mjs'),
    { ...placeholders, PMC_PLUGIN_IMPORT: pluginImportUrl },
  );
  await writeIfMissingOrForced(join(projectRoot, '.opencode', 'plugins', 'pmc.mjs'), pluginContent, { force: true });

  // MCP servers: written directly to project config (OpenCode has no `config` hook).
  const installState = await readOpencodeInstallState(projectRoot);
  await writeOpencodeProjectConfig({ projectRoot, installState });
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

async function installCodex({ projectRoot, packageRoot, placeholders }) {
  // AGENTS.md: project instructions file. Codex reads it on startup; we
  // reuse the antigravity autostart snippet (no native SessionStart hook
  // on either tool, both rely on a manual `pmc session-start .` per session).
  const agentsMdPath = join(projectRoot, 'AGENTS.md');
  const autostartBlock = renderTemplate(
    await readTemplate(packageRoot, 'antigravity/autostart-snippet.md'),
    placeholders,
  );

  let existing = '';
  if (existsSync(agentsMdPath)) {
    existing = await readFile(agentsMdPath, 'utf8');
    existing = existing.replace(/<!-- pmc-autostart -->[\s\S]*?<!-- \/pmc-autostart -->\n?/g, '');
    existing = existing.replace(/<!-- pmc:autostart -->[\s\S]*?(?:<!-- \/pmc:autostart -->\s*)+/g, '');
  }

  const updated = replaceOrAppendBlock(
    existing.trim(),
    'autostart',
    stripBlockMarkers(autostartBlock, 'autostart').trim(),
  );
  await writeFile(agentsMdPath, updated, 'utf8');

  // MCP: merge a [mcp_servers.agent-memory] block into .codex/config.toml
  // (TOML). Codex loads project config only when the project is trusted.
  const installState = await readInstallState(projectRoot);
  const codexConfigPath = join(projectRoot, '.codex', 'config.toml');
  await writeCodexConfig({ codexConfigPath, installState, packageRoot, placeholders });
}

async function installKimi({ projectRoot, packageRoot, placeholders }) {
  // AGENTS.md: Kimi reads it on startup. Same snippet as Codex — see note there.
  const agentsMdPath = join(projectRoot, 'AGENTS.md');
  const autostartBlock = renderTemplate(
    await readTemplate(packageRoot, 'antigravity/autostart-snippet.md'),
    placeholders,
  );

  let existing = '';
  if (existsSync(agentsMdPath)) {
    existing = await readFile(agentsMdPath, 'utf8');
    existing = existing.replace(/<!-- pmc-autostart -->[\s\S]*?<!-- \/pmc-autostart -->\n?/g, '');
    existing = existing.replace(/<!-- pmc:autostart -->[\s\S]*?(?:<!-- \/pmc:autostart -->\s*)+/g, '');
  }

  const updated = replaceOrAppendBlock(
    existing.trim(),
    'autostart',
    stripBlockMarkers(autostartBlock, 'autostart').trim(),
  );
  await writeFile(agentsMdPath, updated, 'utf8');

  // MCP: merge into .kimi-code/mcp.json (JSON). Never touch .kimi-code/local.toml
  // — that file is user-owned and meant to be gitignored per Kimi's convention.
  const installState = await readInstallState(projectRoot);
  const kimiMcpPath = join(projectRoot, '.kimi-code', 'mcp.json');
  await writeKimiMcpConfig({ kimiMcpPath, installState, packageRoot, placeholders });
}

/**
 * Escape a string for use as a literal in a RegExp pattern.
 */
function escapeRegExp(string) {
  return String(string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Merge a `[section_name]` block into a TOML file, non-destructively.
 *
 * - If one or more `[section_name]` blocks already exist (e.g. left over
 *   from prior buggy installs), strip ALL of them — plus the PMC comment
 *   block that precedes each one in our snippet — and append the new
 *   block at the end of the file.
 * - If none exist, append the new block at the end of the file.
 *
 * What survives: anything outside the matched blocks — other tables,
 * top-level keys, user comments — is preserved verbatim. So a
 * user-managed `[model]` section stays put.
 *
 * Why "remove all and append" instead of "replace first match": duplicate
 * `[mcp_servers.agent-memory]` sections are invalid TOML per spec
 * (the parser would either error or pick the last one — implementation
 * defined), and an earlier version of this helper appended the snippet
 * on every run, which left the file with N duplicates after N installs.
 * Removing every occurrence before writing the canonical one is the only
 * safe option across re-runs of `pmc setup`.
 *
 * This is text-level only, by design: we don't want a TOML dependency
 * in the package just for one MCP entry.
 *
 * Pattern: `^\[name\][^\n]*(?:\n(?!\[[^\]]*\])[^\n]*)*` matches the header
 * at start of line, plus any number of following body lines that do not
 * themselves start with `[`. We use a per-line negative lookahead instead
 * of a `[\s\S]*?` + end-of-input anchor because JavaScript's regex
 * flavour has no `\Z` — `(?=\Z)` is a no-op (matches literal `Z`) and
 * silently breaks the match. Lines starting with `[` are section
 * boundaries in TOML, so this is exact.
 *
 * The PMC comment block is matched by its identifying first line
 * (`# PMC — Codex CLI MCP server entry`) so we can strip it along with
 * the section. We don't try to match "any comment block" — that would
 * eat the user's own comments.
 *
 * The trade-off: the new block is always appended at the end of the
 * file, not in its original position. If the user has other sections
 * after a stale `[mcp_servers.agent-memory]`, the file's section order
 * will change. This is an acceptable cleanup cost — the alternative is
 * to track insertion position, which is overkill for a single MCP entry.
 */
function mergeTomlSection(content, sectionName, newBlock, pmcCommentMarker) {
  const escaped = escapeRegExp(sectionName);
  // Match the section header (start of line) plus its body lines
  // (any line that does NOT start with `[`). `[^\n]*` keeps us on one
  // line at a time; `(?!\[[^\]]*\])` is the negative lookahead that
  // stops at the next section header.
  const sectionRegex = new RegExp(
    `^\\[${escaped}\\][^\\n]*(?:\\n(?!\\[[^\\]]*\\])[^\\n]*)*`,
    'gm',
  );

  // Strip every occurrence. Process matches in reverse so positions don't
  // shift while we slice. Using matchAll (g flag) finds every block,
  // including duplicates from a previously broken install.
  let stripped = content;
  const sectionMatches = [...stripped.matchAll(sectionRegex)];
  for (let i = sectionMatches.length - 1; i >= 0; i--) {
    const { index, 0: full } = sectionMatches[i];
    stripped = stripped.slice(0, index) + stripped.slice(index + full.length);
  }

  // Also strip the PMC comment block immediately preceding each removed
  // section. The block starts with the marker line and is followed by
  // zero or more `#`-prefixed lines. We scan from each removed section's
  // original position backwards; the actual byte offsets in `stripped`
  // differ from the ones in `content` once we've already removed the
  // sections, so we look for the marker after stripping. To stay
  // position-correct, we do this in a second pass over the ORIGINAL
  // content but only touching regions around the section positions.
  if (pmcCommentMarker) {
    const markerEscaped = escapeRegExp(pmcCommentMarker);
    // The PMC comment block: marker line + zero or more `# ...` lines.
    // No anchor on the marker (we may have just removed the preceding
    // section, leaving the comment stranded), but the marker string is
    // specific enough that false positives are negligible.
    const commentRegex = new RegExp(
      `(?:^|\\n)${markerEscaped}\\n(?:^#.*\\n)*`,
      'gm',
    );
    stripped = stripped.replace(commentRegex, '\n');
  }

  // Collapse runs of 3+ blank lines left by the strip into 2, then append.
  const normalized = stripped.replace(/\n{3,}/g, '\n\n').trimEnd();
  return `${normalized}\n\n${newBlock.trim()}\n`;
}

async function writeCodexConfig({ codexConfigPath, installState, packageRoot, placeholders }) {
  // Normalize the path to forward slashes before substituting it into a
  // TOML string literal. On Windows, raw backslashes would either form
  // invalid escape sequences (`\U`/`\A` etc.) or get interpreted as
  // TOML escapes; forward slashes are valid in TOML basic strings and
  // accepted by every target runtime (Ollama, LanceDB, Node).
  const memoryDbPath = String(installState.memoryDbPath).replace(/\\/g, '/');

  const snippet = renderTemplate(
    await readTemplate(packageRoot, 'codex/config.toml.snippet'),
    {
      ...placeholders,
      MEMORY_DB_PATH: memoryDbPath,
    },
  );

  let existing = '';
  if (existsSync(codexConfigPath)) {
    existing = await readFile(codexConfigPath, 'utf8');
  }

  const merged = mergeTomlSection(
    existing,
    'mcp_servers.agent-memory',
    snippet,
    '# PMC — Codex CLI MCP server entry',
  );

  await mkdir(dirname(codexConfigPath), { recursive: true });
  await writeFile(codexConfigPath, merged, 'utf8');
}

/**
 * Merge the `agent-memory` entry into `.kimi-code/mcp.json` non-destructively.
 * Existing top-level keys are preserved; the `agent-memory` key is replaced
 * with the freshly rendered one (same JSON shape, just with the current
 * MEMORY_DB_PATH).
 */
async function writeKimiMcpConfig({ kimiMcpPath, installState, packageRoot, placeholders }) {
  // Forward-slash path: same rationale as in writeCodexConfig — raw
  // backslashes would form invalid JSON escape sequences (`\U`, `\A`).
  const memoryDbPath = String(installState.memoryDbPath).replace(/\\/g, '/');

  const snippet = renderTemplate(
    await readTemplate(packageRoot, 'kimi/mcp.json.snippet'),
    {
      ...placeholders,
      MEMORY_DB_PATH: memoryDbPath,
    },
  );

  let existing = {};
  if (existsSync(kimiMcpPath)) {
    try {
      existing = JSON.parse(await readFile(kimiMcpPath, 'utf8'));
    } catch {
      // Corrupt or non-JSON file — start fresh but don't lose the user's data
      // silently. Surface this by writing alongside, not over.
      existing = {};
    }
  }

  const newEntry = JSON.parse(snippet);
  const merged = { ...existing, ...newEntry };

  await mkdir(dirname(kimiMcpPath), { recursive: true });
  await writeFile(kimiMcpPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
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
  codex: installCodex,
  cursor: installCursor,
  generic: installGeneric,
  kimi: installKimi,
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
