import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { installAgentTemplates } from '../../src/template-installer.mjs';
import { detectAgentType } from '../../src/platform.mjs';

const goldenData = JSON.parse(
  await readFile(
    new URL('../fixtures/clients/golden-baseline/legacy-golden-trees.json', import.meta.url),
    'utf8'
  )
);

assert.equal(
  goldenData.provenance.baselineCommit,
  'd056323f93bf012dfe6f555cb0d83882f7e6b915',
  'Golden baseline must match commit d056323f93bf012dfe6f555cb0d83882f7e6b915'
);

function normalizeObjectKeys(obj) {
  const normalized = {};
  for (const [key, value] of Object.entries(obj)) {
    const normKey = key.replace(/\\/g, '/');
    normalized[normKey] = value;
  }
  return normalized;
}

async function collectFiles(dir) {
  if (!existsSync(dir)) return {};
  const entries = await readdirRecursive(dir);
  const result = {};
  for (const fullPath of entries) {
    const relPath = relative(dir, fullPath).replace(/\\/g, '/');
    const content = await readFile(fullPath, 'utf8');
    result[relPath] = content;
  }
  return result;
}

async function readdirRecursive(dir) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      files.push(join(entry.parentPath || entry.path, entry.name));
    }
  }
  return files;
}

async function withTempProject(fn) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-golden-project-'));
  const globalConfigDir = await mkdtemp(join(tmpdir(), 'pmc-golden-global-'));
  try {
    await fn({ projectRoot, globalConfigDir });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(globalConfigDir, { recursive: true, force: true });
  }
}

