import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  mapEngramTypeToPmcCategory,
  buildPmcPayloadFromEngramSave,
  detectMemoryProtocol,
  formatProtocolReport,
  isValidProtocolVersion,
} from '../src/memory-protocol.mjs';

// --- mapEngramTypeToPmcCategory -------------------------------------------

test('mapEngramTypeToPmcCategory maps all known engram types', () => {
  assert.equal(mapEngramTypeToPmcCategory('bugfix'), 'bug-fix');
  assert.equal(mapEngramTypeToPmcCategory('decision'), 'architecture');
  assert.equal(mapEngramTypeToPmcCategory('architecture'), 'architecture');
  assert.equal(mapEngramTypeToPmcCategory('discovery'), 'learning');
  assert.equal(mapEngramTypeToPmcCategory('pattern'), 'learning');
  assert.equal(mapEngramTypeToPmcCategory('config'), 'tool-usage');
  assert.equal(mapEngramTypeToPmcCategory('preference'), 'personal');
});

test('mapEngramTypeToPmcCategory falls back to learning for unknown and null', () => {
  assert.equal(mapEngramTypeToPmcCategory('something-else'), 'learning');
  assert.equal(mapEngramTypeToPmcCategory(null), 'learning');
  assert.equal(mapEngramTypeToPmcCategory(undefined), 'learning');
  assert.equal(mapEngramTypeToPmcCategory(''), 'learning');
});

// --- buildPmcPayloadFromEngramSave ----------------------------------------

test('buildPmcPayloadFromEngramSave composes content with What header', () => {
  const payload = buildPmcPayloadFromEngramSave(
    { title: 'Fixed N+1 query', content: '**Why**: perf\n**Where**: list.ts', type: 'bugfix' },
    { sessionId: 'sess-1', projectId: 'memory-context' },
  );
  assert.equal(payload.content, '**What**: Fixed N+1 query\n\n**Why**: perf\n**Where**: list.ts');
  assert.equal(payload.category, 'bug-fix');
  assert.deepEqual(payload.tags, ['memory-context']);
  assert.deepEqual(payload.provenance, { origin: 'manual', sessionId: 'sess-1' });
});

test('buildPmcPayloadFromEngramSave splits topic_key into tags', () => {
  const payload = buildPmcPayloadFromEngramSave(
    { title: 'Auth model', content: 'body', type: 'architecture', topic_key: 'architecture/auth-model' },
    { projectId: 'proj' },
  );
  assert.deepEqual(payload.tags, ['proj', 'architecture', 'auth-model']);
  assert.equal(payload.category, 'architecture');
  assert.deepEqual(payload.provenance, { origin: 'manual' });
});

test('buildPmcPayloadFromEngramSave handles missing title and context', () => {
  const payload = buildPmcPayloadFromEngramSave({ content: 'just body' });
  assert.equal(payload.content, 'just body');
  assert.equal(payload.category, 'learning');
  assert.deepEqual(payload.tags, []);
  assert.deepEqual(payload.provenance, { origin: 'manual' });
});

test('buildPmcPayloadFromEngramSave deduplicates tags from topic_key', () => {
  const payload = buildPmcPayloadFromEngramSave(
    { title: 't', content: 'b', topic_key: 'proj/proj/x' },
    { projectId: 'proj' },
  );
  assert.deepEqual(payload.tags, ['proj', 'x']);
});

// --- isValidProtocolVersion -----------------------------------------------

test('isValidProtocolVersion accepts dual and pmc-only', () => {
  assert.equal(isValidProtocolVersion('dual'), true);
  assert.equal(isValidProtocolVersion('pmc-only'), true);
  assert.equal(isValidProtocolVersion('bogus'), false);
  assert.equal(isValidProtocolVersion(undefined), false);
});

// --- formatProtocolReport -------------------------------------------------

test('formatProtocolReport renders dual case', () => {
  const out = formatProtocolReport({
    version: 'dual',
    pmcAvailable: true,
    engramAvailable: true,
    pmcDbPath: '/tmp/db.db',
    source: 'detected',
  });
  assert.match(out, /Version:\s+dual \(source: detected\)/);
  assert.match(out, /PMC available:\s+yes/);
  assert.match(out, /Engram available:\s+yes/);
  assert.match(out, /BOTH PMC \(mandatory\) and Engram/);
});

test('formatProtocolReport renders pmc-only case with engram reason', () => {
  const out = formatProtocolReport({
    version: 'pmc-only',
    pmcAvailable: true,
    engramAvailable: false,
    pmcDbPath: '/tmp/db.db',
    source: 'detected',
  });
  assert.match(out, /Version:\s+pmc-only/);
  assert.match(out, /Engram available:\s+no/);
  assert.match(out, /PMC only/);
  assert.match(out, /Engram CLI not found on PATH/);
});

