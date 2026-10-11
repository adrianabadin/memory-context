import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runRelationalEval,
  runBaseline,
  validateGoldenSchema,
  isValidSymbolKey,
} from '../src/eval/relational-eval.mjs';
import { extractTopLevelSymbols } from '../src/symbol-extractor.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = resolve(TEST_DIR, 'fixtures', 'layered-app');
const GOLDEN_PATH = join(FIXTURE_ROOT, 'expected.json');

test('1. Golden schema is valid and all expected relation IDs use extractor format with round-trip', async () => {
  const content = await readFile(GOLDEN_PATH, 'utf8');
  const golden = JSON.parse(content);

  const validation = validateGoldenSchema(golden);
  assert.equal(validation.valid, true, `Schema validation failed: ${validation.error}`);
  assert.ok(golden.schemaVersion, 'schemaVersion must be present');
  assert.ok(golden.fixture, 'fixture name must be present');
  assert.ok(golden.symbols, 'symbols map must be present');
  assert.ok(Array.isArray(golden.questions), 'questions must be an array');
  assert.ok(golden.questions.length >= 8, 'must have at least 8 golden questions');

  // Verify q1 includes testUserService caller
  const q1 = golden.questions.find((q) => q.id === 'q1-callers-user-service-find-by-id');
  assert.ok(q1, 'q1 must exist');
  assert.ok(
    q1.expected.some((id) => id.includes('testUserService')),
    'q1 callers must include testUserService',
  );

  // Round-trip test: all non-future code symbols in golden.symbols must be extracted by actual extractor
  const nonFutureSymbols = Object.entries(golden.symbols).filter(([, meta]) => !meta.future);
  assert.ok(nonFutureSymbols.length >= 10, 'must have at least 10 current symbols');

  for (const [key] of nonFutureSymbols) {
    const parts = key.split('|');
    const relFile = parts[1];
    const fullPath = join(FIXTURE_ROOT, relFile);
    const fileContent = await readFile(fullPath, 'utf8');
    const extracted = await extractTopLevelSymbols({ filePath: relFile, content: fileContent });
    assert.ok(
      extracted.some((s) => s.symbolKey === key),
      `Symbol key ${key} must round-trip through extractTopLevelSymbols`,
    );
  }
});

test('2. isValidSymbolKey allows 6-part standard keys and 7-part C# keys without banning either', () => {
  assert.equal(isValidSymbolKey('ts|src/a.ts|class|exported|A|0'), true);
  assert.equal(isValidSymbolKey('python|pkg/mod.py|function|local|my_func|2'), true);
  assert.equal(isValidSymbolKey('csharp|src/App.cs|MyNamespace|MyClass|method|DoWork|()'), true);

  // Reject malformed
  assert.equal(isValidSymbolKey(''), false);
  assert.equal(isValidSymbolKey('ts|src/a.ts|class'), false); // too few
  assert.equal(isValidSymbolKey('ts|src/a.ts|class|exported|A|0|extra'), false); // too many for non-csharp
  assert.equal(isValidSymbolKey('csharp|src/App.cs|MyNamespace|MyClass|method|DoWork'), false); // too few for csharp
  assert.equal(isValidSymbolKey('ts|src/a.ts||exported|A|0'), false); // blank segment
});

test('3. Perfect stub adapter achieves 1.0 accuracy and mean precision/recall', async () => {
  const content = await readFile(GOLDEN_PATH, 'utf8');
  const golden = JSON.parse(content);
  const answers = new Map(golden.questions.map((q) => [q.id, q.expected]));

  const result = await runRelationalEval({
    goldenPath: GOLDEN_PATH,
    answer: async (q) => answers.get(q.id),
  });

  assert.equal(result.accuracy, 1);
  assert.equal(result.meanPrecision, 1);
  assert.equal(result.meanRecall, 1);
  assert.equal(result.f1, 1);
  assert.equal(result.passedQuestions, result.totalQuestions);
  assert.ok(result.totalQuestions > 0);
  assert.ok(result.questions.every((q) => q.passed === true));
});

test('4. Handles missing IDs with precision 1.0 and lower recall', async () => {
  const result = await runRelationalEval({
    goldenPath: GOLDEN_PATH,
    answer: async () => [],
  });

  const nonEmptyQuestions = result.questions.filter((q) => q.expected.length > 0);
  assert.ok(nonEmptyQuestions.length > 0);
  for (const q of nonEmptyQuestions) {
    assert.equal(q.passed, false);
    assert.ok(q.missing.length > 0);
    assert.equal(q.extra.length, 0);
    assert.equal(q.recall, 0);
  }
});

