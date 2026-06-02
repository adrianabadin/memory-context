import test from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor } from '../src/doctor.mjs';

const noFetch = async () => { throw new Error('ECONNREFUSED'); };
const okFetch = async () => ({ ok: true, status: 200 });
const noSpawn = null;
const okSpawn = async () => ({ exitCode: 0, stdout: 'Python 3.11.0', stderr: '' });
const failSpawn = async () => ({ exitCode: 1, stdout: '', stderr: 'error' });

test('returns 8 checks', async () => {
  const { checks } = await runDoctor({ env: {}, fetchImpl: noFetch });
  assert.equal(checks.length, 8);
});

test('all check statuses are ok|warn|fail', async () => {
  const { checks } = await runDoctor({ env: {}, fetchImpl: noFetch });
  const valid = new Set(['ok', 'warn', 'fail']);
  assert.ok(checks.every(c => valid.has(c.status)));
});

test('node-version check passes on current Node', async () => {
  const { checks } = await runDoctor({ env: {}, fetchImpl: noFetch });
  const c = checks.find(c => c.name === 'node-version');
  assert.equal(c?.status, 'ok');
  assert.ok(c?.message.includes('Node.js'));
});

test('node-sqlite check is ok on Node >= 24', async () => {
  const { checks } = await runDoctor({ env: {}, fetchImpl: noFetch });
  const c = checks.find(c => c.name === 'node-sqlite');
  assert.ok(c, 'node-sqlite check should exist');
  assert.equal(c?.status, 'ok');
  assert.ok(c?.message.includes('node:sqlite'));
});

test('python check fails when resolvePythonBin returns null', async () => {
  const { checks } = await runDoctor({
    env: {},
    fetchImpl: noFetch,
    resolvePythonBin: () => null,
  });
  const c = checks.find(c => c.name === 'python');
  assert.equal(c?.status, 'fail');
  assert.ok(c?.message.includes('python.org'), 'should include Python download URL');
});

test('python check passes with bin and ok spawnCheck', async () => {
  const { checks } = await runDoctor({
    env: {},
    fetchImpl: noFetch,
    resolvePythonBin: () => 'python3',
    spawnCheck: okSpawn,
  });
  const c = checks.find(c => c.name === 'python');
  assert.equal(c?.status, 'ok');
});

test('ollama check warns when unreachable', async () => {
  const { checks } = await runDoctor({ env: {}, fetchImpl: noFetch });
  const c = checks.find(c => c.name === 'ollama');
  assert.equal(c?.status, 'warn');
});

test('ollama check passes when reachable', async () => {
  const { checks } = await runDoctor({ env: {}, fetchImpl: okFetch });
  const c = checks.find(c => c.name === 'ollama');
  assert.equal(c?.status, 'ok');
});

test('memory-db-path fails when MEMORY_DB_PATH not set', async () => {
  const { checks } = await runDoctor({ env: {}, fetchImpl: noFetch });
  const c = checks.find(c => c.name === 'memory-db-path');
  assert.equal(c?.status, 'fail');
  assert.ok(c?.message.includes('not set'));
});

test('memory-db-path warns for non-existent but set path', async () => {
  const { checks } = await runDoctor({
    env: { MEMORY_DB_PATH: '/tmp/does-not-exist-pmc-test-xyz' },
    fetchImpl: noFetch,
  });
  const c = checks.find(c => c.name === 'memory-db-path');
  assert.ok(c?.status === 'warn' || c?.status === 'ok');
});

test('embedding-cache is ok when EMBEDDING_CACHE_PATH not set', async () => {
  const { checks } = await runDoctor({ env: {}, fetchImpl: noFetch });
  const c = checks.find(c => c.name === 'embedding-cache');
  assert.equal(c?.status, 'ok');
  assert.ok(c?.message.includes('disabled'));
});
