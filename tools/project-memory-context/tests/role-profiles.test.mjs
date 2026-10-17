import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProfile, classifySymbol, classifyFile } from '../src/roles/classify.mjs';

const frameworkCases = [
  ['express', { sideEffects: ['express-router'] }, 'controller'],
  ['nest', { annotations: { decorators: ['Module'] } }, 'config'],
  ['spring', { annotations: { decorators: ['Repository'] } }, 'repository'],
  ['aspnet', { heritage: ['DbContext'] }, 'store'],
  ['django', { heritage: ['django.views.View'] }, 'view'],
];

for (const [name, evidence, role] of frameworkCases) {
  test(`S2 packaged ${name} profile classifies configured structured evidence or markers`, () => {
    const profile = loadProfile(name);
    const result = classifySymbol({ kind: 'class', name: 'Worker', filePath: 'src/worker', ...evidence }, { profile });
    assert.equal(result.role, role);
    assert.ok(result.evidence.length > 0);
    assert.ok(Number.isFinite(result.confidence) && result.confidence <= 1);
    assert.equal(classifyFile({ path: 'services/worker' }, { profile }).role, 'service');
  });
}

async function fixture(t, value) {
  const root = await mkdtemp(join(tmpdir(), 'pmc-role-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, '.planning/project-memory-context/roles.json');
  if (value !== undefined) {
    await mkdir(join(root, '.planning/project-memory-context'), { recursive: true });
    await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return { root, path };
}

async function loader() {
  const module = await import('../src/roles/profile-loader.mjs');
  assert.equal(typeof module.loadProjectProfile, 'function');
  return module.loadProjectProfile;
}

test('S2 absent override preserves caller-selected profile without creating files', async (t) => {
  const { root, path } = await fixture(t);
  const load = await loader();
  assert.deepEqual(await load(root), loadProfile('generic'));
  assert.deepEqual(await load(root, { profileName: 'node-cli' }), loadProfile('node-cli'));
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('S2 explicit extends and keyed overrides take precedence with isolated returned profiles', async (t) => {
  const config = {
    extends: 'nest',
    roleLayers: { handler: 'application' },
    directoryRoles: [{ token: 'services', role: 'handler' }],
    weights: { directoryToken: 0.7 },
  };
  const { root, path } = await fixture(t, config);
  const before = await readFile(path);
  const load = await loader();
  const profile = await load(root, { profileName: 'generic' });
  assert.equal(classifyFile({ path: 'services/worker' }, { profile }).role, 'handler');
  assert.equal(classifySymbol({ kind: 'class', annotations: { decorators: ['Module'] } }, { profile }).role, 'config');
  profile.directoryRoles[0].role = 'test';
  assert.equal(classifyFile({ path: 'services/worker' }, { profile: await load(root) }).role, 'handler');
  assert.equal(classifyFile({ path: 'services/worker' }, { profile: loadProfile('generic') }).role, 'service');
  assert.deepEqual(await readFile(path), before);
});

test('S2 invalid overrides reject without changing persisted input', async (t) => {
  const load = await loader();
  const invalid = [
    '{broken', 'null', '[]', '{"__proto__":{}}',
    { extends: 'unknown' }, { profile: 'nest' },
    { weights: { directoryToken: 2 } }, { weights: { directoryToken: '0.5' } },
    { weights: { imaginary: 0.5 } }, { roleLayers: [] },
    { roleLayers: { handler: null } }, { suffixRoles: 'bad' },
    { suffixRoles: [{ suffix: '', role: 'service' }] },
    { suffixRoles: [{ suffix: 'Worker', role: 'undeclared' }] },
    { topologyRules: [{ when: 'unknown', role: 'controller' }] },
    { topologyThresholds: { fanIn: -1 } },
  ];
  for (const value of invalid) {
    const { root, path } = await fixture(t, value);
    const before = await readFile(path);
    await assert.rejects(load(root), (error) => error instanceof TypeError || error instanceof SyntaxError);
    assert.deepEqual(await readFile(path), before);
  }
});

test('S2 existing generic/node-cli profile behavior remains unchanged', () => {
  assert.equal(classifyFile({ path: 'cli/worker.mjs' }, { profile: loadProfile('generic') }).role, 'cli');
  assert.equal(classifyFile({ path: 'cli/worker.mjs' }, { profile: loadProfile('node-cli') }).role, 'cli-command');
  assert.throws(() => loadProfile('../generic'), TypeError);
});