function normalizeJsonString(str) {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

function sanitizeSemanticContent(str) {
  // Normalize Windows backslashes, package import paths, and dynamic temp paths
  return str
    .replace(/\r\n/g, '\n')
    .replace(/\\\\/g, '/')
    .replace(/file:\/\/\/[A-Za-z]:\/[^\s'"]+\/tools\/project-memory-context/g, 'file:///PACKAGE_ROOT_FIXTURE/tools/project-memory-context')
    .replace(/pmc-golden-project-[A-Za-z0-9]+/g, 'PROJECT_ROOT_FIXTURE')
    .replace(/golden-proj-[A-Za-z0-9]+/g, 'PROJECT_ROOT_FIXTURE')
    .replace(/pmc-golden-global-[A-Za-z0-9]+/g, 'GLOBAL_CONFIG_FIXTURE')
    .replace(/golden-glob-[A-Za-z0-9]+/g, 'GLOBAL_CONFIG_FIXTURE')
    .trim();
}

function assertTreeMatchesGolden(actualTree, rawGoldenTree) {
  const goldenTree = normalizeObjectKeys(rawGoldenTree);
  const actualKeys = Object.keys(actualTree).sort();
  const goldenKeys = Object.keys(goldenTree).sort();

  assert.deepEqual(
    actualKeys,
    goldenKeys,
    `Installed directory structure must match static legacy golden tree.\nExpected: ${goldenKeys}\nActual: ${actualKeys}`
  );

  for (const key of goldenKeys) {
    const actualContent = actualTree[key];
    const goldenContent = goldenTree[key];

    if (key.endsWith('.json')) {
      assert.equal(
        sanitizeSemanticContent(normalizeJsonString(actualContent)),
        sanitizeSemanticContent(normalizeJsonString(goldenContent)),
        `Content of JSON file ${key} must match static legacy golden fixture`
      );
    } else {
      // For instruction files with block markers, extract the marker block content and compare semantically
      const sanActual = sanitizeSemanticContent(actualContent);
      const sanGolden = sanitizeSemanticContent(goldenContent);

      const blockRegex = /<!-- pmc:(\w+) -->([\s\S]*?)<!-- \/pmc:\1 -->/;
      const matchActual = sanActual.match(blockRegex);
      const matchGolden = sanGolden.match(blockRegex);

      if (matchActual && matchGolden) {
        assert.equal(
          matchActual[1],
          matchGolden[1],
          `Marker name for ${key} must match golden fixture`
        );
        const cleanActual = matchActual[2].replace(/^# PMC Commands/m, '').trim();
        const cleanGolden = matchGolden[2].replace(/^# PMC Commands/m, '').trim();
        assert.equal(
          cleanActual,
          cleanGolden,
          `Block content inside marker for ${key} must match static legacy golden fixture`
        );
      } else {
        assert.equal(
          sanActual,
          sanGolden,
          `Content of text file ${key} must match static legacy golden fixture`
        );
      }
    }
  }
}

test('Golden Baseline (Static): OpenCode legacy host installation & exact tree parity', async () => {
  await withTempProject(async ({ projectRoot, globalConfigDir }) => {
    await mkdir(join(projectRoot, '.opencode'));

    assert.equal(detectAgentType(projectRoot), 'opencode');

    await installAgentTemplates({ projectRoot, agent: 'opencode', globalConfigDir });

    const actualProjectFiles = await collectFiles(projectRoot);
    const actualGlobalFiles = await collectFiles(globalConfigDir);

    const expected = goldenData.goldens.opencode;

    assertTreeMatchesGolden(actualProjectFiles, expected.projectFiles);
    assertTreeMatchesGolden(actualGlobalFiles, expected.globalFiles);

    // Idempotency: second run produces zero diff
    await installAgentTemplates({ projectRoot, agent: 'opencode', globalConfigDir });
    const rerunProjectFiles = await collectFiles(projectRoot);
    const rerunGlobalFiles = await collectFiles(globalConfigDir);

    assertTreeMatchesGolden(rerunProjectFiles, expected.projectFiles);
    assertTreeMatchesGolden(rerunGlobalFiles, expected.globalFiles);
  });
});

test('Golden Baseline (Static): Claude Code legacy host installation & exact tree parity', async () => {
  await withTempProject(async ({ projectRoot, globalConfigDir }) => {
    await mkdir(join(projectRoot, '.claude'));

    assert.equal(detectAgentType(projectRoot), 'claude-code');

    await installAgentTemplates({ projectRoot, agent: 'claude-code', globalConfigDir });

    const actualProjectFiles = await collectFiles(projectRoot);
    const actualGlobalFiles = await collectFiles(globalConfigDir);

    const expected = goldenData.goldens['claude-code'];

    assertTreeMatchesGolden(actualProjectFiles, expected.projectFiles);
    assertTreeMatchesGolden(actualGlobalFiles, expected.globalFiles);

    // Idempotency: second run produces zero diff
    await installAgentTemplates({ projectRoot, agent: 'claude-code', globalConfigDir });
    const rerunProjectFiles = await collectFiles(projectRoot);
    const rerunGlobalFiles = await collectFiles(globalConfigDir);

    assertTreeMatchesGolden(rerunProjectFiles, expected.projectFiles);
    assertTreeMatchesGolden(rerunGlobalFiles, expected.globalFiles);
  });
});

test('Golden Baseline (Static): Cursor legacy host installation & exact tree parity', async () => {
  await withTempProject(async ({ projectRoot }) => {
    await mkdir(join(projectRoot, '.cursor'));

    assert.equal(detectAgentType(projectRoot), 'cursor');

    await installAgentTemplates({ projectRoot, agent: 'cursor' });

    const actualProjectFiles = await collectFiles(projectRoot);
    const expected = goldenData.goldens.cursor;

    assertTreeMatchesGolden(actualProjectFiles, expected.projectFiles);

    // Idempotency: second run produces zero diff
    await installAgentTemplates({ projectRoot, agent: 'cursor' });
    const rerunProjectFiles = await collectFiles(projectRoot);

    assertTreeMatchesGolden(rerunProjectFiles, expected.projectFiles);
  });
});

test('Golden Baseline (Static): Antigravity legacy host installation & exact tree parity', async () => {
  await withTempProject(async ({ projectRoot, globalConfigDir }) => {
    await mkdir(join(projectRoot, '.agents'));

    assert.equal(detectAgentType(projectRoot), 'antigravity');

    await installAgentTemplates({ projectRoot, agent: 'antigravity', globalConfigDir });

    const actualProjectFiles = await collectFiles(projectRoot);
    const actualGlobalFiles = await collectFiles(globalConfigDir);

    const expected = goldenData.goldens.antigravity;

    assertTreeMatchesGolden(actualProjectFiles, expected.projectFiles);
    assertTreeMatchesGolden(actualGlobalFiles, expected.globalFiles);

    // Idempotency: second run produces zero diff
    await installAgentTemplates({ projectRoot, agent: 'antigravity', globalConfigDir });
    const rerunProjectFiles = await collectFiles(projectRoot);
    const rerunGlobalFiles = await collectFiles(globalConfigDir);

    assertTreeMatchesGolden(rerunProjectFiles, expected.projectFiles);
    assertTreeMatchesGolden(rerunGlobalFiles, expected.globalFiles);
  });
});

test('Golden Baseline (Static): Generic legacy host installation & exact tree parity', async () => {
  await withTempProject(async ({ projectRoot }) => {
    assert.equal(detectAgentType(projectRoot), 'generic');

    await installAgentTemplates({ projectRoot, agent: 'generic' });

    const actualProjectFiles = await collectFiles(projectRoot);
    const expected = goldenData.goldens.generic;

    assertTreeMatchesGolden(actualProjectFiles, expected.projectFiles);

    // Idempotency: second run produces zero diff
    await installAgentTemplates({ projectRoot, agent: 'generic' });
    const rerunProjectFiles = await collectFiles(projectRoot);

    assertTreeMatchesGolden(rerunProjectFiles, expected.projectFiles);
  });
});

test('Safety: Unrelated pre-existing JSON, Markdown, and config files survive installation', async () => {
  await withTempProject(async ({ projectRoot, globalConfigDir }) => {
    await mkdir(join(projectRoot, '.opencode'));

    // Create pre-existing unrelated files
    const customJson = { customSetting: 'customValue', mcp: { externalServer: { command: 'node' } } };
    await writeFile(join(projectRoot, '.opencode', 'opencode.json'), JSON.stringify(customJson, null, 2), 'utf8');

    const preExistingAgentsMd = '# Pre-existing AGENTS.md\n\n- Custom rule 1\n- Custom rule 2\n';
    await writeFile(join(projectRoot, 'AGENTS.md'), preExistingAgentsMd, 'utf8');

    const unrelatedJsonPath = join(projectRoot, 'unrelated.json');
    await writeFile(unrelatedJsonPath, JSON.stringify({ keepMe: true }), 'utf8');

    await installAgentTemplates({ projectRoot, agent: 'opencode', globalConfigDir });

    // Verify unrelated content survived
    const updatedAgentsMd = await readFile(join(projectRoot, 'AGENTS.md'), 'utf8');
    assert.ok(updatedAgentsMd.includes('# Pre-existing AGENTS.md'));
    assert.ok(updatedAgentsMd.includes('- Custom rule 1'));
    assert.ok(updatedAgentsMd.includes('<!-- pmc:autostart -->'));

    const updatedOpencodeJson = JSON.parse(await readFile(join(projectRoot, '.opencode', 'opencode.json'), 'utf8'));
    assert.equal(updatedOpencodeJson.customSetting, 'customValue');
    assert.ok(updatedOpencodeJson.mcp.externalServer);
    assert.ok(updatedOpencodeJson.mcp['pmc-query']);

    const unrelatedJson = JSON.parse(await readFile(unrelatedJsonPath, 'utf8'));
    assert.equal(unrelatedJson.keepMe, true);
  });
});

test('Safety: Rollback / failure behavior on bad parameters or missing required options', async () => {
  await withTempProject(async ({ projectRoot }) => {
    // Calling opencode without globalConfigDir must fail cleanly
    await assert.rejects(
      async () => {
        await installAgentTemplates({ projectRoot, agent: 'opencode' });
      },
      {
        name: 'Error',
        message: 'globalConfigDir is required for agent: opencode',
      }
    );

    // Calling unsupported agent must fail cleanly
    await assert.rejects(
      async () => {
        await installAgentTemplates({ projectRoot, agent: 'nonexistent-host' });
      },
      {
        name: 'Error',
        message: /Unsupported agent type: nonexistent-host/,
      }
    );
  });
});
