import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function readTemplate(relativePath) {
  return readFileSync(join(packageRoot, 'templates', relativePath), 'utf8');
}

test('opencode commands use the new pmc subcommands', () => {
  assert.match(readTemplate('opencode/commands/map-project.md'), /\{\{PMC_BIN\}\} map-project --all --enrich/);
  assert.match(readTemplate('opencode/commands/get-context.md'), /\{\{PMC_BIN\}\} get-context <target> \[depth\] \[focus\]/);
  assert.match(readTemplate('opencode/commands/get-context.md'), /\{\{PMC_BIN\}\} get-context symbol <target> \[depth\] \[focus\]/);
  assert.match(readTemplate('opencode/commands/get-context.md'), /\{\{PMC_BIN\}\} get-context file <target> \[depth\] \[focus\]/);
  assert.match(readTemplate('opencode/commands/get-context.md'), /\{\{PMC_BIN\}\} get-context query <target> \[depth\] \[focus\]/);
  assert.match(readTemplate('opencode/commands/get-context.md'), /\{\{PMC_BIN\}\} get-context --refresh/);
  assert.match(readTemplate('opencode/commands/enrich-status.md'), /\{\{PMC_BIN\}\} enrich-status/);
  assert.match(readTemplate('opencode/commands/init-project.md'), /\{\{PMC_BIN\}\} init-project/);
  assert.match(readTemplate('opencode/commands/retry-errors.md'), /\{\{PMC_BIN\}\} retry-errors(?:\s+--timeout\s+300000|\s+--concurrency\s+1\s+--timeout\s+300000)/);
  assert.match(readTemplate('opencode/commands/refresh-context.md'), /\{\{PMC_BIN\}\} refresh-context/);
  assert.match(readTemplate('opencode/commands/sanitize.md'), /\{\{PMC_BIN\}\} sanitize/);
  const syncContext = readTemplate('opencode/commands/sync-context.md');
  assert.match(syncContext, /\{\{PMC_BIN\}\} sync-context/);
  assert.doesNotMatch(syncContext, /agent-memory_store|agent-memory_update/);
  assert.doesNotMatch(syncContext, /upsert pending entries into `agent-memory`/);
  assert.doesNotMatch(syncContext, /Run the sync using `agent-memory` MCP tools\./);
  assert.match(readTemplate('opencode/commands/view-context.md'), /\{\{PMC_BIN\}\} view-context/);
});

test('agent snippets and setup docs do not reference copied local CLI paths', () => {
  const claude = readTemplate('claude-code/CLAUDE.md.snippet');
  const cursor = readTemplate('cursor/.cursorrules.snippet');
  const generic = readTemplate('generic/README-SETUP.md');
  const autostart = readTemplate('opencode/autostart-snippet.md');
  const antigravity = readTemplate('antigravity/autostart-snippet.md');

  assert.doesNotMatch(claude, /tools\/project-memory-context\/cli\/enrich-queue\.mjs/);
  assert.doesNotMatch(cursor, /tools\/project-memory-context\/cli\/enrich-queue\.mjs/);
  assert.doesNotMatch(generic, /tools\/project-memory-context\/cli\/enrich-queue\.mjs/);
  assert.doesNotMatch(autostart, /tools\/project-memory-context\/cli\/enrich-queue\.mjs/);
  assert.doesNotMatch(antigravity, /tools\/project-memory-context\/cli\/enrich-queue\.mjs/);

  assert.match(claude, /\{\{PMC_BIN\}\} map-project --all --enrich/);
  assert.match(claude, /\{\{PMC_BIN\}\} get-context <target> \[depth\] \[focus\]/);
  assert.match(claude, /\{\{PMC_BIN\}\} enrich-status/);
  assert.match(claude, /\{\{PMC_BIN\}\} init-project/);
  assert.match(claude, /\{\{PMC_BIN\}\} sync-context/);
  assert.match(claude, /\{\{PMC_BIN\}\} sanitize/);
  assert.match(claude, /\{\{PMC_BIN\}\} enrich \./);

  assert.match(cursor, /\{\{PMC_BIN\}\} map-project --all --enrich/);
  assert.match(cursor, /\{\{PMC_BIN\}\} get-context <target> \[depth\] \[focus\]/);
  assert.match(cursor, /\{\{PMC_BIN\}\} enrich-status/);
  assert.match(cursor, /\{\{PMC_BIN\}\} init-project/);
  assert.match(cursor, /\{\{PMC_BIN\}\} sync-context/);
  assert.match(cursor, /\{\{PMC_BIN\}\} sanitize/);
  assert.match(cursor, /\{\{PMC_BIN\}\} enrich \./);

  assert.match(generic, /\{\{PMC_BIN\}\} map-project --all --enrich/);
  assert.match(generic, /\{\{PMC_BIN\}\} enrich-status/);
  assert.match(generic, /\{\{PMC_BIN\}\} get-context --refresh/);
  assert.match(generic, /\{\{PMC_BIN\}\} sanitize/);
  assert.match(generic, /\{\{PMC_BIN\}\} sync-context/);

  // autostart-snippet uses session-start to handle enrich automatically — no explicit enrich . needed

  // antigravity autostart-snippet uses session-start — no explicit enrich-status command needed
  assert.match(antigravity, /\{\{PMC_BIN\}\} get-context/);
  assert.match(antigravity, /\{\{PMC_BIN\}\} refresh-context/);
  assert.match(antigravity, /\{\{PMC_BIN\}\} sync-context/);
});

