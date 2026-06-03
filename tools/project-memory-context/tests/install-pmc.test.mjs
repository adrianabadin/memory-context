import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { installPmcTools } from '../cli/install-pmc.mjs';
import { buildInjectedPmcConfig } from '../src/plugin-config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, '..');

test('installPmcTools creates planning state without copying runtime code', () => {
  const sourceRoot = packageRoot;
  const targetDir = mkdtempSync(join(tmpdir(), 'pmc-test-'));

  try {
    installPmcTools({ sourceRoot, targetRoot: targetDir });

    assert.equal(existsSync(join(targetDir, 'tools', 'project-memory-context')), false);
    assert.equal(existsSync(join(targetDir, 'tools', 'project-memory-context', 'cli', 'enrich-queue.mjs')), false);
    assert.equal(existsSync(join(targetDir, 'tools', 'project-memory-context', 'src', 'enrichment-driver.mjs')), false);
    assert.equal(existsSync(join(targetDir, 'tools', 'project-memory-context', 'mcp', 'pmc-query-server.mjs')), false);
    assert.equal(existsSync(join(targetDir, 'tools', 'project-memory-context', 'plugin', 'index.mjs')), false);
    assert.equal(existsSync(join(targetDir, 'tools', 'project-memory-context', 'package.json')), false);

    assert.ok(existsSync(join(targetDir, '.planning', 'project-memory-context', 'enrichment')));
    assert.ok(existsSync(join(targetDir, '.planning', 'project-memory-context', 'graph')));
    assert.ok(existsSync(join(targetDir, '.planning', 'project-memory-context', 'intake')));
    assert.ok(existsSync(join(targetDir, '.planning', 'project-memory-context', 'memory-db')));
    assert.ok(existsSync(join(targetDir, '.planning', 'project-memory-context', 'db')));

    const state = JSON.parse(readFileSync(join(targetDir, '.planning', 'project-memory-context', 'install.json'), 'utf8'));
    assert.ok(state.installedAt);
    assert.equal(state.version, '0.1.0');
    assert.ok(state.sourceRoot);
    assert.equal(state.projectRoot, targetDir);
    assert.equal(state.memoryDbPath, join(targetDir, '.planning', 'project-memory-context', 'memory-db'));

    const injected = buildInjectedPmcConfig({ installState: state });
    assert.equal(
      injected.mcp['pmc-agent-memory'].environment.MEMORY_DB_PATH,
      join(targetDir, '.planning', 'project-memory-context', 'memory-db'),
    );

  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});

test('installPmcTools returns file counts', () => {
  const sourceRoot = packageRoot;
  const targetDir = mkdtempSync(join(tmpdir(), 'pmc-test-'));

  try {
    const result = installPmcTools({ sourceRoot, targetRoot: targetDir });
    assert.equal(result.cliFiles, 0);
    assert.equal(result.srcFiles, 0);
    assert.equal(result.templateFiles, 0);
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
  }
});
