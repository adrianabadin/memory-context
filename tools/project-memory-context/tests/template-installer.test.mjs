import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installAgentTemplates } from '../src/template-installer.mjs';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function withTempProject(fn) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-installer-'));
  try {
    await fn(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

// ─── antigravity ─────────────────────────────────────────────────────────────

test('installAgentTemplates(antigravity) writes commands as SKILL.md subfolders in .agents/skills/', async () => {
  await withTempProject(async (projectRoot) => {
    await installAgentTemplates({ projectRoot, agent: 'antigravity', packageRoot });

    // Each command becomes .agents/skills/<name>/SKILL.md (Agent Skills Standard)
    // Spot-check two commands
    const getCtx = join(projectRoot, '.agents', 'skills', 'get-context', 'SKILL.md');
    const mapProject = join(projectRoot, '.agents', 'skills', 'map-project', 'SKILL.md');
    assert.ok(existsSync(getCtx), '.agents/skills/get-context/SKILL.md should exist');
    assert.ok(existsSync(mapProject), '.agents/skills/map-project/SKILL.md should exist');

    const getCtxContent = await readFile(getCtx, 'utf8');
    assert.match(getCtxContent, /^name:/m, 'SKILL.md should have name frontmatter');
    assert.match(getCtxContent, /^description:/m, 'SKILL.md should have description frontmatter');

    // Must NOT create TOML files in .gemini/commands/
    assert.ok(!existsSync(join(projectRoot, '.gemini', 'commands', 'get-context.toml')), 'no TOML files should be created');
  });
});

test('installAgentTemplates(antigravity) writes pmc-skill skill folder', async () => {
  await withTempProject(async (projectRoot) => {
    await installAgentTemplates({ projectRoot, agent: 'antigravity', packageRoot });

    const skill = join(projectRoot, '.agents', 'skills', 'pmc-skill', 'SKILL.md');
    assert.ok(existsSync(skill), 'pmc-skill/SKILL.md should exist');

    const content = await readFile(skill, 'utf8');
    assert.match(content, /PMC-Aware Workflow|pmc-skill|PMC first/i);
  });
});

test('installAgentTemplates(antigravity) writes enrich skill folder', async () => {
  await withTempProject(async (projectRoot) => {
    await installAgentTemplates({ projectRoot, agent: 'antigravity', packageRoot });

    const skill = join(projectRoot, '.agents', 'skills', 'enrich', 'SKILL.md');
    assert.ok(existsSync(skill), 'enrich/SKILL.md should exist');

    const content = await readFile(skill, 'utf8');
    assert.match(content, /^name:\s*enrich/m);
    assert.match(content, /pmc\s+enrich\s+\./);
  });
});

test('installAgentTemplates(antigravity) does NOT write flat .md files in .agents/skills/', async () => {
  await withTempProject(async (projectRoot) => {
    await installAgentTemplates({ projectRoot, agent: 'antigravity', packageRoot });

    // Commands should be TOML, not loose .md files in skills dir
    assert.ok(!existsSync(join(projectRoot, '.agents', 'skills', 'get-context.md')), 'no flat .md commands in skills dir');
    assert.ok(!existsSync(join(projectRoot, '.agents', 'skills', 'enrich.md')), 'no flat enrich.md in skills dir');
  });
});

test('installAgentTemplates(antigravity) writes AGENTS.md with autostart block', async () => {
  await withTempProject(async (projectRoot) => {
    await installAgentTemplates({ projectRoot, agent: 'antigravity', packageRoot });

    const agentsMd = join(projectRoot, 'AGENTS.md');
    assert.ok(existsSync(agentsMd), 'AGENTS.md should exist');

    const content = await readFile(agentsMd, 'utf8');
    assert.match(content, /<!-- pmc:autostart -->/);
    assert.match(content, /<!-- \/pmc:autostart -->/);
  });
});

// ─── claude-code subagent ────────────────────────────────────────────────────

test('installAgentTemplates(claude-code) writes agents/enrich.md when globalConfigDir provided', async () => {
  await withTempProject(async (projectRoot) => {
    const globalConfigDir = await mkdtemp(join(tmpdir(), 'pmc-claude-global-'));
    try {
      await installAgentTemplates({ projectRoot, agent: 'claude-code', packageRoot, globalConfigDir });

      const agentFile = join(globalConfigDir, 'agents', 'enrich.md');
      assert.ok(existsSync(agentFile), 'agents/enrich.md should exist in globalConfigDir');

      const content = await readFile(agentFile, 'utf8');
      assert.match(content, /^name:\s*enrich/m);
      assert.match(content, /pmc\s+enrich\s+\./);
    } finally {
      await rm(globalConfigDir, { recursive: true, force: true });
    }
  });
});

test('installAgentTemplates(claude-code) still works without globalConfigDir', async () => {
  await withTempProject(async (projectRoot) => {
    // Should not throw — just skips global installs
    await assert.doesNotReject(() =>
      installAgentTemplates({ projectRoot, agent: 'claude-code', packageRoot }),
    );
    // CLAUDE.md in project should still be created
    assert.ok(existsSync(join(projectRoot, 'CLAUDE.md')));
  });
});

// ─── opencode plugin + MCP config ───────────────────────────────────────────

test('installAgentTemplates(opencode) writes auto-load plugin wrapper to .opencode/plugins/pmc.mjs', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-installer-plugin-'));
  const globalConfigDir = await mkdtemp(join(tmpdir(), 'pmc-installer-global-'));

  await installAgentTemplates({ projectRoot, agent: 'opencode', globalConfigDir, packageRoot });

  const pluginPath = join(projectRoot, '.opencode', 'plugins', 'pmc.mjs');
  const content = await readFile(pluginPath, 'utf8');
  assert.match(content, /export const PMCPlugin/);
  // Placeholder resolved to an absolute file:// URL pointing at this package's plugin entry
  assert.match(content, /file:\/\/.*plugin\/index\.mjs/);
  assert.doesNotMatch(content, /\{\{PMC_PLUGIN_IMPORT\}\}/);

  await rm(projectRoot, { recursive: true, force: true });
  await rm(globalConfigDir, { recursive: true, force: true });
});

test('installAgentTemplates(opencode) merges MCP config into .opencode/opencode.json preserving existing keys', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-installer-mcp-'));
  const globalConfigDir = await mkdtemp(join(tmpdir(), 'pmc-installer-global-'));

  // Pre-existing user config must survive the merge
  await mkdir(join(projectRoot, '.opencode'), { recursive: true });
  await writeFile(
    join(projectRoot, '.opencode', 'opencode.json'),
    JSON.stringify({ theme: 'dark', mcp: { 'user-server': { type: 'local', command: ['x'] } } }),
  );

  await installAgentTemplates({ projectRoot, agent: 'opencode', globalConfigDir, packageRoot });

  const config = JSON.parse(await readFile(join(projectRoot, '.opencode', 'opencode.json'), 'utf8'));
  assert.equal(config.$schema, 'https://opencode.ai/config.json');
  assert.equal(config.theme, 'dark');
  assert.ok(config.mcp['user-server']);
  assert.ok(config.mcp['pmc-query']);
  assert.ok(config.mcp['pmc-agent-memory']);
  assert.equal(config.mcp['pmc-query'].environment.PMC_PROJECT_ROOT, projectRoot);

  await rm(projectRoot, { recursive: true, force: true });
  await rm(globalConfigDir, { recursive: true, force: true });
});

test('installOpencode overwrites a stale $schema in existing opencode.json', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-installer-schema-'));
  const globalConfigDir = await mkdtemp(join(tmpdir(), 'pmc-installer-global-'));

  await mkdir(join(projectRoot, '.opencode'), { recursive: true });
  await writeFile(
    join(projectRoot, '.opencode', 'opencode.json'),
    JSON.stringify({ $schema: 'https://wrong.example.com/config.json', theme: 'dark' }),
  );

  await installAgentTemplates({ projectRoot, agent: 'opencode', globalConfigDir, packageRoot });

  const config = JSON.parse(await readFile(join(projectRoot, '.opencode', 'opencode.json'), 'utf8'));
  assert.equal(config.$schema, 'https://opencode.ai/config.json');
  assert.equal(config.theme, 'dark');

  await rm(projectRoot, { recursive: true, force: true });
  await rm(globalConfigDir, { recursive: true, force: true });
});
