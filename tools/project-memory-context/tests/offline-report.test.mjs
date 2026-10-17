import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildOfflineEvaluationReport } from '../src/evaluation/offline-report.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = resolve(TEST_DIR, '..', 'src', 'evaluation', 'offline-report.mjs');

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function narrative(overrides = {}) {
  return {
    summary: 'Valid summary within the word limit',
    behavior: [],
    sideEffects: [],
    errors: [],
    contracts: [],
    changeNotes: '',
    mentions: [],
    ...overrides,
  };
}

const KEY_A = 'ts|src/a.ts|function|exported|a|0';
const KEY_B = 'ts|src/b.ts|class|exported|B|0';
const KEY_C = 'ts|src/c.ts|function|exported|c|1';

// ---------------------------------------------------------------------------
// Top-level report shape and missing-evidence policy
// ---------------------------------------------------------------------------

test('empty input yields a stable skeleton with all four sections not-measured', () => {
  const report = buildOfflineEvaluationReport({});
  assert.deepEqual(Object.keys(report), [
    'kind', 'relationAccuracy', 'narrativeMentionValidity', 'agentTaskSuccess', 'sampledJudge',
  ]);
  assert.equal(report.kind, 'offline-evaluation-report');

  assert.equal(report.relationAccuracy.status, 'not-measured');
  assert.equal(report.relationAccuracy.questionCount, 0);
  assert.equal(report.relationAccuracy.exactMatchRate, null);
  assert.equal(report.relationAccuracy.microPrecision, null);
  assert.equal(report.relationAccuracy.macroRecall, null);
  assert.deepEqual(report.relationAccuracy.questions, []);

  assert.equal(report.narrativeMentionValidity.status, 'not-measured');
  assert.equal(report.narrativeMentionValidity.totalMentions, null);
  assert.equal(report.narrativeMentionValidity.mentionValidity, null);
  assert.deepEqual(report.narrativeMentionValidity.unknownMentions, []);
  assert.deepEqual(report.narrativeMentionValidity.invalidNarratives, []);

  assert.equal(report.agentTaskSuccess.status, 'not-measured');
  assert.equal(report.agentTaskSuccess.taskCount, 0);
  assert.equal(report.agentTaskSuccess.successRate, null);
  assert.equal(report.agentTaskSuccess.meanFileReadsPerTask, null);
  assert.deepEqual(report.agentTaskSuccess.tasks, []);

  assert.equal(report.sampledJudge.status, 'not-measured');
  assert.equal(report.sampledJudge.sampleCount, 0);
  assert.equal(report.sampledJudge.passRate, null);
  assert.deepEqual(report.sampledJudge.samples, []);
});

test('report is JSON-round-trippable and free of timestamps or randomness', () => {
  const report = buildOfflineEvaluationReport({});
  const text = JSON.stringify(report);
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(report)));
  assert.ok(!text.includes('generatedAt'));
  assert.ok(!text.includes('timestamp'));
  // Determinism: identical input produces byte-identical output.
  assert.equal(text, JSON.stringify(buildOfflineEvaluationReport({})));
});

test('null input and unknown top-level keys fail closed with TypeError', () => {
  assert.throws(() => buildOfflineEvaluationReport(null), TypeError);
  assert.throws(() => buildOfflineEvaluationReport([KEY_A]), TypeError);
  assert.throws(() => buildOfflineEvaluationReport({ relationQuestions: [], extra: 1 }), TypeError);
});

// ---------------------------------------------------------------------------
// Relation answer-set accuracy
// ---------------------------------------------------------------------------

