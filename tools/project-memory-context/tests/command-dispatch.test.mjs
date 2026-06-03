import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveCommand, runCommand } from '../src/command-dispatch.mjs';
import { main as newProjectMain } from '../cli/new-project.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(TEST_DIR, '..');

test('resolveCommand maps the new agent-facing names', () => {
  const expected = new Map([
    ['map-project', resolve(PACKAGE_ROOT, 'cli', 'bootstrap.mjs')],
    ['get-context', resolve(PACKAGE_ROOT, 'cli', 'context.mjs')],
    ['enrich-status', resolve(PACKAGE_ROOT, 'cli', 'status.mjs')],
    ['init-project', resolve(PACKAGE_ROOT, 'cli', 'init.mjs')],
    ['sync-context', resolve(PACKAGE_ROOT, 'cli', 'sync.mjs')],
    ['sanitize', resolve(PACKAGE_ROOT, 'cli', 'sanitize.mjs')],
    ['doctor', resolve(PACKAGE_ROOT, 'cli', 'doctor.mjs')],
    ['refresh-context', resolve(PACKAGE_ROOT, 'cli', 'refresh-context.mjs')],
    ['retry-errors', resolve(PACKAGE_ROOT, 'cli', 'retry-errors.mjs')],
    ['view-context', resolve(PACKAGE_ROOT, 'bin', 'pmc-view-context.mjs')],
  ]);

  for (const [name, modulePath] of expected) {
    const command = resolveCommand([name]);
    assert.equal(command.name, name);
    assert.equal(command.modulePath, modulePath);
    assert.equal(command.valid, true);
    assert.deepEqual(command.args, []);
  }
});

test('resolveCommand is anchored to the package root instead of process.cwd()', () => {
  const originalCwd = process.cwd();
  const tempDir = mkdtempSync(resolve(tmpdir(), 'pmc-cwd-'));

  try {
    process.chdir(tempDir);
    const command = resolveCommand(['map-project', '--flag']);
    assert.equal(command.modulePath, resolve(PACKAGE_ROOT, 'cli', 'bootstrap.mjs'));
    assert.deepEqual(command.args, ['--flag']);
  } finally {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('resolveCommand preserves auxiliary package commands', () => {
  for (const name of ['enrich', 'install-pmc', 'project-context', 'query', 'setup', 'subagent-apply']) {
    const command = resolveCommand([name]);
    assert.equal(command.name, name);
    assert.ok(command.modulePath, `Expected modulePath for ${name}`);
    assert.equal(existsSync(command.modulePath), true, `Missing wrapper for ${name}`);
  }
});

test('resolveCommand rejects removed legacy aliases', () => {
  for (const name of ['bootstrap', 'context', 'status', 'sync', 'init', 'new-project']) {
    const command = resolveCommand([name]);
    assert.equal(command.valid, false, `expected ${name} to be rejected`);
    assert.equal(command.modulePath, null);
  }
});

test('resolveCommand preserves invalid command names for reporting', () => {
  const command = resolveCommand(['nope', '--flag']);
  assert.equal(command.name, 'nope');
  assert.equal(command.modulePath, null);
  assert.deepEqual(command.args, ['--flag']);
});

test('runCommand returns non-zero and reports the invalid command', async () => {
  const stdout = [];
  const stderr = [];

  const exitCode = await runCommand(['nope'], {
    stdout: { write: (value) => stdout.push(value) },
    stderr: { write: (value) => stderr.push(value) },
    stdio: 'pipe',
  });

  assert.equal(exitCode, 1);
  assert.match(stderr.join(''), /Invalid command: nope/);
  assert.match(stdout.join(''), /Usage: pmc </);
  assert.match(stdout.join(''), /map-project/);
  assert.match(stdout.join(''), /sanitize/);
});

test('help output matches the supported dispatch table', async () => {
  const stdout = [];
  const exitCode = await runCommand([], {
    stdout: { write: (value) => stdout.push(value) },
    stderr: { write: () => {} },
    stdio: 'pipe',
  });

  const output = stdout.join('');
  assert.equal(exitCode, 0);
  assert.match(output, /doctor/);
  assert.match(output, /enrich/);
  assert.match(output, /enrich-status/);
  assert.match(output, /get-context/);
  assert.match(output, /help/);
  assert.match(output, /init-project/);
  assert.match(output, /install-pmc/);
  assert.match(output, /map-project/);
  assert.match(output, /project-context/);
  assert.match(output, /refresh-context/);
  assert.match(output, /retry-errors/);
  assert.match(output, /sanitize/);
  assert.match(output, /setup/);
  assert.match(output, /sync-context/);
  assert.match(output, /subagent-apply/);
  assert.match(output, /view-context/);
  assert.doesNotMatch(output, /(?:<|\|)bootstrap(?:\||>)/);
  assert.doesNotMatch(output, /(?:<|\|)context(?:\||>)/);
  assert.doesNotMatch(output, /(?:<|\|)new-project(?:\||>)/);
  assert.doesNotMatch(output, /(?:<|\|)status(?:\||>)/);
  assert.doesNotMatch(output, /(?:<|\|)sync(?:\||>)/);
  assert.doesNotMatch(output, /(?:<|\|)init(?:\||>)/);
});

test('runCommand forwards child output to supplied writers when stdio is pipe', async () => {
  const stdout = [];
  const stderr = [];

  const exitCode = await runCommand(['enrich-status'], {
    stdout: { write: (value) => stdout.push(String(value)) },
    stderr: { write: (value) => stderr.push(String(value)) },
    stdio: 'pipe',
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr.join(''), '');
  assert.match(stdout.join(''), /"command": "enrich-status"/);
  assert.match(stdout.join(''), /"ok": true/);
  assert.match(stdout.join(''), /"configLocation"/);
});

test('legacy new-project help points to the new public command name', async () => {
  const stdout = [];
  const originalLog = console.log;

  console.log = (value = '') => {
    stdout.push(String(value));
  };

  try {
    const exitCode = await newProjectMain(['--help']);
    assert.equal(exitCode, 0);
  } finally {
    console.log = originalLog;
  }

  const output = stdout.join('');
  assert.match(output, /pmc map-project/);
  assert.doesNotMatch(output, /node new-project\.mjs/);
});
