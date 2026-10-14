import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadProfile, classifySymbol, classifyFile } from '../src/roles/classify.mjs';
import { loadProjectProfile } from '../src/roles/profile-loader.mjs';

const record = { kind: 'class', name: 'Plain', filePath: 'src/plain.js' };
async function owned(value, check) {
  const root = await mkdtemp(join(tmpdir(), 'r2-profile-'));
  const file = join(root, '.planning/project-memory-context/roles.json');
  try {
    await mkdir(join(root, '.planning/project-memory-context'), { recursive: true });
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
    const hash = async () => createHash('sha256').update(await readFile(file)).digest('hex');
    const before = await hash();
    try { await check(root); } finally { assert.equal(await hash(), before); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('S2 packaged stacks: honest evidence, generic inheritance and isolation', () => {
  for (const [name, input, role, weight, label] of [
    ['express', { sideEffects: ['express-router'] }, 'controller', .3, 'not a verified execution fact'],
    ['nest', { annotations: { decorators: ['Module'] } }, 'config', .9, 'caller-provided syntax evidence'],
    ['spring', { annotations: { decorators: ['Repository'] } }, 'repository', .9, 'caller-provided syntax evidence'],
    ['aspnet', { heritage: ['DbContext'] }, 'store', .85, 'caller-provided syntax evidence'],
    ['django', { heritage: ['django.views.View'] }, 'view', .85, 'caller-provided syntax evidence'],
  ]) {
    const profile = loadProfile(name), saved = structuredClone(profile);
    const actual = classifySymbol({ ...record, ...input }, { profile });
    assert.equal(actual.role, role);
    assert.equal(actual.confidence, weight);
    assert.equal(actual.evidence.length, 1);
    assert.ok(actual.evidence[0].includes(label));
    assert.deepEqual(classifySymbol(record, { profile }), { role: null, layer: null, confidence: 0, evidence: [] });
    assert.equal(classifyFile({ path: 'src/services/plain.js' }, { profile }).role, 'service');
    const freeze = (value) => {
      if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
    };
    freeze(profile);
    assert.deepEqual(loadProfile(name), saved);
  }
});

test('S2 missing file creates no artifact; non-ENOENT propagates', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'r2-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await loadProjectProfile(root, { profileName: 'spring' }), loadProfile('spring'));
  assert.deepEqual(await readdir(root), []);
  await mkdir(join(root, '.planning/project-memory-context/roles.json'), { recursive: true });
  await assert.rejects(loadProjectProfile(root), (error) => error.code !== 'ENOENT');
});

test('S2 keyed precedence, custom declared role, replacement arrays, zero boundary', async () => {
  await owned({
    extends: 'nest', roleLayers: { handler: 'application' },
    directoryRoles: [{ token: 'services', role: 'handler' }],
    weights: { directoryToken: 0 }, decoratorFactoryNames: [], topologyRules: [],
  }, async (root) => {
    const profile = await loadProjectProfile(root);
    assert.equal(profile.name, 'nest');
    assert.deepEqual(profile.decoratorFactoryNames, []);
    assert.deepEqual(profile.topologyRules, []);
    assert.deepEqual(classifyFile({ path: 'src/services/plain.js' }, { profile }), {
      role: 'handler', layer: 'application', confidence: 0,
      evidence: ["directory token marker: path segment 'services' -> role handler"],
    });
    profile.directoryRoles[0].role = 'bad';
    assert.notDeepEqual(await loadProjectProfile(root), profile);
  });
});

test('S2 malformed overrides: exact TypeError and unchanged file', async () => {
  for (const [value, message] of [
    [null, 'roles.json must be an object'], [[], 'roles.json must be an object'],
    [{ typo: true }, 'Unknown roles.json field: typo'], [{ extends: 'absent' }, 'Unknown role profile: absent'],
    ...[-.1, 1.1].map((value) => [{ weights: { nameSuffix: value } }, 'Invalid roles.json weight: nameSuffix']),
    [{ weights: { foo: 0 } }, 'Invalid roles.json weight: foo'], [{ weights: [] }, 'weights must be an object'],
    [{ directoryRoles: {} }, 'directoryRoles must be an array'],
    [{ directoryRoles: [{ token: 'x', role: 'missing' }] }, "role profile directoryRoles references undeclared role 'missing'"],
    [{ topologyRules: [{ when: 'bad', role: 'service' }] }, 'Unsupported topology rule: bad'],
    [{ topologyThresholds: { fanIn: -1 } }, 'Invalid topology threshold: fanIn'],
    [{ suffixRoles: [{ suffix: '', role: 'service' }] }, 'suffixRoles.suffix must be a nonempty string'],
  ]) await owned(value, (root) => assert.rejects(loadProjectProfile(root), { name: 'TypeError', message }));
  await owned('{', (root) => assert.rejects(loadProjectProfile(root), SyntaxError));
});

test('S2 explicitly supplied unknown option must reject, not silently select generic', async () => {
  await owned({}, (root) => assert.rejects(loadProjectProfile(root, { profile: 'spring' }), TypeError));
});

for (const [label, config, input, expected] of [
  ['directory', { directoryRoles: [{ token: 'Services', role: 'adapter' }] }, { filePath: 'src/services/plain.js' }, 'adapter'],
  ['heritage', { extends: 'aspnet', heritageTypeRoles: [{ name: 'dbcontext', role: 'service' }] }, { heritage: ['DbContext'] }, 'service'],
  ['suffix', { suffixRoles: [{ suffix: 'service', role: 'adapter' }] }, { name: 'UsersService' }, 'adapter'],
]) test(`S2 ${label} override must use matching normalization`, async () => {
  await owned(config, async (root) => assert.equal(
    classifySymbol({ ...record, ...input }, { profile: await loadProjectProfile(root) }).role, expected,
  ));
});
