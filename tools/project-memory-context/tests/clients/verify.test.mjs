import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { verifyInstallation } from '../../src/clients/verify.mjs';

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pmc-verify-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('verifyInstallation: maps "planned" capability + verifier true → installed', async () => {
  await withTemp(async (dir) => {
    const target = join(dir, 'mcp.json');
    await writeFile(target, '{"ok":true}\n', 'utf8');

    const plan = Object.freeze({
      planId: 'p1',
      projectRoot: dir,
      homeDir: dir,
      platform: process.platform,
      consent: { dependencies: true },
      clients: Object.freeze([Object.freeze({
        clientId: 'host',
        priority: 1, source: 'flag',
        capabilities: Object.freeze([Object.freeze({
          capability: 'mcp', status: 'planned', format: 'json', targetPath: target, ownedKeys: ['mcp.pmc'],
        })]),
      })]),
      companions: Object.freeze([]),
    });

    const execution = {
      planId: 'p1',
      clients: [
        { clientId: 'host', error: undefined, capabilities: [{ capability: 'mcp', status: 'installed', targetPath: target }] },
      ],
      companions: [],
    };

    const adapter = {
      id: 'host',
      capabilities: { mcp: { supported: true } },
      verifiers: { mcp: async ({ projectRoot }) => existsSync(join(projectRoot, 'mcp.json')) },
      writers: {},
    };

    const report = await verifyInstallation({ plan, execution, registry: [adapter] });
    assert.equal(report.clients.length, 1);
    const cap = report.clients[0].capabilities[0];
    assert.equal(cap.status, 'installed');
    assert.equal(cap.targetPath, target);
  });
});

test('verifyInstallation: maps unsupported capability → skipped (never fakes installed)', async () => {
  await withTemp(async (dir) => {
    const plan = Object.freeze({
      planId: 'p2',
      projectRoot: dir,
      homeDir: dir,
      platform: process.platform,
      consent: { dependencies: true },
      clients: Object.freeze([Object.freeze({
        clientId: 'host',
        priority: 1, source: 'flag',
        capabilities: Object.freeze([Object.freeze({
          capability: 'skills', status: 'skipped', reason: 'unsupported', format: undefined, targetPath: undefined, ownedKeys: undefined,
        })]),
      })]),
      companions: Object.freeze([]),
    });

    const execution = { planId: 'p2', clients: [{ clientId: 'host', capabilities: [{ capability: 'skills' }] }], companions: [] };
    const adapter = {
      id: 'host', capabilities: { skills: { supported: false } }, verifiers: { skills: async () => true }, writers: {},
    };
    const report = await verifyInstallation({ plan, execution, registry: [adapter] });
    const cap = report.clients[0].capabilities[0];
    assert.equal(cap.status, 'skipped');
    assert.equal(cap.reason, 'unsupported');
  });
});

test('verifyInstallation: planned write that does not produce a file fails with actionable reason', async () => {
  await withTemp(async (dir) => {
    const target = join(dir, 'missing.json');
    const plan = Object.freeze({
      planId: 'p3',
      projectRoot: dir,
      homeDir: dir,
      platform: process.platform,
      consent: { dependencies: true },
      clients: Object.freeze([Object.freeze({
        clientId: 'host', priority: 1, source: 'flag',
        capabilities: Object.freeze([Object.freeze({
          capability: 'mcp', status: 'planned', format: 'json', targetPath: target, ownedKeys: ['mcp.pmc'],
        })]),
      })]),
      companions: Object.freeze([]),
    });

    const execution = {
      planId: 'p3', clients: [
        { clientId: 'host', error: 'disk full', capabilities: [{ capability: 'mcp', status: 'failed', reason: 'disk full', targetPath: target }] },
      ], companions: [],
    };
    const adapter = { id: 'host', capabilities: { mcp: { supported: true } }, verifiers: { mcp: async () => false }, writers: {} };
    const report = await verifyInstallation({ plan, execution, registry: [adapter] });
    const cap = report.clients[0].capabilities[0];
    assert.equal(cap.status, 'failed');
    assert.match(cap.reason, /disk full|verifier/i);
  });
});

test('verifyInstallation: detects unchanged status when post-write content equals baseline', async () => {
  await withTemp(async (dir) => {
    const target = join(dir, 'idem.json');
    const baseline = '{"ok":true,"baseline":"x"}\n';
    await writeFile(target, baseline, 'utf8');

    const plan = Object.freeze({
      planId: 'p4', projectRoot: dir, homeDir: dir, platform: process.platform,
      consent: { dependencies: true },
      clients: Object.freeze([Object.freeze({
        clientId: 'host', priority: 1, source: 'flag',
        capabilities: Object.freeze([Object.freeze({
          capability: 'mcp', status: 'planned', format: 'json', targetPath: target, ownedKeys: ['mcp.pmc'],
        })]),
      })]),
      companions: Object.freeze([]),
    });
    const execution = {
      planId: 'p4', clients: [
        { clientId: 'host', capabilities: [{ capability: 'mcp', status: 'installed', targetPath: target }] },
      ], companions: [],
    };
    const adapter = {
      id: 'host', capabilities: { mcp: { supported: true } },
      verifiers: { mcp: async ({ projectRoot }) => existsSync(join(projectRoot, 'idem.json')) },
      writers: {},
    };

    const reportedReadFile = readFile;
    const observed = await readFile(target, 'utf8');
    const report = await verifyInstallation({ plan, execution, registry: [adapter], readFile: reportedReadFile, baselineProvider: async () => baseline });
    const cap = report.clients[0].capabilities[0];
    assert.equal(cap.status, 'unchanged');
  });
});