test('relation accuracy: exact match with deduplicated, order-independent values', () => {
  const report = buildOfflineEvaluationReport({
    relationQuestions: [
      { id: 'q1', expected: [KEY_B, KEY_A, KEY_A], observed: [KEY_A, KEY_B] },
    ],
  });
  const section = report.relationAccuracy;
  assert.equal(section.status, 'measured');
  assert.equal(section.questionCount, 1);
  assert.equal(section.exactMatchCount, 1);
  assert.equal(section.exactMatchRate, 1);
  assert.equal(section.totalTruePositives, 2);
  assert.equal(section.totalFalsePositives, 0);
  assert.equal(section.totalFalseNegatives, 0);
  assert.equal(section.microPrecision, 1);
  assert.equal(section.microRecall, 1);
  assert.equal(section.microF1, 1);
  assert.equal(section.macroPrecision, 1);
  assert.equal(section.macroRecall, 1);
  const [q] = section.questions;
  assert.deepEqual(q.expectedValues, [KEY_A, KEY_B]);
  assert.deepEqual(q.observedValues, [KEY_A, KEY_B]);
  assert.equal(q.truePositives, 2);
  assert.equal(q.falsePositives, 0);
  assert.equal(q.falseNegatives, 0);
  assert.equal(q.precision, 1);
  assert.equal(q.recall, 1);
  assert.equal(q.exactMatch, true);
});

test('relation accuracy: partial overlap computes TP/FP/FN and precision/recall', () => {
  const report = buildOfflineEvaluationReport({
    relationQuestions: [
      { id: 'q1', expected: [KEY_A, KEY_B, KEY_C], observed: [KEY_B, KEY_C, 'ts|src/x.ts|function|exported|x|0'] },
    ],
  });
  const [q] = report.relationAccuracy.questions;
  assert.equal(q.truePositives, 2);
  assert.equal(q.falsePositives, 1);
  assert.equal(q.falseNegatives, 1);
  assert.equal(q.precision, 2 / 3);
  assert.equal(q.recall, 2 / 3);
  assert.equal(q.exactMatch, false);
  assert.equal(report.relationAccuracy.microF1, (2 / 3));
});

test('relation accuracy: empty-denominator policy is explicit null, exact match still true when both empty', () => {
  const report = buildOfflineEvaluationReport({
    relationQuestions: [
      { id: 'q-both-empty', expected: [], observed: [] },
      { id: 'q-empty-observed', expected: [KEY_A], observed: [] },
      { id: 'q-empty-expected', expected: [], observed: [KEY_B] },
    ],
  });
  const byId = new Map(report.relationAccuracy.questions.map((q) => [q.id, q]));
  const both = byId.get('q-both-empty');
  assert.equal(both.exactMatch, true);
  assert.equal(both.precision, null);
  assert.equal(both.recall, null);
  const noObserved = byId.get('q-empty-observed');
  assert.equal(noObserved.precision, null); // undefined denominator, never a fabricated 0 or 1
  assert.equal(noObserved.recall, 0);
  assert.equal(noObserved.falseNegatives, 1);
  assert.equal(noObserved.exactMatch, false);
  const noExpected = byId.get('q-empty-expected');
  assert.equal(noExpected.precision, 0);
  assert.equal(noExpected.recall, null);
  assert.equal(noExpected.falsePositives, 1);
  assert.equal(noExpected.exactMatch, false);
  // Aggregates over the three questions: TP=0, FP=1, FN=1.
  const section = report.relationAccuracy;
  assert.equal(section.microPrecision, 0);
  assert.equal(section.microRecall, 0);
  assert.equal(section.microF1, 0);
  assert.equal(section.macroPrecision, 0); // mean over the one defined precision
  assert.equal(section.macroRecall, 0); // mean over the one defined recall
  assert.equal(section.exactMatchRate, 1 / 3);
});

test('relation accuracy: macro and micro aggregates differ as documented', () => {
  const report = buildOfflineEvaluationReport({
    relationQuestions: [
      { id: 'q1', expected: [KEY_A, KEY_B], observed: [KEY_A] },
      { id: 'q2', expected: [KEY_C], observed: ['ts|src/x.ts|function|exported|x|0', 'ts|src/y.ts|function|exported|y|0'] },
    ],
  });
  const section = report.relationAccuracy;
  assert.equal(section.microPrecision, 1 / 3); // TP=1, FP=2
  assert.equal(section.microRecall, 1 / 3); // TP=1, FN=2
  assert.equal(section.microF1, 1 / 3); // P=R=1/3
  assert.equal(section.macroPrecision, 0.5); // mean(1, 0)
  assert.equal(section.macroRecall, 0.25); // mean(0.5, 0)
});

