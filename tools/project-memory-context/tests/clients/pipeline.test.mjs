import test from 'node:test';
import assert from 'node:assert/strict';

import { runPipeline } from '../../src/clients/pipeline.mjs';

test('pipeline: emits deterministic plan/execute/verify report and propagates failure', async () => {
  const stages = [];
  const fakeContext = {
    projectRoot: '/fake/project',
    homeDir: '/fake/home',
    packageRoot: '/fake/pkg',
    placeholders: { PMC_BIN: 'pmc', PROJECT_ROOT: '/fake/project', CONFIG_DIR: '.pmc' },
    readTemplate: async () => '# tmp\n',
    consent: { dependencies: false },
    registry: [
      {
        id: 'a', legacyId: null, priority: 10, flags: ['--a'],
        markers: { project: [], instructionFiles: [] },
        paths: { projectConfig: (root) => `${root}/a.json`, globalConfig: (home) => `${home}/.a` },
        capabilities: { mcp: { supported: true, format: 'json', target: 'projectConfig', ownedKeys: ['mcpServers.pmc-query'] } },
        writers: { mcp: async () => { stages.push('write-a'); } },
        verifiers: { mcp: async () => true },
      },
      {
        id: 'b', legacyId: null, priority: 20, flags: ['--b'],
        markers: { project: [], instructionFiles: [] },
        paths: { projectConfig: (root) => `${root}/b.json`, globalConfig: (home) => `${home}/.b` },
        capabilities: { mcp: { supported: true, format: 'json', target: 'projectConfig', ownedKeys: ['mcpServers.pmc-query'] } },
        writers: { mcp: async () => { throw new Error('boom'); } },
        verifiers: { mcp: async () => false },
      },
    ],
    selectedIds: ['a', 'b'],
  };

  const { report } = await runPipeline(fakeContext);
  assert.ok(stages.includes('write-a'));
  assert.equal(report.planId.length > 0, true);
  assert.deepEqual(report.clients.map((c) => c.clientId), ['a', 'b']);
  const a = report.clients[0].capabilities[0];
  const b = report.clients[1].capabilities[0];
  assert.equal(a.status, 'installed');
  assert.equal(b.status, 'failed');
  assert.equal(report.exitCode, 1);
});
