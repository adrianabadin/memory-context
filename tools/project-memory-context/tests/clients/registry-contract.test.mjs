import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { validateRegistry, getAdapter } from '../../src/clients/registry.mjs';
import { PROBE_TABLE } from '../../src/clients/probes.mjs';
import { CLIENT_MARKERS } from '../../src/clients/markers.mjs';
import { validateAdapterContract } from '../../src/clients/adapter-contract.mjs';

function createValidAdapter(overrides = {}) {
  return {
    id: 'valid-client',
    legacyId: null,
    priority: 100,
    flags: ['--valid-client'],
    markers: { project: ['.valid'], instructionFiles: [] },
    paths: {
      projectConfig: (root) => join(root, '.valid', 'config.json'),
      globalConfig: (home) => join(home, '.valid', 'config.json'),
    },
    capabilities: {
      mcp: {
        supported: true,
        format: 'json',
        target: 'projectConfig',
        ownedKeys: ['mcpServers.pmc-query'],
      },
    },
    writers: { mcp: async () => {} },
    verifiers: { mcp: async () => {} },
    ...overrides,
  };
}

const contextRoots = {
  projectRoot: join(process.cwd(), 'project'),
  homeDir: join(process.cwd(), 'home'),
};

test('validateAdapterContract accepts fully valid adapter', () => {
  assert.equal(validateAdapterContract(createValidAdapter(), PROBE_TABLE, contextRoots), true);
});

test('validateAdapterContract rejects bad ID, non-integer priority, and missing writers/verifiers', () => {
  assert.throws(() => validateAdapterContract(createValidAdapter({ id: 'Invalid_Id' }), PROBE_TABLE, contextRoots), /Invalid adapter id/);
  assert.throws(() => validateAdapterContract(createValidAdapter({ priority: 10.5 }), PROBE_TABLE, contextRoots), /must be integer/);
  assert.throws(() => validateAdapterContract(createValidAdapter({ writers: {} }), PROBE_TABLE, contextRoots), /lacks a writer function/);
  assert.throws(() => validateAdapterContract(createValidAdapter({ verifiers: {} }), PROBE_TABLE, contextRoots), /lacks a verifier function/);
});

test('validateAdapterContract rejects version-gated capability with missing or unresolved probe', () => {
  const missingName = createValidAdapter({ capabilities: { hooks: { supported: 'version-gated', minVersion: '1.0.0' } }, writers: { mcp: async () => {}, hooks: async () => {} }, verifiers: { mcp: async () => {}, hooks: async () => {} } });
  assert.throws(() => validateAdapterContract(missingName, PROBE_TABLE, contextRoots), /missing probe name/);

  const unresolved = createValidAdapter({ capabilities: { hooks: { supported: 'version-gated', probe: 'missingProbe' } }, writers: { mcp: async () => {}, hooks: async () => {} }, verifiers: { mcp: async () => {}, hooks: async () => {} } });
  assert.throws(() => validateAdapterContract(unresolved, PROBE_TABLE, contextRoots), /not in probe table/);
});

test('validateAdapterContract ownedKeys PMC-namespaced validation (accepted & rejected cases)', () => {
  const acceptedCases = ['pmc-query', 'mcpServers.pmc-query', 'mcp_servers.pmc-agent-memory', 'sub.pmc.key'];
  for (const key of acceptedCases) {
    const a = createValidAdapter({ capabilities: { mcp: { supported: true, format: 'json', target: 'projectConfig', ownedKeys: [key] } } });
    assert.equal(validateAdapterContract(a, PROBE_TABLE, contextRoots), true, `Should accept valid key: ${key}`);
  }

  const rejectedCases = [[], ['unownedpmc-key'], ['foo.pmcish'], ['foo-pmc-bar']];
  for (const keys of rejectedCases) {
    const a = createValidAdapter({ capabilities: { mcp: { supported: true, format: 'json', target: 'projectConfig', ownedKeys: keys } } });
    assert.throws(() => validateAdapterContract(a, PROBE_TABLE, contextRoots), /ownedKeys non-empty and PMC-namespaced/, `Should reject invalid keys: ${JSON.stringify(keys)}`);
  }
});

