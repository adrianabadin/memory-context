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

// ─── codex ──────────────────────────────────────────────────────────────────

test('installAgentTemplates(codex) writes AGENTS.md with autostart block', async () => {
  await withTempProject(async (projectRoot) => {
    await installAgentTemplates({ projectRoot, agent: 'codex', packageRoot });

    const agentsMd = join(projectRoot, 'AGENTS.md');
    assert.ok(existsSync(agentsMd), 'AGENTS.md should exist');
    const content = await readFile(agentsMd, 'utf8');
    assert.match(content, /<!-- pmc:autostart -->/);
    assert.match(content, /<!-- \/pmc:autostart -->/);
  });
});

test('installAgentTemplates(codex) writes [mcp_servers.agent-memory] block to .codex/config.toml', async () => {
  await withTempProject(async (projectRoot) => {
    // Pre-create the .codex dir to mirror what `codex init` would do in a real project.
    await mkdir(join(projectRoot, '.codex'), { recursive: true });

    await installAgentTemplates({ projectRoot, agent: 'codex', packageRoot });

    const configPath = join(projectRoot, '.codex', 'config.toml');
    assert.ok(existsSync(configPath), '.codex/config.toml should exist');
    const content = await readFile(configPath, 'utf8');
    assert.match(content, /\[mcp_servers\.agent-memory\]/);
    assert.match(content, /command\s*=\s*"npx"/);
    assert.match(content, /args\s*=\s*\["-y",\s*"@aabadin\/agent-memory-mcp"\]/);
    // MEMORY_DB_PATH is rendered with the actual path placeholder resolved
    assert.match(content, /MEMORY_DB_PATH\s*=\s*".*planning[\\/]project-memory-context[\\/]memory-db"/);
  });
});

test('installAgentTemplates(codex) preserves user config keys already in .codex/config.toml', async () => {
  await withTempProject(async (projectRoot) => {
    const codexDir = join(projectRoot, '.codex');
    await mkdir(codexDir, { recursive: true });
    const userConfig = `[model]\nname = "gpt-5"\ntemperature = 0.2\n`;
    await writeFile(join(codexDir, 'config.toml'), userConfig, 'utf8');

    await installAgentTemplates({ projectRoot, agent: 'codex', packageRoot });

    const content = await readFile(join(codexDir, 'config.toml'), 'utf8');
    assert.match(content, /\[model\]/);
    assert.match(content, /name\s*=\s*"gpt-5"/);
    assert.match(content, /\[mcp_servers\.agent-memory\]/);
  });
});

// ─── kimi ───────────────────────────────────────────────────────────────────

test('installAgentTemplates(kimi) writes AGENTS.md with autostart block', async () => {
  await withTempProject(async (projectRoot) => {
    await installAgentTemplates({ projectRoot, agent: 'kimi', packageRoot });

    const agentsMd = join(projectRoot, 'AGENTS.md');
    assert.ok(existsSync(agentsMd), 'AGENTS.md should exist');
    const content = await readFile(agentsMd, 'utf8');
    assert.match(content, /<!-- pmc:autostart -->/);
    assert.match(content, /<!-- \/pmc:autostart -->/);
  });
});

test('installAgentTemplates(kimi) writes agent-memory entry to .kimi-code/mcp.json', async () => {
  await withTempProject(async (projectRoot) => {
    await installAgentTemplates({ projectRoot, agent: 'kimi', packageRoot });

    const mcpPath = join(projectRoot, '.kimi-code', 'mcp.json');
    assert.ok(existsSync(mcpPath), '.kimi-code/mcp.json should exist');
    const config = JSON.parse(await readFile(mcpPath, 'utf8'));
    assert.ok(config['agent-memory'], 'agent-memory key should be present');
    assert.equal(config['agent-memory'].command, 'npx');
    assert.deepEqual(config['agent-memory'].args, ['-y', '@aabadin/agent-memory-mcp']);
    assert.equal(config['agent-memory'].cwd, '.');
    // MEMORY_DB_PATH is rendered with the actual path
    assert.match(config['agent-memory'].env.MEMORY_DB_PATH, /planning[\\/]project-memory-context[\\/]memory-db$/);
  });
});

