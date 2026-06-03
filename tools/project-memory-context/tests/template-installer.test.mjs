import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
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