test('relation accuracy: question order is canonical, independent of input order', () => {
  const questions = [
    { id: 'q-b', expected: [KEY_A], observed: [KEY_A] },
    { id: 'q-a', expected: [], observed: [] },
  ];
  const first = buildOfflineEvaluationReport({ relationQuestions: questions });
  const second = buildOfflineEvaluationReport({ relationQuestions: [...questions].reverse() });
  assert.deepEqual(first.relationAccuracy.questions.map((q) => q.id), ['q-a', 'q-b']);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('relation accuracy: empty array input is not-measured, not a zero score', () => {
  const report = buildOfflineEvaluationReport({ relationQuestions: [] });
  assert.equal(report.relationAccuracy.status, 'not-measured');
  assert.equal(report.relationAccuracy.questionCount, 0);
  assert.equal(report.relationAccuracy.exactMatchRate, null);
});

test('relation accuracy: malformed evidence fails closed with TypeError', () => {
  assert.throws(() => buildOfflineEvaluationReport({ relationQuestions: 'nope' }), TypeError);
  assert.throws(() => buildOfflineEvaluationReport({ relationQuestions: [{ expected: [], observed: [] }] }), TypeError);
  assert.throws(() => buildOfflineEvaluationReport({ relationQuestions: [{ id: 'q1', expected: [], observed: [] }, { id: 'q1', expected: [], observed: [] }] }), TypeError);
  assert.throws(() => buildOfflineEvaluationReport({ relationQuestions: [{ id: 'q1', expected: [42], observed: [] }] }), TypeError);
  assert.throws(() => buildOfflineEvaluationReport({ relationQuestions: [{ id: 'q1', expected: ['  '], observed: [] }] }), TypeError);
  assert.throws(() => buildOfflineEvaluationReport({ relationQuestions: [{ id: 'q1', expected: [], observed: KEY_A }] }), TypeError);
  assert.throws(() => buildOfflineEvaluationReport({ relationQuestions: [{ id: ' ', expected: [], observed: [] }] }), TypeError);
});

// ---------------------------------------------------------------------------
// Narrative mention validity (structural validity, never semantic faithfulness)
// ---------------------------------------------------------------------------

test('narrative mentions: all-known mentions measure validity 1 with no invalid narratives', () => {
  const report = buildOfflineEvaluationReport({
    narratives: [{ id: 'n1', narrative: narrative({ mentions: [KEY_A, KEY_B] }) }],
    authoritativeKeys: new Set([KEY_A, KEY_B, KEY_C]),
  });
  const section = report.narrativeMentionValidity;
  assert.equal(section.status, 'measured');
  assert.equal(section.narrativeCount, 1);
  assert.equal(section.totalMentions, 2);
  assert.equal(section.validMentions, 2);
  assert.equal(section.invalidMentions, 0);
  assert.equal(section.mentionValidity, 1);
  assert.deepEqual(section.unknownMentions, []);
  assert.deepEqual(section.invalidNarratives, []);
});

test('narrative mentions: unknown mention keys are counted, listed and validator-rejected', () => {
  const report = buildOfflineEvaluationReport({
    narratives: [{ id: 'n1', narrative: narrative({ mentions: [KEY_A, 'ghost|nowhere|function|exported|ghost|0'] }) }],
    authoritativeKeys: new Set([KEY_A]),
  });
  const section = report.narrativeMentionValidity;
  assert.equal(section.validMentions, 1);
  assert.equal(section.invalidMentions, 1);
  assert.equal(section.mentionValidity, 0.5);
  assert.deepEqual(section.unknownMentions, ['ghost|nowhere|function|exported|ghost|0']);
  assert.equal(section.invalidNarratives.length, 1);
  const [invalid] = section.invalidNarratives;
  assert.equal(invalid.id, 'n1');
  assert.ok(invalid.errors.some((e) => e.includes('Mention does not exist in graph')));
});

test('narrative mentions: zero mentions is an explicit null denominator, not a score of 1', () => {
  const report = buildOfflineEvaluationReport({
    narratives: [{ narrative: narrative() }],
    authoritativeKeys: new Set([KEY_A]),
  });
  const section = report.narrativeMentionValidity;
  assert.equal(section.status, 'measured');
  assert.equal(section.totalMentions, 0);
  assert.equal(section.mentionValidity, null);
  assert.deepEqual(section.invalidNarratives, []);
});

test('narrative mentions: structural schema validity is reported separately from the mention metric', () => {
  const longSummary = Array.from({ length: 26 }, (_, i) => `word${i}`).join(' ');
  const report = buildOfflineEvaluationReport({
    narratives: [{ id: 'n1', narrative: narrative({ summary: longSummary, mentions: [KEY_A] }) }],
    authoritativeKeys: new Set([KEY_A]),
  });
  const section = report.narrativeMentionValidity;
  assert.equal(section.mentionValidity, 1); // the mention itself is valid
  assert.equal(section.invalidNarratives.length, 1); // but the narrative fails structural validation
  assert.ok(section.invalidNarratives[0].errors.some((e) => e.includes('at most 25 words')));
  // Honesty guard: this report never labels structural/mention validity as semantic faithfulness.
  const text = JSON.stringify(report);
  assert.ok(!text.includes('semanticFaithfulness'));
  assert.ok(!text.includes('semantic'));
});

test('narrative mentions: absent or empty narratives are not-measured', () => {
  for (const input of [{}, { narratives: [] }]) {
    const report = buildOfflineEvaluationReport(input);
    const section = report.narrativeMentionValidity;
    assert.equal(section.status, 'not-measured');
    assert.equal(section.narrativeCount, 0);
    assert.equal(section.totalMentions, null);
    assert.equal(section.mentionValidity, null);
  }
});

test('narrative mentions: missing or malformed evidence fails closed with TypeError', () => {
  // Measuring mention validity without an explicit authoritative key set is ambiguous provenance.
  assert.throws(() => buildOfflineEvaluationReport({ narratives: [{ narrative: narrative() }] }), TypeError);
  assert.throws(() => buildOfflineEvaluationReport({ narratives: [{ narrative: narrative() }], authoritativeKeys: [KEY_A] }), TypeError);
  assert.throws(() => buildOfflineEvaluationReport({ narratives: 'nope', authoritativeKeys: new Set() }), TypeError);
  assert.throws(() => buildOfflineEvaluationReport({ narratives: [{ id: 'n1' }], authoritativeKeys: new Set() }), TypeError);
  assert.throws(() => buildOfflineEvaluationReport({ narratives: [{ id: 'n1', narrative: narrative() }, { id: 'n1', narrative: narrative() }], authoritativeKeys: new Set() }), TypeError);
  assert.throws(() => buildOfflineEvaluationReport({ narratives: [{ id: ' ', narrative: narrative() }], authoritativeKeys: new Set() }), TypeError);
});

// ---------------------------------------------------------------------------
// Recorded agent-task evidence (recorded only, never "real agent success")
// ---------------------------------------------------------------------------

test('agent tasks: recorded evidence aggregates success and exact file-read counts', () => {
  const report = buildOfflineEvaluationReport({
    recordedTaskEvidence: [
      { taskId: 't2', success: false, fileReads: 1 },
      { taskId: 't1', success: true, fileReads: 3 },
    ],
  });
  const section = report.agentTaskSuccess;
  assert.equal(section.status, 'measured');
  assert.equal(section.taskCount, 2);
  assert.equal(section.successCount, 1);
  assert.equal(section.failureCount, 1);
  assert.equal(section.successRate, 0.5);
  assert.equal(section.totalFileReads, 4);
  assert.equal(section.meanFileReadsPerTask, 2);
  assert.deepEqual(section.tasks, [
    { taskId: 't1', success: true, fileReads: 3 },
    { taskId: 't2', success: false, fileReads: 1 },
  ]);
});

test('agent tasks: missing or empty evidence is not-measured with null numerics', () => {
  for (const input of [{}, { recordedTaskEvidence: [] }]) {
    const section = buildOfflineEvaluationReport(input).agentTaskSuccess;
    assert.equal(section.status, 'not-measured');
    assert.equal(section.taskCount, 0);
    assert.equal(section.successCount, null);
    assert.equal(section.successRate, null);
    assert.equal(section.totalFileReads, null);
    assert.equal(section.meanFileReadsPerTask, null);
    assert.deepEqual(section.tasks, []);
  }
});

test('agent tasks: malformed or ambiguous records fail closed with TypeError', () => {
  assert.throws(() => buildOfflineEvaluationReport({ recordedTaskEvidence: 'nope' }), TypeError);
  assert.throws(() => buildOfflineEvaluationReport({ recordedTaskEvidence: [{ success: true, fileReads: 1 }] }), TypeError);
  assert.throws(() => buildOfflineEvaluationReport({ recordedTaskEvidence: [{ taskId: ' ', success: true, fileReads: 1 }] }), TypeError);
  assert.throws(() => buildOfflineEvaluationReport({ recordedTaskEvidence: [{ taskId: 't1', success: 'yes', fileReads: 1 }] }), TypeError);
  assert.throws(() => buildOfflineEvaluationReport({ recordedTaskEvidence: [{ taskId: 't1', success: true, fileReads: -1 }] }), TypeError);
  assert.throws(() => buildOfflineEvaluationReport({ recordedTaskEvidence: [{ taskId: 't1', success: true, fileReads: 1.5 }] }), TypeError);
  assert.throws(() => buildOfflineEvaluationReport({ recordedTaskEvidence: [{ taskId: 't1', success: true, fileReads: '3' }] }), TypeError);
  assert.throws(() => buildOfflineEvaluationReport({ recordedTaskEvidence: [{ taskId: 't1', success: true, fileReads: 1 }, { taskId: 't1', success: false, fileReads: 2 }] }), TypeError);
});

// ---------------------------------------------------------------------------
// Recorded sampled judge evidence (recorded verdicts only, never a live judge)
// ---------------------------------------------------------------------------

test('judge: explicitly provided recorded verdicts aggregate with canonical ordering', () => {
  const report = buildOfflineEvaluationReport({
    judgeEvidence: [
      { sampleId: 's2', verdict: 'fail' },
      { sampleId: 's1', verdict: 'pass' },
    ],
  });
  const section = report.sampledJudge;
  assert.equal(section.status, 'measured');
  assert.equal(section.sampleCount, 2);
  assert.equal(section.passCount, 1);
  assert.equal(section.failCount, 1);
  assert.equal(section.passRate, 0.5);
  assert.deepEqual(section.samples, [
    { sampleId: 's1', verdict: 'pass' },
    { sampleId: 's2', verdict: 'fail' },
  ]);
});

test('judge: missing or empty evidence is not-measured with a null pass rate', () => {
  for (const input of [{}, { judgeEvidence: [] }]) {
    const section = buildOfflineEvaluationReport(input).sampledJudge;
    assert.equal(section.status, 'not-measured');
    assert.equal(section.sampleCount, 0);
    assert.equal(section.passCount, null);
    assert.equal(section.failCount, null);
    assert.equal(section.passRate, null);
    assert.deepEqual(section.samples, []);
  }
});

test('judge: malformed or ambiguous verdict records fail closed with TypeError', () => {
  assert.throws(() => buildOfflineEvaluationReport({ judgeEvidence: 'nope' }), TypeError);
  assert.throws(() => buildOfflineEvaluationReport({ judgeEvidence: [{ verdict: 'pass' }] }), TypeError);
  assert.throws(() => buildOfflineEvaluationReport({ judgeEvidence: [{ sampleId: 's1', verdict: 'maybe' }] }), TypeError);
  assert.throws(() => buildOfflineEvaluationReport({ judgeEvidence: [{ sampleId: 's1', verdict: 'pass' }, { sampleId: 's1', verdict: 'fail' }] }), TypeError);
});

// ---------------------------------------------------------------------------
// Combined example (mirrors docs/DEVELOPMENT.md), determinism and immutability
// ---------------------------------------------------------------------------

test('combined documented example produces the exact documented report', () => {
  const input = deepFreeze({
    relationQuestions: [
      { id: 'q1-callers-find-by-id', expected: [KEY_A, KEY_B], observed: [KEY_A] },
      { id: 'q2-callees-find-by-id', expected: [KEY_C], observed: [KEY_C, KEY_B] },
    ],
    narratives: [
      { id: 'n1', narrative: narrative({ mentions: [KEY_A, 'ghost|nowhere|function|exported|ghost|0'] }) },
    ],
    authoritativeKeys: new Set([KEY_A, KEY_B, KEY_C]),
    recordedTaskEvidence: [
      { taskId: 't1', success: true, fileReads: 3 },
      { taskId: 't2', success: false, fileReads: 1 },
    ],
    judgeEvidence: [
      { sampleId: 's1', verdict: 'pass' },
    ],
  });
  const snapshot = JSON.parse(JSON.stringify({
    relationQuestions: input.relationQuestions,
    narratives: input.narratives,
    recordedTaskEvidence: input.recordedTaskEvidence,
    judgeEvidence: input.judgeEvidence,
  }));
  const report = buildOfflineEvaluationReport(input);
  assert.deepEqual(report, {
    kind: 'offline-evaluation-report',
    relationAccuracy: {
      status: 'measured',
      questionCount: 2,
      exactMatchCount: 0,
      exactMatchRate: 0,
      totalTruePositives: 2,
      totalFalsePositives: 1,
      totalFalseNegatives: 1,
      microPrecision: 2 / 3,
      microRecall: 2 / 3,
      microF1: 2 / 3,
      macroPrecision: 0.75,
      macroRecall: 0.75,
      questions: [
        {
          id: 'q1-callers-find-by-id',
          expectedValues: [KEY_A, KEY_B],
          observedValues: [KEY_A],
          truePositives: 1, falsePositives: 0, falseNegatives: 1,
          precision: 1, recall: 0.5, exactMatch: false,
        },
        {
          id: 'q2-callees-find-by-id',
          expectedValues: [KEY_C],
          observedValues: [KEY_B, KEY_C],
          truePositives: 1, falsePositives: 1, falseNegatives: 0,
          precision: 0.5, recall: 1, exactMatch: false,
        },
      ],
    },
    narrativeMentionValidity: {
      status: 'measured',
      narrativeCount: 1,
      totalMentions: 2,
      validMentions: 1,
      invalidMentions: 1,
      mentionValidity: 0.5,
      unknownMentions: ['ghost|nowhere|function|exported|ghost|0'],
      invalidNarratives: [{
        id: 'n1',
        errors: ['Mention does not exist in graph: ghost|nowhere|function|exported|ghost|0'],
      }],
    },
    agentTaskSuccess: {
      status: 'measured',
      taskCount: 2,
      successCount: 1,
      failureCount: 1,
      successRate: 0.5,
      totalFileReads: 4,
      meanFileReadsPerTask: 2,
      tasks: [
        { taskId: 't1', success: true, fileReads: 3 },
        { taskId: 't2', success: false, fileReads: 1 },
      ],
    },
    sampledJudge: {
      status: 'measured',
      sampleCount: 1,
      passCount: 1,
      failCount: 0,
      passRate: 1,
      samples: [{ sampleId: 's1', verdict: 'pass' }],
    },
  });
  // Frozen inputs survive; caller structures are never mutated.
  assert.deepEqual(JSON.parse(JSON.stringify({
    relationQuestions: input.relationQuestions,
    narratives: input.narratives,
    recordedTaskEvidence: input.recordedTaskEvidence,
    judgeEvidence: input.judgeEvidence,
  })), snapshot);
  // Determinism: the same input always produces byte-identical JSON.
  assert.equal(JSON.stringify(report), JSON.stringify(buildOfflineEvaluationReport(input)));
  assert.deepEqual(JSON.parse(JSON.stringify(report)), JSON.parse(JSON.stringify(report)));
});

test('module import surface is pure: only the shared narrative validator, no I/O modules', async () => {
  const source = await readFile(MODULE_PATH, 'utf8');
  const imports = source.match(/^import\s.*$/gm) ?? [];
  assert.equal(imports.length, 1);
  assert.ok(imports[0].includes("'../cards/narrative-schema.mjs'"), imports[0]);
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:child_process', 'child_process', 'node:os']) {
    assert.ok(!source.includes(forbidden), `module must not reference ${forbidden}`);
  }
});
