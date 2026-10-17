import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { executePlan } from '../../src/clients/execute.mjs';
import { CLIENT_REGISTRY } from '../../src/clients/registry.mjs';

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'pmc-exec-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('executePlan: writers run only for planned capabilities (dependency-denial leaves disk unchanged)', async () => {
  await withTemp(async (projectRoot) => {
    await mkdir(projectRoot, { recursive: true });
    const targetPath = join(projectRoot, '.deny', 'config.json');
    assert.equal(existsSync(targetPath), false);

    const fakeAdapter = {
      id: 'deny-host',
      priority: 1,
      flags: ['--deny-host'],
      markers: { project: [], instructionFiles: [] },
      paths: {
        projectConfig: (root) => join(root, '.deny', 'config.json'),
        globalConfig: (home) => join(home, '.deny'),
      },
      capabilities: {
        mcp: {
          supported: true,
          format: 'json',
          target: 'projectConfig',
          requiresDependency: true,
          ownedKeys: ['mcpServers.pmc-query'],
        },
      },
      writers: {
        mcp: async ({ projectRoot: pr }) => {
          await writeFile(join(pr, '.deny', 'config.json'), '{"written":true}\n', 'utf8');
        },
      },
      verifiers: { mcp: async () => false },
    };

    const plan = Object.freeze({
      planId: 'plan-test',
      projectRoot,
      homeDir: projectRoot,
      platform: process.platform,
      consent: { dependencies: false },
      clients: Object.freeze([Object.freeze({
        clientId: 'deny-host',
        priority: 1,
        source: 'flag',
        capabilities: Object.freeze([Object.freeze({
          capability: 'mcp',
          status: 'skipped',
          reason: 'dependency-consent-denied',
          format: 'json',
          targetPath,
          ownedKeys: ['mcpServers.pmc-query'],
        })]),
      })]),
      companions: Object.freeze([]),
    });

    const result = await executePlan({ plan, registry: [fakeAdapter], adapterOverride: { 'deny-host': fakeAdapter } });

    assert.equal(existsSync(targetPath), false, 'denial must leave the disk untouched');
    assert.equal(result.clients.length, 1);
    assert.equal(result.clients[0].clientId, 'deny-host');
    assert.equal(result.clients[0].error, undefined);
  });
});

test('executePlan: per-client failure isolation — one writer throwing does not block other clients', async () => {
  await withTemp(async (projectRoot) => {
    await mkdir(projectRoot, { recursive: true });
    const goodTarget = join(projectRoot, 'good.json');

    const goodAdapter = {
      id: 'good',
      priority: 10,
      flags: ['--good'],
      markers: { project: [], instructionFiles: [] },
      paths: { projectConfig: (root) => join(root, 'good.json'), globalConfig: (home) => join(home, 'good') },
      capabilities: {
        mcp: { supported: true, format: 'json', target: 'projectConfig', ownedKeys: ['mcp.pmc'] },
      },
      writers: { mcp: async ({ projectRoot: pr }) => writeFile(join(pr, 'good.json'), '{"ok":true}\n', 'utf8') },
      verifiers: { mcp: async () => false },
    };

    const badAdapter = {
      id: 'bad',
      priority: 20,
      flags: ['--bad'],
      markers: { project: [], instructionFiles: [] },
      paths: { projectConfig: (root) => join(root, 'bad.json'), globalConfig: (home) => join(home, 'bad') },
      capabilities: {
        mcp: { supported: true, format: 'json', target: 'projectConfig', ownedKeys: ['mcp.pmc'] },
      },
      writers: { mcp: async () => { throw new Error('boom'); } },
      verifiers: { mcp: async () => false },
    };

    const plan = Object.freeze({
      planId: 'plan-iso',
      projectRoot,
      homeDir: projectRoot,
      platform: process.platform,
      consent: { dependencies: true },
      clients: Object.freeze([
        Object.freeze({
          clientId: 'bad', priority: 20, source: 'flag',
          capabilities: Object.freeze([Object.freeze({
            capability: 'mcp', status: 'planned', format: 'json', targetPath: join(projectRoot, 'bad.json'), ownedKeys: ['mcp.pmc'],
          })]),
        }),
        Object.freeze({
          clientId: 'good', priority: 10, source: 'flag',
          capabilities: Object.freeze([Object.freeze({
            capability: 'mcp', status: 'planned', format: 'json', targetPath: goodTarget, ownedKeys: ['mcp.pmc'],
          })]),
        }),
      ]),
      companions: Object.freeze([]),
    });

    const result = await executePlan({ plan, registry: [badAdapter, goodAdapter], adapterOverride: { bad: badAdapter, good: goodAdapter } });

    const byClient = Object.fromEntries(result.clients.map((c) => [c.clientId, c]));
    assert.ok(byClient.bad.error, 'bad client should record error');
    assert.equal(byClient.bad.error.includes('boom'), true);
    assert.equal(byClient.good.error, undefined, 'good client should succeed despite bad client failure');
    assert.equal(existsSync(goodTarget), true, 'good client disk write must complete');

    const written = JSON.parse(await readFile(goodTarget, 'utf8'));
    assert.equal(written.ok, true);
  });
});

test('executePlan: write attempts use atomic primitive via temp+rename (no partial writes)', async () => {
  await withTemp(async (projectRoot) => {
    const target = join(projectRoot, 'atomic.json');
    let renameCount = 0;

    const adapter = {
      id: 'atomic-host',
      priority: 5,
      flags: ['--atomic-host'],
      markers: { project: [], instructionFiles: [] },
      paths: { projectConfig: (root) => join(root, 'atomic.json'), globalConfig: (home) => join(home, 'atomic') },
      capabilities: { mcp: { supported: true, format: 'json', target: 'projectConfig', ownedKeys: ['mcp.pmc'] } },
      writers: {
        mcp: async ({ atomicWrite }) => {
          renameCount += 1;
          await atomicWrite(target, '{\n  "atomic": true\n}\n');
        },
      },
      verifiers: { mcp: async () => false },
    };

    const plan = Object.freeze({
      planId: 'plan-atomic',
      projectRoot,
      homeDir: projectRoot,
      platform: process.platform,
      consent: { dependencies: true },
      clients: Object.freeze([Object.freeze({
        clientId: 'atomic-host', priority: 5, source: 'flag',
        capabilities: Object.freeze([Object.freeze({
          capability: 'mcp', status: 'planned', format: 'json', targetPath: target, ownedKeys: ['mcp.pmc'],
        })]),
      })]),
      companions: Object.freeze([]),
    });

    const result = await executePlan({
      plan,
      registry: [adapter],
      adapterOverride: { 'atomic-host': adapter },
    });

    assert.equal(renameCount, 1);
    assert.equal(result.clients[0].error, undefined);
    assert.equal(existsSync(target), true);
  });
});