test('validateAdapterContract project & home path traversal rejection', () => {
  const projectEscaped = createValidAdapter({ paths: { projectConfig: (root) => join(root, '..', 'escaped.json'), globalConfig: (home) => join(home, '.valid', 'config.json') } });
  assert.throws(() => validateAdapterContract(projectEscaped, PROBE_TABLE, contextRoots), /projectConfig path traversal/i);

  const homeEscaped = createValidAdapter({ paths: { projectConfig: (root) => join(root, '.valid', 'config.json'), globalConfig: (home) => join(home, '..', 'escaped.json') } });
  assert.throws(() => validateAdapterContract(homeEscaped, PROBE_TABLE, contextRoots), /globalConfig path traversal/i);
});

test('validateRegistry enforces duplicate checks and root presence on non-empty registries', () => {
  const a1 = createValidAdapter({ id: 'client-1', priority: 1, flags: ['--c1'] });
  const a2 = createValidAdapter({ id: 'client-2', priority: 2, flags: ['--c2'] });

  assert.equal(validateRegistry([], PROBE_TABLE), true, 'Empty registry validates without roots');
  assert.equal(validateRegistry([a1, a2], PROBE_TABLE, contextRoots), true);

  assert.throws(() => validateRegistry([a1], PROBE_TABLE, null), /requires complete contextRoots/i);
  assert.throws(() => validateRegistry([a1], PROBE_TABLE, { projectRoot: contextRoots.projectRoot }), /requires complete contextRoots/i);

  assert.throws(() => validateRegistry([a1, createValidAdapter({ id: 'client-1', priority: 3, flags: ['--c3'] })], PROBE_TABLE, contextRoots), /Duplicate adapter id/);
  assert.throws(() => validateRegistry([a1, createValidAdapter({ id: 'client-3', priority: 1, flags: ['--c4'] })], PROBE_TABLE, contextRoots), /Duplicate priority/);
  assert.throws(() => validateRegistry([a1, createValidAdapter({ id: 'client-4', priority: 4, flags: ['--c1'] })], PROBE_TABLE, contextRoots), /Duplicate flag/);
});

test('getAdapter helper resolves adapter by id or legacyId', () => {
  const a1 = createValidAdapter({ id: 'client-1', legacyId: 'legacy-1', priority: 1, flags: ['--c1'] });
  assert.equal(getAdapter('client-1', [a1]), a1);
  assert.equal(getAdapter('legacy-1', [a1]), a1);
  assert.equal(getAdapter('unknown', [a1]), null);
});

test('CLIENT_MARKERS exports all expected host markers with concrete structure', () => {
  assert.deepEqual(CLIENT_MARKERS.opencode, { project: ['.opencode'], instructionFiles: [] });
  assert.deepEqual(CLIENT_MARKERS['claude-code'], { project: ['.claude'], instructionFiles: ['CLAUDE.md'] });
  assert.deepEqual(CLIENT_MARKERS.cursor, { project: ['.cursor'], instructionFiles: ['.cursorrules'] });
  assert.deepEqual(CLIENT_MARKERS.antigravity, { project: ['.agents'], instructionFiles: [] });
  assert.deepEqual(CLIENT_MARKERS.generic, { project: [], instructionFiles: ['README-SETUP.md'] });
});

test('PROBE_TABLE exports all required version probe functions with exact return contracts', async () => {
  assert.equal(typeof PROBE_TABLE.codexVersion, 'function');
  assert.equal(typeof PROBE_TABLE.kimiVersion, 'function');
  assert.equal(typeof PROBE_TABLE.qwenVersion, 'function');

  assert.deepEqual(await PROBE_TABLE.codexVersion(), { status: 'skipped', reason: 'version-threshold-unverified' });
  assert.deepEqual(await PROBE_TABLE.kimiVersion(), { status: 'skipped', reason: 'version-threshold-unverified' });
  assert.deepEqual(await PROBE_TABLE.qwenVersion(), { status: 'skipped', reason: 'version-threshold-unverified' });
});