test('installAgentTemplates(kimi) preserves user keys already in .kimi-code/mcp.json', async () => {
  await withTempProject(async (projectRoot) => {
    const kimiDir = join(projectRoot, '.kimi-code');
    await mkdir(kimiDir, { recursive: true });
    const existing = {
      'user-server': {
        command: 'node',
        args: ['./user-server.js'],
        env: {},
        cwd: '.',
      },
    };
    await writeFile(join(kimiDir, 'mcp.json'), JSON.stringify(existing, null, 2), 'utf8');

    await installAgentTemplates({ projectRoot, agent: 'kimi', packageRoot });

    const config = JSON.parse(await readFile(join(kimiDir, 'mcp.json'), 'utf8'));
    assert.ok(config['user-server'], 'user-server should survive the merge');
    assert.equal(config['user-server'].command, 'node');
    assert.ok(config['agent-memory'], 'agent-memory should be added');
    assert.equal(config['agent-memory'].command, 'npx');
  });
});

test('installAgentTemplates(kimi) does NOT touch .kimi-code/local.toml (user-owned, gitignored)', async () => {
  await withTempProject(async (projectRoot) => {
    const kimiDir = join(projectRoot, '.kimi-code');
    await mkdir(kimiDir, { recursive: true });
    const localToml = `[user]\nname = "alice"\n`;
    await writeFile(join(kimiDir, 'local.toml'), localToml, 'utf8');

    await installAgentTemplates({ projectRoot, agent: 'kimi', packageRoot });

    // .kimi-code/local.toml must be untouched — it is user-owned and gitignored
    const after = await readFile(join(kimiDir, 'local.toml'), 'utf8');
    assert.equal(after, localToml, 'local.toml must not be modified by pmc');
    // Only mcp.json is created
    assert.ok(existsSync(join(kimiDir, 'mcp.json')));
  });
});

// ─── Idempotency: re-running the install must not duplicate content ───────

test('installAgentTemplates(codex) is idempotent across re-runs (one [mcp_servers.agent-memory] section, one PMC comment block)', async () => {
  await withTempProject(async (projectRoot) => {
    await mkdir(join(projectRoot, '.codex'), { recursive: true });

    // Run the install three times to exercise the merge function across multiple passes.
    for (let i = 0; i < 3; i++) {
      await installAgentTemplates({ projectRoot, agent: 'codex', packageRoot });
    }

    const content = await readFile(join(projectRoot, '.codex', 'config.toml'), 'utf8');
    // Count actual section headers at start of line. The string
    // `mcp_servers.agent-memory` also appears in the PMC comment block,
    // so we anchor with `^` to count only TOML section headers.
    const sectionCount = (content.match(/^\[mcp_servers\.agent-memory\]/gm) ?? []).length;
    assert.equal(sectionCount, 1, `expected 1 section header, found ${sectionCount}`);
    // Count PMC comment blocks by their marker line.
    const commentBlockCount = (content.match(/^# PMC — Codex CLI MCP server entry$/gm) ?? []).length;
    assert.equal(commentBlockCount, 1, `expected 1 PMC comment block, found ${commentBlockCount}`);
  });
});

test('installAgentTemplates(kimi) is idempotent across re-runs (one agent-memory key, no schema drift)', async () => {
  await withTempProject(async (projectRoot) => {
    for (let i = 0; i < 3; i++) {
      await installAgentTemplates({ projectRoot, agent: 'kimi', packageRoot });
    }

    const config = JSON.parse(
      await readFile(join(projectRoot, '.kimi-code', 'mcp.json'), 'utf8'),
    );
    assert.ok(config['agent-memory'], 'agent-memory key must be present');
    assert.equal(Object.keys(config).filter((k) => k === 'agent-memory').length, 1);
    // Schema must match the documented one
    assert.equal(config['agent-memory'].command, 'npx');
    assert.deepEqual(config['agent-memory'].args, ['-y', '@aabadin/agent-memory-mcp']);
    assert.equal(config['agent-memory'].cwd, '.');
  });
});
