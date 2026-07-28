import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { runInstallPmcPipeline } from '../../cli/install-pmc.mjs';
import { runSetupPipeline, parseArgs, AGENT_FLAGS } from '../../cli/setup.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(__dirname, '..', '..');

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pmc-cli-shared-'));
  try {
    await mkdir(dir, { recursive: true });
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test('runInstallPmcPipeline (cli/install-pmc.mjs) executes the shared pipeline and returns InstallReport', async () => {
  await withTempDir(async (targetRoot) => {
    const { report, detection } = await runInstallPmcPipeline({
      targetRoot,
      sourceRoot: PACKAGE_ROOT,
      consent: { dependencies: false },
    });

    assert.ok(report && typeof report === 'object', 'must return a report object');
    assert.match(report.planId, UUID_RE, 'planId must be a UUID produced by the shared pipeline');
    assert.ok(Array.isArray(report.clients), 'report.clients must be an array');
    assert.ok(['number'].includes(typeof report.exitCode), 'exitCode must be a number');
    assert.ok(Array.isArray(report.companions), 'report.companions must be an array');

    assert.ok(detection && typeof detection.source === 'string', 'detection must include source');
    assert.ok(Array.isArray(detection.clientIds), 'detection.clientIds must be an array');

    assert.ok(existsSync(join(targetRoot, '.planning', 'project-memory-context', 'install.json')),
      'legacy public install.json artifact must still be created');

    // No leaked writes: every recorded capability targetPath must stay within the projectRoot
    for (const client of report.clients) {
      for (const cap of client.capabilities) {
        if (typeof cap.targetPath === 'string') {
          assert.ok(
            cap.targetPath.startsWith(targetRoot) || cap.targetPath === 'README-SETUP.md',
            `capability ${cap.capability} targetPath must stay inside targetRoot (got ${cap.targetPath})`,
          );
        }
      }
    }
  });
});

test('runSetupPipeline (cli/setup.mjs) executes the shared pipeline and returns InstallReport', async () => {
  await withTempDir(async (cwd) => {
    const { report, detection } = await runSetupPipeline({
      cwd,
      packageRoot: PACKAGE_ROOT,
      requestedAgents: [],
    });

    assert.ok(report && typeof report === 'object', 'must return a report object');
    assert.match(report.planId, UUID_RE, 'planId must be a UUID produced by the shared pipeline');
    assert.ok(Array.isArray(report.clients), 'report.clients must be an array');
    assert.ok(['number'].includes(typeof report.exitCode), 'exitCode must be a number');
    assert.ok(Array.isArray(report.companions), 'report.companions must be an array');

    assert.ok(detection && typeof detection.source === 'string', 'detection must include source');
    assert.ok(Array.isArray(detection.clientIds), 'detection.clientIds must be an array');

    for (const client of report.clients) {
      for (const cap of client.capabilities) {
        if (typeof cap.targetPath === 'string') {
          assert.ok(
            cap.targetPath.startsWith(cwd) || cap.targetPath === 'README-SETUP.md',
            `capability ${cap.capability} targetPath must stay inside cwd (got ${cap.targetPath})`,
          );
        }
      }
    }
  });
});

test('Both CLIs delegate to the same shared pipeline (structural equivalence of reports)', async () => {
  await withTempDir(async (sharedTempRoot) => {
    const installTarget = join(sharedTempRoot, 'install');
    const setupTarget = join(sharedTempRoot, 'setup');
    await mkdir(installTarget, { recursive: true });
    await mkdir(setupTarget, { recursive: true });

    const installResult = await runInstallPmcPipeline({
      targetRoot: installTarget,
      sourceRoot: PACKAGE_ROOT,
      consent: { dependencies: false },
    });
    const setupResult = await runSetupPipeline({
      cwd: setupTarget,
      packageRoot: PACKAGE_ROOT,
      requestedAgents: [],
    });

    assert.deepEqual(
      Object.keys(installResult.report).sort(),
      Object.keys(setupResult.report).sort(),
      'top-level report shape must match between CLIs',
    );

    const installClient = installResult.report.clients[0];
    const setupClient = setupResult.report.clients[0];
    assert.ok(installClient, 'install report must contain at least one client');
    assert.ok(setupClient, 'setup report must contain at least one client');

    assert.deepEqual(
      Object.keys(installClient).sort(),
      Object.keys(setupClient).sort(),
      'client shape must match between CLIs',
    );
    const installCap = installClient.capabilities[0];
    const setupCap = setupClient.capabilities[0];
    assert.ok(installCap && setupCap, 'each client must contain at least one capability');
    assert.deepEqual(
      Object.keys(installCap).sort(),
      Object.keys(setupCap).sort(),
      'capability shape must match between CLIs',
    );

    assert.equal(
      installResult.detection.clientIds.slice().sort().join(','),
      setupResult.detection.clientIds.slice().sort().join(','),
      'detected clients must be identical for identical inputs',
    );
    assert.equal(installResult.report.exitCode, setupResult.report.exitCode,
      'exitCode must be identical for identical registry inputs');
  });
});

test('Legacy public exports preserved (parseArgs + AGENT_FLAGS mapping)', () => {
  const parsed = parseArgs(['--opencode', '--claude']);
  assert.deepEqual(parsed.agents.slice().sort(), ['claude-code', 'opencode']);

  assert.equal(AGENT_FLAGS['--claude'], 'claude-code');
  assert.equal(AGENT_FLAGS['--opencode'], 'opencode');
  assert.equal(AGENT_FLAGS['--cursor'], 'cursor');
  assert.equal(AGENT_FLAGS['--antigravity'], 'antigravity');
  assert.equal(AGENT_FLAGS['--generic'], 'generic');

  assert.deepEqual(parseArgs([]), { agents: [] });
});