test('5. Handles extra IDs with recall 1.0 and lower precision', async () => {
  const content = await readFile(GOLDEN_PATH, 'utf8');
  const golden = JSON.parse(content);
  const answers = new Map(golden.questions.map((q) => [q.id, q.expected]));
  const dummyId = 'ts|src/extra.ts|function|exported|extraFn|0';

  const result = await runRelationalEval({
    goldenPath: GOLDEN_PATH,
    answer: async (q) => {
      const expected = answers.get(q.id) ?? [];
      return [...expected, dummyId];
    },
  });

  for (const q of result.questions) {
    assert.equal(q.passed, false);
    assert.deepEqual(q.extra, [dummyId]);
    assert.ok(q.precision < 1 || q.expected.length === 0);
  }
});

test('6. Handles duplicates and order differences deterministically as exact match', async () => {
  const content = await readFile(GOLDEN_PATH, 'utf8');
  const golden = JSON.parse(content);
  const answers = new Map(golden.questions.map((q) => [q.id, q.expected]));

  const result = await runRelationalEval({
    goldenPath: GOLDEN_PATH,
    answer: async (q) => {
      const expected = answers.get(q.id) ?? [];
      return [...expected.slice().reverse(), ...expected];
    },
  });

  assert.equal(result.accuracy, 1);
  assert.equal(result.passedQuestions, result.totalQuestions);
  for (const q of result.questions) {
    assert.equal(q.passed, true);
    assert.deepEqual(q.missing, []);
    assert.deepEqual(q.extra, []);
  }
});

test('7. Handles empty expected sets correctly for precision and recall', async () => {
  const content = await readFile(GOLDEN_PATH, 'utf8');
  const golden = JSON.parse(content);
  const emptyQ = golden.questions.find((q) => q.expected.length === 0);
  assert.ok(emptyQ, 'golden fixture must have at least one question with empty expected set');

  const matchResult = await runRelationalEval({
    goldenPath: GOLDEN_PATH,
    answer: async (q) => (q.id === emptyQ.id ? [] : q.expected),
  });
  const emptyReport = matchResult.questions.find((q) => q.questionId === emptyQ.id);
  assert.equal(emptyReport.passed, true);
  assert.equal(emptyReport.precision, 1);
  assert.equal(emptyReport.recall, 1);

  const mismatchResult = await runRelationalEval({
    goldenPath: GOLDEN_PATH,
    answer: async (q) => (q.id === emptyQ.id ? ['ts|dummy|x|y|z|0'] : q.expected),
  });
  const emptyMismatch = mismatchResult.questions.find((q) => q.questionId === emptyQ.id);
  assert.equal(emptyMismatch.passed, false);
  assert.equal(emptyMismatch.precision, 0);
  assert.equal(emptyMismatch.recall, 0);
});

test('8. Handles invalid adapter return values and rejections cleanly', async () => {
  const invalidResult = await runRelationalEval({
    goldenPath: GOLDEN_PATH,
    answer: async () => ({ unexpected: true }),
  });
  assert.equal(invalidResult.accuracy, 0);
  assert.ok(invalidResult.questions.every((q) => q.passed === false && /invalid/i.test(q.error)));

  const rejectedResult = await runRelationalEval({
    goldenPath: GOLDEN_PATH,
    answer: async () => {
      throw new Error('Database connection failed');
    },
  });
  assert.equal(rejectedResult.accuracy, 0);
  assert.ok(rejectedResult.questions.every((q) => q.passed === false && /Database connection failed/.test(q.error)));
});

