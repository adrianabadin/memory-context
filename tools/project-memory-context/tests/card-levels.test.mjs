import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildLeveledCard, CARD_LEVELS } from '../src/cards/card-levels.mjs';
import { estimateTokens } from '../src/providers/ollama-token-counter.mjs';

// Minimal realistic symbol facts (shape of buildFacts output).
function symbolFacts(overrides = {}) {
  return {
    id: 'ts|src/services/user.service.ts|function|exported|findById|0',
    kind: 'function',
    signature: 'findById(id: string): Promise<User>',
    location: { path: 'src/services/user.service.ts', startLine: 10, endLine: 20 },
    roleClassification: { role: 'service', layer: 'domain', confidence: 0.9, evidence: ['suffix:Service', 'dir:services'] },
    callers: [{ symbolKey: 'ts|a#getUser', relation: 'calls', kind: 'function' }],
    callees: [{ symbolKey: 'ts|b#query', relation: 'calls', kind: 'function' }],
    imports: [{ symbolKey: 'ts|c#User', relation: 'imports', kind: 'class' }],
    importedBy: [{ symbolKey: 'ts|d#handler', relation: 'imports', kind: 'function' }],
    implements: [],
    tests: [{ symbolKey: 'ts|tests/user.service.test.ts#testUserService', relation: 'tests', kind: 'function' }],
    fanIn: 2,
    fanOut: 2,
    ...overrides,
  };
}

function fileFacts(overrides = {}) {
  return {
    path: 'src/services/user.service.ts',
    kind: 'file',
    roleClassification: { role: 'service', layer: 'domain', confidence: 0.8, evidence: ['dir:services'] },
    exports: [{ id: 'one', symbolKey: 'ts|x#One', kind: 'function' }],
    members: [{ id: 'two', symbolKey: 'ts|x#Two', kind: 'function' }],
    importsFrom: [{ id: 'file|a.ts', path: 'a.ts', kind: 'file' }],
    importedBy: [{ id: 'file|b.ts', path: 'b.ts', kind: 'file' }],
    symbolCount: 2,
    ...overrides,
  };
}

test('CARD_LEVELS exposes the confirmed ceilings as ceilings, not targets', () => {
  assert.equal(CARD_LEVELS.compact.ceiling, 2000);
  assert.equal(CARD_LEVELS.extended.ceiling, 5000);
  assert.equal(CARD_LEVELS.deep.ceiling, 10000);
});

test('invalid level is rejected', () => {
  assert.throws(() => buildLeveledCard({ facts: symbolFacts(), enrichment: '', level: 'huge' }), TypeError);
  assert.throws(() => buildLeveledCard({ facts: symbolFacts(), enrichment: '', level: '' }), TypeError);
});

test('compact: symbol essentials only, no context or evidence', () => {
  const out = buildLeveledCard({ facts: symbolFacts(), enrichment: 'Finds a user by ID.', level: 'compact' });
  assert.equal(out.level, 'compact');
  assert.equal(out.tokenCeiling, 2000);
  assert.equal(out.truncated, false);
  assert.deepEqual(out.omittedSections, []);
  assert.deepEqual(Object.keys(out.card).sort(),
    ['fanIn', 'fanOut', 'id', 'kind', 'location', 'role', 'signature', 'summary']);
  assert.equal(out.card.id, symbolFacts().id);
  assert.equal(out.card.summary, 'Finds a user by ID.');
  assert.deepEqual(out.card.role, { role: 'service', layer: 'domain', confidence: 0.9 });
  assert.equal(out.card.role.evidence, undefined, 'compact role carries no evidence');
});

test('extended: adds context relation lists, still no role evidence', () => {
  const out = buildLeveledCard({ facts: symbolFacts(), enrichment: 'x', level: 'extended' });
  assert.equal(out.tokenCeiling, 5000);
  assert.equal(out.truncated, false);
  assert.ok('callers' in out.card && 'callees' in out.card && 'imports' in out.card);
  assert.ok('importedBy' in out.card && 'tests' in out.card && 'implements' in out.card);
  assert.deepEqual(out.card.callers, symbolFacts().callers);
  assert.equal(out.card.roleEvidence, undefined, 'evidence belongs to deep only');
});

test('deep: adds role evidence on top of context', () => {
  const out = buildLeveledCard({ facts: symbolFacts(), enrichment: 'x', level: 'deep' });
  assert.equal(out.tokenCeiling, 10000);
  assert.equal(out.truncated, false);
  assert.ok('callers' in out.card);
  assert.deepEqual(out.card.roleEvidence, ['suffix:Service', 'dir:services']);
});

test('null role classification yields role:null and empty evidence', () => {
  const out = buildLeveledCard({ facts: symbolFacts({ roleClassification: undefined }), enrichment: 'x', level: 'deep' });
  assert.equal(out.card.role, null);
  assert.deepEqual(out.card.roleEvidence, []);
});

test('tokensEstimated is the real estimate of the payload and never padded to the ceiling', () => {
  const out = buildLeveledCard({ facts: symbolFacts(), enrichment: 'short', level: 'deep' });
  assert.equal(out.tokensEstimated, estimateTokens(JSON.stringify(out.card)));
  assert.ok(out.tokensEstimated < out.tokenCeiling, 'small card stays far below the ceiling, not filled');
});

test('ceiling enforcement drops lowest-priority sections deterministically (no essentials loss)', () => {
  // Huge context forces extended over its 5000-token ceiling.
  const big = Array.from({ length: 4000 }, (_, i) => ({ symbolKey: `ts|pkg/mod-${i}.ts#sym${i}`, relation: 'calls', kind: 'function' }));
  const out = buildLeveledCard({ facts: symbolFacts({ callers: big }), enrichment: 'x', level: 'extended' });
  assert.equal(out.truncated, true);
  assert.deepEqual(out.omittedSections, ['context']);
  assert.equal('callers' in out.card, false, 'dropped context not present');
  // Essentials survive untouched.
  assert.equal(out.card.id, symbolFacts().id);
  assert.ok(out.tokensEstimated <= out.tokenCeiling);
});

test('deep drops evidence first, then context, when oversized', () => {
  const bigEvidence = Array.from({ length: 20000 }, (_, i) => `evidence-token-${i}`);
  const out = buildLeveledCard({
    facts: symbolFacts({ roleClassification: { role: 'service', layer: 'domain', confidence: 0.9, evidence: bigEvidence } }),
    enrichment: 'x',
    level: 'deep',
  });
  assert.equal(out.truncated, true);
  assert.ok(out.omittedSections.includes('evidence'));
  assert.equal('roleEvidence' in out.card, false);
});

test('file card: compact essentials and extended context', () => {
  const compact = buildLeveledCard({ facts: fileFacts(), enrichment: '', level: 'compact' });
  assert.deepEqual(Object.keys(compact.card).sort(), ['kind', 'path', 'role', 'summary', 'symbolCount']);
  assert.equal(compact.card.kind, 'file');
  assert.equal(compact.card.symbolCount, 2);

  const extended = buildLeveledCard({ facts: fileFacts(), enrichment: '', level: 'extended' });
  assert.ok('exports' in extended.card && 'members' in extended.card);
  assert.ok('importsFrom' in extended.card && 'importedBy' in extended.card);
});
