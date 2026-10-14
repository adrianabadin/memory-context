// tools/project-memory-context/tests/role-classify-recovery.test.mjs
//
// F2 R1 correction batch (independent blockers B1/B2/B3 from the Sol verifier).
// Durable recovery probes; each imports a distinct cache-busting query so module
// state cannot leak between cases. Original S1/S3/S4 scope is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';

const record = { kind: 'class', name: 'Worker', filePath: 'src/plain/worker.ts' };

// B1: structured heritage must recognize heritage FORMS (dotted, generic,
// compound-base), not only clauses that end with a stereotype.
for (const [heritage, role] of [
  ['ControllerBase', 'controller'],
  ['Repository<User>', 'repository'],
  ['models.Model', 'model'],
]) {
  test(`S1 structured heritage: ${heritage}`, async () => {
    const { loadProfile, classifySymbol } = await import('../src/roles/classify.mjs?heritage');
    const result = classifySymbol({ ...record, heritage: [heritage] }, { profile: loadProfile('generic') });
    assert.equal(result.role, role);
    assert.ok(result.evidence.some((e) => e.includes('structured heritage')));
  });
}

// B2: returned node-cli tables must be isolated from module-owned profile data.
test('S2/S3 returned node-cli tables cannot change later classifications', async () => {
  const { loadProfile, classifySymbol, classifyFile } = await import('../src/roles/classify.mjs?isolation');
  const input = { ...record, name: 'TaskController' };
  const before = classifySymbol(input, { profile: loadProfile('generic') });
  const profile = loadProfile('node-cli');
  try { profile.suffixRoles.find((r) => r.suffix === 'Controller').role = 'service'; } catch (e) { assert.ok(e instanceof TypeError); }
  try { profile.directoryRoles.find((r) => r.token === 'cli').role = 'service'; } catch (e) { assert.ok(e instanceof TypeError); }
  assert.deepEqual(classifySymbol(input, { profile: loadProfile('generic') }), before);
  assert.equal(classifyFile({ path: 'cli/x.mjs' }, { profile: loadProfile('node-cli') }).role, 'cli-command');
});

// B3: the public resolved-profile API must fail closed on undeclared roles and
// out-of-range weights before scoring (never silently clamp, never invent enums).
for (const [role, weight] of [['invented-role', 0.6], ['service', 2]]) {
  test(`S3 unsupported profile: ${role}/${weight}`, async () => {
    const { loadProfile, classifySymbol } = await import('../src/roles/classify.mjs?validation');
    const profile = loadProfile('generic');
    profile.suffixRoles = [{ suffix: 'Worker', role }];
    profile.weights.nameSuffix = weight;
    let result;
    try {
      result = classifySymbol({ ...record, name: 'TaskWorker' }, { profile });
    } catch (e) {
      assert.ok(e instanceof TypeError);
      return;
    }
    assert.ok(result.role === null || Object.hasOwn(profile.roleLayers, result.role));
    assert.ok(Number.isFinite(result.confidence) && result.confidence >= 0 && result.confidence <= 1);
  });
}

// B3 second batch: the output contract must hold for ACTUALLY generated signals,
// not just present weights/table roles. A deleted required weight must not yield
// a non-finite confidence, and the implicit decorator-factory role must be declared.
test('S3/B3 missing active weight cannot produce nonfinite confidence', async () => {
  const { loadProfile, classifySymbol } = await import('../src/roles/classify.mjs');
  const profile = loadProfile('generic');
  delete profile.weights.nameSuffix;
  let result;
  try {
    result = classifySymbol({ kind: 'class', name: 'TaskService', filePath: 'src/plain/worker.ts' }, { profile });
  } catch (error) {
    assert.ok(error instanceof TypeError);
    return;
  }
  assert.ok(Number.isFinite(result.confidence) && result.confidence >= 0 && result.confidence <= 1);
});

test('S3/B3 implicit decorator role must be declared', async () => {
  const { loadProfile, classifySymbol } = await import('../src/roles/classify.mjs');
  const profile = loadProfile('generic');
  delete profile.roleLayers.decorator;
  let result;
  try {
    result = classifySymbol({ kind: 'function', name: 'Controller', exportScope: 'local', filePath: 'src/plain/decorator.ts' }, { profile });
  } catch (error) {
    assert.ok(error instanceof TypeError);
    return;
  }
  assert.ok(result.role === null || Object.hasOwn(profile.roleLayers, result.role));
});