test('9. Tightened schema validation rejects unsupported versions, duplicate ids, unknown types, null questions, missing symbols, and duplicate expected IDs', () => {
  const symA = 'ts|src/a.ts|class|exported|A|0';
  const symB = 'ts|src/b.ts|function|exported|b|0';
  const validBase = {
    schemaVersion: 1,
    fixture: 'test-app',
    symbols: {
      [symA]: { role: 'model' },
      [symB]: { role: 'service' },
    },
    questions: [
      {
        id: 'q1',
        type: 'callers',
        target: symA,
        expected: [symB],
      },
    ],
  };

  // Unsupported schemaVersion
  const badVersion = validateGoldenSchema({ ...validBase, schemaVersion: 99 });
  assert.equal(badVersion.valid, false);
  assert.match(badVersion.error, /unsupported schemaVersion/i);

  // Duplicate question IDs
  const duplicateIds = validateGoldenSchema({
    ...validBase,
    questions: [validBase.questions[0], { ...validBase.questions[0] }],
  });
  assert.equal(duplicateIds.valid, false);
  assert.match(duplicateIds.error, /duplicate question id/i);

  // Unknown question type
  const unknownType = validateGoldenSchema({
    ...validBase,
    questions: [{ ...validBase.questions[0], type: 'invalid_rel_type' }],
  });
  assert.equal(unknownType.valid, false);
  assert.match(unknownType.error, /unknown question type/i);

  // Null question in array
  const nullQuestion = validateGoldenSchema({
    ...validBase,
    questions: [null],
  });
  assert.equal(nullQuestion.valid, false);
  assert.match(nullQuestion.error, /invalid question object/i);

  // Target not in symbols map
  const missingTargetSym = validateGoldenSchema({
    ...validBase,
    questions: [
      { ...validBase.questions[0], target: 'ts|src/missing.ts|class|exported|Missing|0' },
    ],
  });
  assert.equal(missingTargetSym.valid, false);
  assert.match(missingTargetSym.error, /not defined in symbols map/i);

  // Expected ID not in symbols map
  const missingExpectedSym = validateGoldenSchema({
    ...validBase,
    questions: [
      { ...validBase.questions[0], expected: ['ts|src/missing.ts|class|exported|Missing|0'] },
    ],
  });
  assert.equal(missingExpectedSym.valid, false);
  assert.match(missingExpectedSym.error, /not defined in symbols map/i);

  // Duplicate IDs inside expected array
  const dupExpected = validateGoldenSchema({
    ...validBase,
    questions: [
      { ...validBase.questions[0], expected: [symB, symB] },
    ],
  });
  assert.equal(dupExpected.valid, false);
  assert.match(dupExpected.error, /duplicate ID in expected/i);
});

test('10. runBaseline NEVER writes directly into caller tempRoot; seeds caller sentinel and confirms no overwrite/removal', async () => {
  const callerTempRoot = await mkdtemp(join(tmpdir(), 'pmc-caller-seed-'));
  const sentinelPath = join(callerTempRoot, '.planning', 'sentinel.txt');
  await mkdir(dirname(sentinelPath), { recursive: true });
  await writeFile(sentinelPath, 'CALLER_SENTINEL_OK', 'utf8');

  try {
    const report = await runBaseline({
      fixtureRoot: FIXTURE_ROOT,
      tempRoot: callerTempRoot,
      resolveGraphifyFn: () => {
        throw new Error('graphify not installed');
      },
    });

    assert.ok(report);
    assert.equal(report.endToEnd.status, 'UNAVAILABLE');
    assert.match(report.endToEnd.reason, /graphify not installed/);
    assert.equal(report.endToEnd.accuracy, undefined); // No numeric relational accuracy!

    // Verify caller tempRoot and sentinel were NOT modified or removed
    const sentinelContent = await readFile(sentinelPath, 'utf8');
    assert.equal(sentinelContent, 'CALLER_SENTINEL_OK', 'sentinel must be untouched');
  } finally {
    await rm(callerTempRoot, { recursive: true, force: true });
  }
});

test('11. Injected runner tests: NOT_RUN when graphify fails, UNAVAILABLE when resolveGraphify throws', async () => {
  // Test 1: graphify not found
  const reportUnavailable = await runBaseline({
    fixtureRoot: FIXTURE_ROOT,
    resolveGraphifyFn: () => {
      throw new Error('graphify not on PATH');
    },
  });
  assert.equal(reportUnavailable.endToEnd.status, 'UNAVAILABLE');
  assert.match(reportUnavailable.endToEnd.reason, /graphify not on PATH/);
  assert.equal(reportUnavailable.endToEnd.accuracy, undefined);
  assert.ok(reportUnavailable.extractionCapabilities.filesScanned >= 8);

  // Test 2: graphify update exits with failure (ran: false)
  const reportNotRun = await runBaseline({
    fixtureRoot: FIXTURE_ROOT,
    resolveGraphifyFn: () => '/fake/graphify',
    runGraphifyUpdateFn: async () => ({ ran: false }),
  });
  assert.equal(reportNotRun.endToEnd.status, 'NOT_RUN');
  assert.equal(reportNotRun.endToEnd.accuracy, undefined);
  assert.ok(reportNotRun.extractionCapabilities);
});

test('12. Real baseline run executes end-to-end if graphify is available, reporting real status without fabricated numbers', async () => {
  const report = await runBaseline({ fixtureRoot: FIXTURE_ROOT });
  assert.ok(report.endToEnd);
  assert.ok(['EVALUATED', 'NOT_RUN', 'UNAVAILABLE'].includes(report.endToEnd.status));
  assert.ok(report.extractionCapabilities);
  assert.ok(report.extractionCapabilities.filesScanned >= 8);
  assert.ok(report.extractionCapabilities.symbolsExtracted >= 8);
});
