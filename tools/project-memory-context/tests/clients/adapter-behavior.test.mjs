import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAdapter, CLIENT_REGISTRY } from '../../src/clients/registry.mjs';

async function withTempProject(fn) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-adapter-project-'));
  const globalConfigDir = await mkdtemp(join(tmpdir(), 'pmc-adapter-global-'));
  try {
    await fn({ projectRoot, globalConfigDir });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(globalConfigDir, { recursive: true, force: true });
  }
}

test('Adapter Writers & Verifiers: OpenCode adapter invocation', async () => {
  await withTempProject(async ({ projectRoot, globalConfigDir }) => {
    const adapter = getAdapter('opencode');
    assert.ok(adapter);

    const context = {
      projectRoot,
      globalConfigDir,
      packageRoot: join(process.cwd(), 'tools', 'project-memory-context'),
      placeholders: { PMC_BIN: 'pmc', AGENT_MEMORY_CMD: 'npx', PROJECT_ROOT: projectRoot, CONFIG_DIR: '.pmc' },
      readTemplate: async (pkgRoot, tplPath) => '# Template\n',
    };

    assert.equal(await adapter.verifiers.mcp(context), false);
    assert.equal(await adapter.verifiers.instructions(context), false);
    assert.equal(await adapter.verifiers.hooks(context), false);

    await adapter.writers.mcp(context);
    await adapter.writers.instructions(context);
    await adapter.writers.skills(context);
    await adapter.writers.hooks(context);

    assert.equal(await adapter.verifiers.mcp(context), true);
    assert.equal(await adapter.verifiers.instructions(context), true);
    assert.equal(await adapter.verifiers.skills(context), true);
    assert.equal(await adapter.verifiers.hooks(context), true);
  });
});

test('Adapter Writers & Verifiers: Claude Code adapter invocation', async () => {
  await withTempProject(async ({ projectRoot, globalConfigDir }) => {
    const adapter = getAdapter('claude-code');
    assert.ok(adapter);

    const context = {
      projectRoot,
      globalConfigDir,
      packageRoot: join(process.cwd(), 'tools', 'project-memory-context'),
      placeholders: { PMC_BIN: 'pmc', AGENT_MEMORY_CMD: 'npx', PROJECT_ROOT: projectRoot, CONFIG_DIR: '.pmc' },
      readTemplate: async (pkgRoot, tplPath) => '# Template\n<!-- pmc:init -->\nsnippet\n<!-- /pmc:init -->\n',
    };

    assert.equal(await adapter.verifiers.instructions(context), false);

    await adapter.writers.instructions(context);
    await adapter.writers.skills(context);
    await adapter.writers.hooks(context);

    assert.equal(await adapter.verifiers.instructions(context), true);
    assert.equal(await adapter.verifiers.skills(context), true);
    assert.equal(await adapter.verifiers.hooks(context), true);
  });
});

test('Adapter Writers & Verifiers: Cursor adapter invocation', async () => {
  await withTempProject(async ({ projectRoot }) => {
    const adapter = getAdapter('cursor');
    assert.ok(adapter);

    const context = {
      projectRoot,
      packageRoot: join(process.cwd(), 'tools', 'project-memory-context'),
      placeholders: { PMC_BIN: 'pmc', AGENT_MEMORY_CMD: 'npx', PROJECT_ROOT: projectRoot, CONFIG_DIR: '.pmc' },
      readTemplate: async (pkgRoot, tplPath) => '# Snippet\n<!-- pmc:init -->\nsnippet\n<!-- /pmc:init -->\n',
    };

    assert.equal(await adapter.verifiers.instructions(context), false);

    await adapter.writers.instructions(context);

    assert.equal(await adapter.verifiers.instructions(context), true);
  });
});

test('Adapter Writers & Verifiers: Antigravity adapter invocation', async () => {
  await withTempProject(async ({ projectRoot, globalConfigDir }) => {
    const adapter = getAdapter('antigravity');
    assert.ok(adapter);

    const context = {
      projectRoot,
      globalConfigDir,
      packageRoot: join(process.cwd(), 'tools', 'project-memory-context'),
      placeholders: { PMC_BIN: 'pmc', AGENT_MEMORY_CMD: 'npx', PROJECT_ROOT: projectRoot, CONFIG_DIR: '.pmc' },
      readTemplate: async (pkgRoot, tplPath) => '# Skill\n',
    };

    assert.equal(await adapter.verifiers.instructions(context), false);
    assert.equal(await adapter.verifiers.skills(context), false);

    await adapter.writers.instructions(context);
    await adapter.writers.skills(context);

    assert.equal(await adapter.verifiers.instructions(context), true);
    assert.equal(await adapter.verifiers.skills(context), true);
  });
});

test('Adapter Writers & Verifiers: Generic adapter invocation', async () => {
  await withTempProject(async ({ projectRoot }) => {
    const adapter = getAdapter('generic');
    assert.ok(adapter);

    const context = {
      projectRoot,
      packageRoot: join(process.cwd(), 'tools', 'project-memory-context'),
      placeholders: { PMC_BIN: 'pmc', AGENT_MEMORY_CMD: 'npx', PROJECT_ROOT: projectRoot, CONFIG_DIR: '.pmc' },
      readTemplate: async (pkgRoot, tplPath) => '# Generic README\n<!-- pmc:generic -->\nbody\n<!-- /pmc:generic -->\n',
    };

    assert.equal(await adapter.verifiers.instructions(context), false);

    await adapter.writers.instructions(context);

    assert.equal(await adapter.verifiers.instructions(context), true);
  });
});
