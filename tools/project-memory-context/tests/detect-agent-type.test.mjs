import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectAgentType } from '../src/platform.mjs';

async function withTempProject(fn) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-agent-detect-'));
  try {
    await fn(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

test('detectAgentType detects opencode from .opencode directory', async () => {
  await withTempProject(async (projectRoot) => {
    await mkdir(join(projectRoot, '.opencode'));
    assert.equal(detectAgentType(projectRoot), 'opencode');
  });
});

test('detectAgentType detects claude-code from CLAUDE.md', async () => {
  await withTempProject(async (projectRoot) => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), '# Claude\n', 'utf8');
    assert.equal(detectAgentType(projectRoot), 'claude-code');
  });
});

test('detectAgentType detects claude-code from .claude directory', async () => {
  await withTempProject(async (projectRoot) => {
    await mkdir(join(projectRoot, '.claude'));
    assert.equal(detectAgentType(projectRoot), 'claude-code');
  });
});

test('detectAgentType detects cursor from .cursorrules', async () => {
  await withTempProject(async (projectRoot) => {
    await writeFile(join(projectRoot, '.cursorrules'), 'rules\n', 'utf8');
    assert.equal(detectAgentType(projectRoot), 'cursor');
  });
});

test('detectAgentType detects cursor from .cursor directory', async () => {
  await withTempProject(async (projectRoot) => {
    await mkdir(join(projectRoot, '.cursor'));
    assert.equal(detectAgentType(projectRoot), 'cursor');
  });
});

test('detectAgentType detects antigravity from .agents directory', async () => {
  await withTempProject(async (projectRoot) => {
    await mkdir(join(projectRoot, '.agents'));
    assert.equal(detectAgentType(projectRoot), 'antigravity');
  });
});

test('detectAgentType returns generic when no markers exist', async () => {
  await withTempProject(async (projectRoot) => {
    assert.equal(detectAgentType(projectRoot), 'generic');
  });
});