test('enrich subagent templates reference pmc enrich and use correct frontmatter', () => {
  const claudeEnrich = readTemplate('claude-code/agents/enrich.md');
  const antigravityEnrich = readTemplate('antigravity/skills/enrich/SKILL.md');
  const opencodeEnrich = readTemplate('opencode/agent/enrich.md');

  // All three invoke pmc enrich
  assert.match(claudeEnrich, /\{\{PMC_BIN\}\} enrich \./);
  assert.match(antigravityEnrich, /\{\{PMC_BIN\}\} enrich \./);
  assert.match(opencodeEnrich, /\{\{PMC_BIN\}\} enrich \./);

  // Claude Code subagent frontmatter
  assert.match(claudeEnrich, /^name:\s*enrich/m);
  assert.match(claudeEnrich, /^tools:\s*Bash/m);

  // Antigravity skill frontmatter (Agent Skills Standard)
  assert.match(antigravityEnrich, /^name:\s*enrich/m);
  assert.match(antigravityEnrich, /^allowed-tools:/m);

  // OpenCode agent frontmatter
  assert.match(opencodeEnrich, /^name:\s*enrich/m);
  assert.match(opencodeEnrich, /^allowed-tools:/m);
});

test('README advertises the new agent-facing subcommands', () => {
  const readme = readFileSync(join(packageRoot, 'README.md'), 'utf8');

  assert.match(readme, /pmc map-project/);
  assert.match(readme, /pmc get-context/);
  assert.match(readme, /pmc enrich-status/);
  assert.match(readme, /pmc init-project/);
  assert.match(readme, /pmc sync-context/);
  assert.match(readme, /pmc enrich\b/);
  assert.doesNotMatch(readme, /### `pmc enrich` \/ `pmc enrich-queue`/);
  assert.doesNotMatch(readme, /pmc enrich-queue/);
  assert.match(readme, /pmc get-context \[target\] \[depth\] \[focus\]/);
  assert.match(readme, /pmc get-context \{symbol\|file\|query\} <target> \[depth\] \[focus\]/);
  assert.doesNotMatch(readme, /pmc get-context \[target\] \[--refresh\] \[--depth/);
  assert.doesNotMatch(readme, /### `pmc bootstrap`/);
  assert.doesNotMatch(readme, /### `pmc context`/);
  assert.doesNotMatch(readme, /### `pmc status`/);
  assert.doesNotMatch(readme, /### `pmc init`/);
});

test('README documents the exact 9 base project-context memory keys', () => {
  const readme = readFileSync(join(packageRoot, 'README.md'), 'utf8');

  for (const key of [
    'stack-runtime',
    'dependencies-summary',
    'integrations-summary',
    'architecture-current',
    'architecture-target',
    'structure-summary',
    'technical-rules',
    'project-requirements',
    'known-issues-and-fixes',
  ]) {
    assert.match(readme, new RegExp('`' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`'));
  }

  for (const removedKey of [
    'stack-dependencies',
    'structure-topology',
    'structure-entrypoints',
    'architecture-overview',
    'architecture-data-flow',
    'intake-goals',
    'intake-description',
  ]) {
    assert.doesNotMatch(readme, new RegExp('`' + removedKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`'));
  }
});

test('README environment variable docs match enrichment-config and setup-bootstrap behavior', () => {
  const readme = readFileSync(join(packageRoot, 'README.md'), 'utf8');

  assert.match(readme, /`PMC_LOCAL_MODEL_NAME`/);
  assert.doesNotMatch(readme, /`PMC_LOCAL_MODEL`/);
  assert.match(readme, /`PMC_GLOBAL_CONFIG`.*Override global config path/);
  assert.doesNotMatch(readme, /`PMC_GLOBAL_CONFIG`.*Override global config directory/);
  assert.doesNotMatch(readme, /pmc-local-model/);
  assert.match(readme, /agent-memory.*npx -y @aabadin\/agent-memory-mcp/);
});