test('formatProtocolReport tolerates missing detection fields', () => {
  const out = formatProtocolReport(undefined);
  assert.match(out, /Version:\s+unknown/);
  assert.match(out, /PMC DB path:\s+\(none\)/);
});

// --- detectMemoryProtocol -------------------------------------------------

function makeFakeChild(exitCode) {
  const emitter = new EventEmitter();
  emitter.kill = () => {};
  // Defer the exit emission so listeners attach first.
  setImmediate(() => emitter.emit('exit', exitCode));
  return emitter;
}

function makeDeps({ installJson, flagJson, engramFound, statPaths }) {
  const readFile = async (filePath) => {
    const normalized = String(filePath).replace(/\\/g, '/');
    if (normalized.endsWith('install.json')) {
      if (installJson === null) throw new Error('no install.json');
      return JSON.stringify(installJson);
    }
    if (normalized.endsWith('memory-protocol.json')) {
      if (flagJson === null) throw new Error('no flag');
      return JSON.stringify(flagJson);
    }
    throw new Error(`unexpected readFile: ${filePath}`);
  };

  const stat = async (filePath) => {
    const normalized = String(filePath).replace(/\\/g, '/');
    if (statPaths.some((p) => normalized.endsWith(p))) {
      return { mtime: new Date(), size: 100 };
    }
    throw new Error('ENOENT');
  };

  const spawn = () => makeFakeChild(engramFound ? 0 : 1);

  return { readFile, stat, spawn, platform: 'linux', engramProbeTimeoutMs: 200 };
}

test('detectMemoryProtocol returns dual when both backends available', async () => {
  const deps = makeDeps({
    installJson: { memoryDbPath: '/tmp/memory-db' },
    flagJson: null,
    engramFound: true,
    statPaths: ['memory-db.db'],
  });
  const result = await detectMemoryProtocol({ projectRoot: '/proj' }, deps);
  assert.equal(result.version, 'dual');
  assert.equal(result.source, 'detected');
  assert.equal(result.pmcAvailable, true);
  assert.equal(result.engramAvailable, true);
  assert.equal(result.pmcDbPath, '/tmp/memory-db.db');
});

test('detectMemoryProtocol returns pmc-only when PMC DB missing', async () => {
  const deps = makeDeps({
    installJson: { memoryDbPath: '/tmp/memory-db' },
    flagJson: null,
    engramFound: true,
    statPaths: [], // DB does not exist
  });
  const result = await detectMemoryProtocol({ projectRoot: '/proj' }, deps);
  assert.equal(result.version, 'pmc-only');
  assert.equal(result.pmcAvailable, false);
  assert.equal(result.engramAvailable, true);
});

test('detectMemoryProtocol returns pmc-only when engram not on PATH', async () => {
  const deps = makeDeps({
    installJson: { memoryDbPath: '/tmp/memory-db' },
    flagJson: null,
    engramFound: false,
    statPaths: ['memory-db.db'],
  });
  const result = await detectMemoryProtocol({ projectRoot: '/proj' }, deps);
  assert.equal(result.version, 'pmc-only');
  assert.equal(result.pmcAvailable, true);
  assert.equal(result.engramAvailable, false);
});

test('detectMemoryProtocol flag file overrides detection', async () => {
  const deps = makeDeps({
    installJson: { memoryDbPath: '/tmp/memory-db' },
    flagJson: { memory_protocol_version: 'pmc-only' },
    engramFound: true, // detection would say dual, flag wins
    statPaths: ['memory-db.db'],
  });
  const result = await detectMemoryProtocol({ projectRoot: '/proj' }, deps);
  assert.equal(result.version, 'pmc-only');
  assert.equal(result.source, 'flag');
  // availability still reported truthfully
  assert.equal(result.pmcAvailable, true);
  assert.equal(result.engramAvailable, true);
});

test('detectMemoryProtocol ignores invalid flag value and falls back to detection', async () => {
  const deps = makeDeps({
    installJson: { memoryDbPath: '/tmp/memory-db' },
    flagJson: { memory_protocol_version: 'garbage' },
    engramFound: true,
    statPaths: ['memory-db.db'],
  });
  const result = await detectMemoryProtocol({ projectRoot: '/proj' }, deps);
  assert.equal(result.version, 'dual');
  assert.equal(result.source, 'detected');
});

test('detectMemoryProtocol handles missing install.json gracefully', async () => {
  const deps = makeDeps({
    installJson: null,
    flagJson: null,
    engramFound: true,
    statPaths: [],
  });
  const result = await detectMemoryProtocol({ projectRoot: '/proj' }, deps);
  assert.equal(result.version, 'pmc-only');
  assert.equal(result.pmcAvailable, false);
  assert.equal(result.pmcDbPath, null);
});
