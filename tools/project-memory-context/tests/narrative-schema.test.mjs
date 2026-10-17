import test from 'node:test';
import assert from 'node:assert/strict';

const key = 'ts|src/worker.ts|function|exported|execute|0';
const narrative = {
  summary: 'Executes a validated task.', behavior: ['Checks input.'], sideEffects: [],
  errors: [], contracts: ['Input must be valid.'], changeNotes: 'Preserve validation.', mentions: [key],
};
const keys = new Set([key]);
const load = () => import('../src/cards/narrative-schema.mjs');

test('S7 schema and validator accept exactly the narrative shape without mutating input', async () => {
  const { NARRATIVE_SCHEMA, validateNarrative } = await load();
  assert.deepEqual(NARRATIVE_SCHEMA.required.slice().sort(), Object.keys(narrative).sort());
  assert.equal(NARRATIVE_SCHEMA.additionalProperties, false);
  assert.equal(Object.isFrozen(NARRATIVE_SCHEMA.properties.mentions.items), true);
  const input = structuredClone(narrative), before = JSON.stringify(input);
  for (const value of Object.values(input)) if (Array.isArray(value)) Object.freeze(value);
  Object.freeze(input);
  assert.deepEqual(validateNarrative(input, { symbolKeys: keys }), { valid: true, errors: [] });
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual([...keys], [key]);
});

test('S7 summary word limit agrees with the public JSON schema at 25 words', async () => {
  const { NARRATIVE_SCHEMA, validateNarrative } = await load();
  for (const count of [24, 25, 26]) {
    const summary = Array(count).fill('word').join(' ');
    assert.equal(validateNarrative({ ...narrative, summary }, { symbolKeys: keys }).valid, count <= 25);
    assert.equal(new RegExp(NARRATIVE_SCHEMA.properties.summary.pattern).test(summary), count <= 25);
  }
});

test('S7 missing/extra fields and incorrect scalar or list values are invalid', async () => {
  const { validateNarrative } = await load();
  const without = { ...narrative };
  delete without.changeNotes;
  const invalid = [null, [], 'text', without, { ...narrative, extra: true },
    { ...narrative, summary: 1 }, { ...narrative, changeNotes: null }];
  for (const field of ['behavior', 'sideEffects', 'errors', 'contracts', 'mentions']) {
    invalid.push({ ...narrative, [field]: 'not an array' }, { ...narrative, [field]: [null] });
  }
  for (const input of invalid) {
    const result = validateNarrative(input, { symbolKeys: keys });
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  }
});

test('S7 every mention must be a graph key; an empty graph never accepts fabricated mentions', async () => {
  const { validateNarrative } = await load();
  assert.equal(validateNarrative(narrative).valid, false);
  assert.equal(validateNarrative({ ...narrative, mentions: [key, 'fabricated'] }, { symbolKeys: keys }).valid, false);
  assert.equal(validateNarrative({ ...narrative, mentions: [] }).valid, true);
  assert.throws(() => validateNarrative(narrative, { symbolKeys: [key] }), TypeError);
});

test('S7 valid generation takes one call and returns an isolated narrative', async () => {
  const { generateValidatedNarrative, NARRATIVE_SCHEMA } = await load();
  let calls = 0;
  const result = await generateValidatedNarrative({ symbolKeys: keys, generate: async (request) => {
    calls++;
    assert.equal(request.attempt, 1);
    assert.equal(request.schema, NARRATIVE_SCHEMA);
    assert.deepEqual(request.errors, []);
    return narrative;
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { status: 'validated', narrative, attempts: 1, errors: [] });
  result.narrative.mentions.push('changed');
  assert.deepEqual(narrative.mentions, [key]);
});

test('S7 invalid output retries once with diagnostics and accepts corrected JSON', async () => {
  const { generateValidatedNarrative } = await load();
  const requests = [];
  const result = await generateValidatedNarrative({ symbolKeys: keys, generate: async (request) => {
    requests.push(request);
    return request.attempt === 1 ? { ...narrative, mentions: ['fabricated'] } : JSON.stringify(narrative);
  } });
  assert.equal(requests.length, 2);
  assert.ok(requests[1].errors.some((error) => error.includes('fabricated')));
  assert.deepEqual(result, { status: 'validated', narrative, attempts: 2, errors: [] });
});

test('S7 invalid JSON/schema after the single retry returns error and no accepted narrative', async () => {
  const { generateValidatedNarrative } = await load();
  for (const output of ['{broken', { ...narrative, mentions: ['fabricated'] }]) {
    let calls = 0;
    const result = await generateValidatedNarrative({ symbolKeys: keys, generate: async () => { calls++; return output; } });
    assert.equal(calls, 2);
    assert.equal(result.status, 'error');
    assert.equal(result.narrative, null);
    assert.equal(result.attempts, 2);
    assert.ok(result.errors.length > 0);
  }
});

test('S7 provider exceptions are not retried or mislabeled as schema errors', async () => {
  const { generateValidatedNarrative } = await load();
  const failure = new Error('provider unavailable');
  let calls = 0;
  await assert.rejects(generateValidatedNarrative({ symbolKeys: keys, generate: async () => { calls++; throw failure; } }), (error) => error === failure);
  assert.equal(calls, 1);
});
