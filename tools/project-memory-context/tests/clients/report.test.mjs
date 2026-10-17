import test from 'node:test';
import assert from 'node:assert/strict';

import { formatInstallReport } from '../../src/clients/report.mjs';

test('formatInstallReport: stable JSON schema includes clients, capabilities, exitCode, companions', () => {
  const report = Object.freeze({
    planId: 'plan-1',
    clients: Object.freeze([
      Object.freeze({
        clientId: 'host-a',
        error: undefined,
        capabilities: Object.freeze([Object.freeze({
          capability: 'mcp', status: 'installed', reason: undefined, targetPath: '/x.json', ownedKeys: ['mcpServers.pmc-query'],
        })]),
      }),
    ]),
    companions: Object.freeze([]),
    exitCode: 0,
  });
  const json = formatInstallReport(report, { jsonMode: true });
  const parsed = JSON.parse(json);
  assert.deepEqual(Object.keys(parsed).sort(), ['clients', 'companions', 'exitCode', 'planId']);
  assert.deepEqual(parsed.clients[0].capabilities[0].status, 'installed');
});

test('formatInstallReport: human-readable output lists clients/capabilities', () => {
  const report = {
    planId: 'plan-2',
    clients: [{ clientId: 'host-b', capabilities: [{ capability: 'instructions', status: 'skipped', reason: 'unsupported', targetPath: undefined, ownedKeys: undefined }] }],
    companions: [],
    exitCode: 0,
  };
  const text = formatInstallReport(report, { jsonMode: false });
  assert.match(text, /host-b/);
  assert.match(text, /instructions.*skipped.*unsupported/);
});
