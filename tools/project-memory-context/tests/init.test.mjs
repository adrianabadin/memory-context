import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { detectAgentType, installAgentTemplates, renderTemplate } from '../src/template-installer.mjs';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('renderTemplate replaces all placeholders', () => {
  const result = renderTemplate('Run {{PMC_BIN}} bootstrap in {{PROJECT_ROOT}}', {
    PMC_BIN: 'pmc',
    PROJECT_ROOT: '/home/user/repo',
  });
  assert.equal(result, 'Run pmc bootstrap in /home/user/repo');
});

test('renderTemplate leaves unknown placeholders untouched', () => {
  const result = renderTemplate('{{PMC_BIN}} {{UNKNOWN}}', { PMC_BIN: 'pmc' });
  assert.equal(result, 'pmc {{UNKNOWN}}');
});

test('installAgentTemplates writes a CLAUDE.md for claude-code', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-init-'));
  try {
    await installAgentTemplates({ projectRoot, agent: 'claude-code' });
    const claudeMd = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf8');
    assert.match(claudeMd, /\/map-project/);
    assert.match(claudeMd, /pmc map-project --all --enrich/);
    assert.match(claudeMd, /pmc get-context <target>/);
    assert.match(claudeMd, /\/enrich-status/);
    assert.match(claudeMd, /pmc enrich-status/);
    assert.match(claudeMd, /\/pmc-doctor/);
    assert.match(claudeMd, /\/init-project/);
    assert.match(claudeMd, /pmc init-project/);
    assert.match(claudeMd, /pmc sync-context/);
    assert.match(claudeMd, /pmc sanitize/);
    assert.match(claudeMd, /pmc session-start/);
    assert.match(claudeMd, /pmc enrich \./);
    assert.doesNotMatch(claudeMd, /Start-Process -FilePath/);
    assert.doesNotMatch(claudeMd, /nohup pmc enrich/);
    assert.doesNotMatch(claudeMd, /pmc bootstrap/);
    assert.doesNotMatch(claudeMd, /tools\/project-memory-context\/cli\/enrich-queue\.mjs/);
    assert.doesNotMatch(claudeMd, /upsert pending entries into `agent-memory`/);
    assert.doesNotMatch(claudeMd, /agent-memory_store|agent-memory_update/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('installAgentTemplates preserves existing CLAUDE.md content on first install', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-init-'));
  try {
    await writeFile(join(projectRoot, 'CLAUDE.md'), '# Existing\n\nKeep this.\n', 'utf8');

    await installAgentTemplates({ projectRoot, agent: 'claude-code' });

    const claudeMd = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf8');
    assert.match(claudeMd, /# Existing/);
    assert.match(claudeMd, /Keep this\./);
    assert.match(claudeMd, /<!-- pmc:init -->/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('installAgentTemplates writes .cursorrules for cursor', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-init-'));
  try {
    await installAgentTemplates({ projectRoot, agent: 'cursor' });
    const cursorRules = await readFile(join(projectRoot, '.cursorrules'), 'utf8');
    assert.match(cursorRules, /\/map-project/);
    assert.match(cursorRules, /pmc map-project --all --enrich/);
    assert.match(cursorRules, /pmc get-context <target>/);
    assert.match(cursorRules, /pmc enrich-status/);
    assert.match(cursorRules, /pmc init-project/);
    assert.match(cursorRules, /pmc sync-context/);
    assert.match(cursorRules, /pmc sanitize/);
    assert.match(cursorRules, /pmc session-start/);
    assert.match(cursorRules, /pmc enrich \./);
    assert.doesNotMatch(cursorRules, /Start-Process -FilePath/);
    assert.doesNotMatch(cursorRules, /nohup pmc enrich/);
    assert.doesNotMatch(cursorRules, /pmc bootstrap/);
    assert.doesNotMatch(cursorRules, /tools\/project-memory-context\/cli\/enrich-queue\.mjs/);
    assert.doesNotMatch(cursorRules, /upsert pending entries into `agent-memory`/);
    assert.doesNotMatch(cursorRules, /agent-memory_store|agent-memory_update/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('installAgentTemplates preserves existing .cursorrules content on first install', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-init-'));
  try {
    await writeFile(join(projectRoot, '.cursorrules'), '# Existing\n\nKeep this.\n', 'utf8');

    await installAgentTemplates({ projectRoot, agent: 'cursor' });

    const cursorRules = await readFile(join(projectRoot, '.cursorrules'), 'utf8');
    assert.match(cursorRules, /# Existing/);
    assert.match(cursorRules, /Keep this\./);
    assert.match(cursorRules, /<!-- pmc:init -->/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('installAgentTemplates writes opencode commands and agent files', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-init-'));
  const globalConfig = join(projectRoot, 'config');
  try {
    await installAgentTemplates({
      projectRoot,
      agent: 'opencode',
      globalConfigDir: globalConfig,
    });

    assert.ok(existsSync(join(globalConfig, 'commands', 'map-project.md')), 'map-project command missing');
    assert.ok(existsSync(join(globalConfig, 'commands', 'get-context.md')), 'get-context command missing');
    assert.ok(existsSync(join(globalConfig, 'commands', 'sync-context.md')), 'sync-context command missing');
    assert.ok(existsSync(join(globalConfig, 'commands', 'sanitize.md')), 'sanitize command missing');
    assert.ok(existsSync(join(globalConfig, 'commands', 'enrich-status.md')), 'enrich-status command missing');
    assert.ok(existsSync(join(globalConfig, 'commands', 'pmc-doctor.md')), 'pmc-doctor command missing');
    assert.ok(existsSync(join(globalConfig, 'commands', 'init-project.md')), 'init-project command missing');
    assert.ok(existsSync(join(globalConfig, 'agents', 'enrich.md')), 'enrich agent missing');
    assert.ok(existsSync(join(globalConfig, 'skills', 'pmc-skill', 'SKILL.md')), 'pmc skill missing');

    const newProject = await readFile(join(globalConfig, 'commands', 'map-project.md'), 'utf8');
    assert.match(newProject, /pmc map-project --all --enrich/);

    const syncContext = await readFile(join(globalConfig, 'commands', 'sync-context.md'), 'utf8');
    assert.match(syncContext, /pmc sync-context/);
    assert.doesNotMatch(syncContext, /upsert pending entries into `agent-memory`/);
    assert.doesNotMatch(syncContext, /agent-memory_store|agent-memory_update/);
    assert.doesNotMatch(syncContext, /Run the sync using `agent-memory` MCP tools\./);

    const pmcSkill = await readFile(join(globalConfig, 'skills', 'pmc-skill', 'SKILL.md'), 'utf8');
    assert.match(pmcSkill, /PMC first, files second/);

    const agentsMd = await readFile(join(projectRoot, 'AGENTS.md'), 'utf8');
    assert.match(agentsMd, /pmc:autostart/, 'AGENTS.md should contain autostart snippet');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('installAgentTemplates overwrites existing opencode global files on re-run', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-init-'));
  const globalConfig = join(projectRoot, 'config');
  try {
    await installAgentTemplates({
      projectRoot,
      agent: 'opencode',
      globalConfigDir: globalConfig,
    });

    await writeFile(join(globalConfig, 'commands', 'map-project.md'), '# custom command\n', 'utf8');
    await writeFile(join(globalConfig, 'agents', 'enrich.md'), '# custom agent\n', 'utf8');
    await writeFile(join(globalConfig, 'skills', 'pmc-skill', 'SKILL.md'), '# custom skill\n', 'utf8');

    await installAgentTemplates({
      projectRoot,
      agent: 'opencode',
      globalConfigDir: globalConfig,
    });

    assert.notEqual(await readFile(join(globalConfig, 'commands', 'map-project.md'), 'utf8'), '# custom command\n');
    assert.notEqual(await readFile(join(globalConfig, 'agents', 'enrich.md'), 'utf8'), '# custom agent\n');
    assert.notEqual(await readFile(join(globalConfig, 'skills', 'pmc-skill', 'SKILL.md'), 'utf8'), '# custom skill\n');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('installAgentTemplates rejects opencode installs without globalConfigDir', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-init-'));
  try {
    await assert.rejects(
      () => installAgentTemplates({ projectRoot, agent: 'opencode' }),
      /globalConfigDir.*required.*opencode/i,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('installAgentTemplates writes README-SETUP.md for generic', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-init-'));
  try {
    await installAgentTemplates({ projectRoot, agent: 'generic' });
    const readme = await readFile(join(projectRoot, 'README-SETUP.md'), 'utf8');
    assert.match(readme, /pmc map-project --all --enrich/);
    assert.match(readme, /pmc enrich-status/);
    assert.match(readme, /pmc get-context --refresh/);
    assert.match(readme, /pmc sync-context/);
    assert.match(readme, /pmc enrich/);
    assert.doesNotMatch(readme, /pmc bootstrap/);
    assert.doesNotMatch(readme, /tools\/project-memory-context\/cli\/enrich-queue\.mjs/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('installAgentTemplates preserves existing README-SETUP.md for generic on re-run', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-init-'));
  try {
    await installAgentTemplates({ projectRoot, agent: 'generic' });
    const existing = await readFile(join(projectRoot, 'README-SETUP.md'), 'utf8');
    await writeFile(join(projectRoot, 'README-SETUP.md'), `# custom generic setup\n\n${existing}`, 'utf8');

    await installAgentTemplates({ projectRoot, agent: 'generic' });

    const readme = await readFile(join(projectRoot, 'README-SETUP.md'), 'utf8');
    assert.match(readme, /# custom generic setup/);
    assert.match(readme, /<!-- pmc:generic -->/);
    assert.match(readme, /# PMC Setup Guide/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('installAgentTemplates preserves existing README-SETUP.md and appends PMC content on first generic install', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-init-'));
  try {
    await writeFile(join(projectRoot, 'README-SETUP.md'), '# Existing Setup\n\nKeep this.\n', 'utf8');

    await installAgentTemplates({ projectRoot, agent: 'generic' });

    const readme = await readFile(join(projectRoot, 'README-SETUP.md'), 'utf8');
    assert.match(readme, /# Existing Setup/);
    assert.match(readme, /Keep this\./);
    assert.match(readme, /# PMC Setup Guide/);
    assert.match(readme, /<!-- pmc:generic -->/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('installAgentTemplates restores missing generic PMC block on rerun while preserving custom content', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-init-'));
  try {
    await installAgentTemplates({ projectRoot, agent: 'generic' });
    await writeFile(join(projectRoot, 'README-SETUP.md'), '# Custom Setup\n\nKeep this.\n', 'utf8');

    await installAgentTemplates({ projectRoot, agent: 'generic' });

    const readme = await readFile(join(projectRoot, 'README-SETUP.md'), 'utf8');
    assert.match(readme, /# Custom Setup/);
    assert.match(readme, /Keep this\./);
    assert.match(readme, /# PMC Setup Guide/);
    assert.match(readme, /<!-- pmc:generic -->/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('installAgentTemplates derives CLI placeholders from package metadata', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-init-'));
  const packageRoot = await mkdtemp(join(tmpdir(), 'pmc-pkg-'));
  try {
    await mkdir(join(packageRoot, 'templates', 'generic'), { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      bin: {
        'custom-pmc': 'bin/custom.mjs',
      },
    }), 'utf8');
    await writeFile(
      join(packageRoot, 'templates', 'generic', 'README-SETUP.md'),
      '{{PMC_BIN}} map-project --all --enrich\n{{AGENT_MEMORY_CMD}}\n',
      'utf8',
    );

    await installAgentTemplates({ projectRoot, packageRoot, agent: 'generic' });
    const readme = await readFile(join(projectRoot, 'README-SETUP.md'), 'utf8');

    assert.match(readme, /custom-pmc map-project --all --enrich/);
    assert.match(readme, /npx -y @aabadin\/agent-memory-mcp/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test('installAgentTemplates is idempotent on re-run', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-init-'));
  try {
    await installAgentTemplates({ projectRoot, agent: 'claude-code' });
    await installAgentTemplates({ projectRoot, agent: 'claude-code' });
    const claudeMd = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf8');
    const matches = claudeMd.match(/pmc map-project --all --enrich/g);
    assert.ok(matches);
    assert.equal(matches.length, 1, 'expected exactly one pmc map-project occurrence');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('pmc skill template exists with PMC-first guidance', async () => {
  const skillTemplate = await readFile(
    join(packageRoot, 'templates', 'pmc-skill', 'SKILL.md'),
    'utf8',
  );

  assert.match(skillTemplate, /PMC first, files second/);
  assert.match(skillTemplate, /query PMC before reading more than 3 files/i);
  assert.match(skillTemplate, /pmc_query_project/);
});

test('Claude and Cursor snippets include PMC-first guidance and MCP tools', async () => {
  const [claudeSnippet, cursorSnippet] = await Promise.all([
    readFile(join(packageRoot, 'templates', 'claude-code', 'CLAUDE.md.snippet'), 'utf8'),
    readFile(join(packageRoot, 'templates', 'cursor', '.cursorrules.snippet'), 'utf8'),
  ]);

  assert.match(claudeSnippet, /PMC first, files second/);
  assert.match(claudeSnippet, /pmc_query_project/);
  assert.match(claudeSnippet, /project-context/);
  assert.match(claudeSnippet, /\/get-context <target>/);
  assert.match(claudeSnippet, /{{PMC_BIN}} session-start/);
  assert.match(claudeSnippet, /{{PMC_BIN}} enrich \./);
  assert.doesNotMatch(claudeSnippet, /Start-Process -FilePath/);
  assert.match(cursorSnippet, /PMC first, files second/);
  assert.match(cursorSnippet, /pmc_search_symbols/);
  assert.match(cursorSnippet, /project-context/);
  assert.match(cursorSnippet, /\/get-context <target>/);
  assert.match(cursorSnippet, /{{PMC_BIN}} session-start/);
  assert.match(cursorSnippet, /{{PMC_BIN}} enrich \./);
  assert.doesNotMatch(cursorSnippet, /Start-Process -FilePath/);
});

test('pmc skill wording includes target-aware get-context usage', async () => {
  const skillTemplate = await readFile(
    join(packageRoot, 'templates', 'pmc-skill', 'SKILL.md'),
    'utf8',
  );

  assert.match(skillTemplate, /\/get-context <target>/);
});

test('detectAgentType detects opencode from .opencode directory', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-init-'));
  try {
    await mkdir(join(projectRoot, '.opencode'), { recursive: true });
    assert.equal(detectAgentType(projectRoot), 'opencode');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('detectAgentType detects claude-code from CLAUDE.md', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-init-'));
  try {
    await writeFile(join(projectRoot, 'CLAUDE.md'), '# test', 'utf8');
    assert.equal(detectAgentType(projectRoot), 'claude-code');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('detectAgentType detects cursor from .cursorrules', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-init-'));
  try {
    await writeFile(join(projectRoot, '.cursorrules'), '# test', 'utf8');
    assert.equal(detectAgentType(projectRoot), 'cursor');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('detectAgentType returns generic when no markers found', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-init-'));
  try {
    assert.equal(detectAgentType(projectRoot), 'generic');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('installAgentTemplates throws for unknown agent type', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-init-'));
  try {
    await assert.rejects(
      () => installAgentTemplates({ projectRoot, agent: 'unknown' }),
      /unsupported agent/i,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
