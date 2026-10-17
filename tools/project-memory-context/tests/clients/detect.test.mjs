import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { selectClients } from '../../src/clients/detect.mjs';
import { CLIENT_REGISTRY } from '../../src/clients/registry.mjs';

const PROJECT = join(process.cwd(), 'fake-project');

function makeFs(map) {
  return (p) => Boolean(map.has(p));
}

function registry() {
  // Stable snapshot for deterministic test assertions
  return CLIENT_REGISTRY.map((a) => ({ id: a.id, priority: a.priority, markers: a.markers, legacyId: a.legacyId, flags: a.flags }));
}

test('selectClients: empty detection returns generic fallback', () => {
  const result = selectClients({ projectRoot: PROJECT, registry: registry(), exists: makeFs(new Map()) });
  assert.deepEqual(result, { source: 'detected', clientIds: ['generic'] });
});

test('selectClients: prioritizes adapters by priority when multiple markers exist', () => {
  // opencode.priority=10, claude-code.priority=20, antigravity.priority=40
  const fs = makeFs(new Set([join(PROJECT, '.opencode'), join(PROJECT, '.claude'), join(PROJECT, '.agents')]));
  const result = selectClients({ projectRoot: PROJECT, registry: registry(), exists: fs });
  assert.equal(result.source, 'detected');
  assert.deepEqual(result.clientIds, ['opencode', 'claude-code', 'antigravity']);
});

test('selectClients: explicit flags win over detection and are deduped + priority-ordered', () => {
  const fs = makeFs(new Set([join(PROJECT, '.opencode'), join(PROJECT, '.claude')]));
  const result = selectClients({
    projectRoot: PROJECT,
    registry: registry(),
    exists: fs,
    flags: ['--cursor'], // priority 30
    csvClients: ['claude-code', 'opencode'], // priorities 20 and 10
  });
  assert.equal(result.source, 'flag');
  // Should include cursor and the requested clients, deduped, ordered by priority
  assert.deepEqual(result.clientIds, ['opencode', 'claude-code', 'cursor']);
});

test('selectClients: empty explicit + no detected markers falls back to generic', () => {
  const fs = makeFs(new Set());
  const result = selectClients({
    projectRoot: PROJECT,
    registry: registry(),
    exists: fs,
    flags: ['--antigravity'],
  });
  assert.equal(result.source, 'flag');
  assert.deepEqual(result.clientIds, ['antigravity']);
});

test('selectClients: absent markers never select a client (no home fallback in detect)', () => {
  const fs = makeFs(new Set());
  const result = selectClients({
    projectRoot: PROJECT,
    registry: registry(),
    exists: fs,
    homeDir: join(PROJECT, 'home'),
  });
  assert.deepEqual(result.clientIds, ['generic']);
});
