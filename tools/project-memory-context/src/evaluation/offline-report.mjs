// Offline evaluation/report builder (F5.2A / S20): pure, deterministic arithmetic
// over EXPLICITLY supplied evidence. This module measures nothing by itself: it
// computes relation answer-set accuracy, narrative mention/structural validity
// against a caller-supplied authoritative key Set, and aggregates RECORDED
// agent-task evidence (success plus actual recorded file-read counts) and
// RECORDED sampled judge verdicts when — and only when — the caller provides
// attributable evidence. Any section without such evidence reports
// `status: 'not-measured'` with null numerics, never a fabricated score.
// Mention/validator validity is STRUCTURAL validity, never "semantic faithfulness";
// aggregated recorded evidence is never a claim of "real agent success" or of a
// judge this module never ran. No thresholds, CI gating, timestamps, randomness,
// I/O, inference or environment dependence; caller inputs are never mutated.
import { validateNarrative } from '../cards/narrative-schema.mjs';

export const OFFLINE_EVALUATION_REPORT_KIND = 'offline-evaluation-report';

const TOP_LEVEL_KEYS = new Set([
  'relationQuestions', 'narratives', 'authoritativeKeys', 'recordedTaskEvidence', 'judgeEvidence',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalArray(input, key) {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) throw new TypeError(`${key} must be an array when provided`);
  return input;
}

// Undefined ratio denominators are reported as null, never as an invented 0 or 1.
function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function mean(values) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function canonicalValues(values, label) {
  const unique = new Set();
  for (const value of values) {
    if (typeof value !== 'string') throw new TypeError(`${label} must contain only strings`);
    if (!value.trim()) throw new TypeError(`${label} must not contain blank strings`);
    unique.add(value);
  }
  return [...unique].sort();
}

function requireNonBlankString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-blank string`);
  return value;
}

function uniqueId(value, label, seen) {
  requireNonBlankString(value, label);
  if (seen.has(value)) throw new TypeError(`Duplicate ${label}: ${value}`);
  seen.add(value);
  return value;
}

function relationNotMeasured() {
  return {
    status: 'not-measured',
    reason: 'no-relation-evidence',
    questionCount: 0,
    exactMatchCount: null,
    exactMatchRate: null,
    totalTruePositives: null,
    totalFalsePositives: null,
    totalFalseNegatives: null,
    microPrecision: null,
    microRecall: null,
    microF1: null,
    macroPrecision: null,
    macroRecall: null,
    questions: [],
  };
}

function buildRelationAccuracy(relationQuestions) {
  const entries = optionalArray(relationQuestions, 'relationQuestions');
  if (!entries || entries.length === 0) return relationNotMeasured();

  const seenIds = new Set();
  const questions = [];
  for (const entry of entries) {
    if (!isPlainObject(entry)) throw new TypeError('relationQuestions entries must be objects');
    const id = uniqueId(entry.id, 'relation question id', seenIds);
    if (!Array.isArray(entry.expected)) throw new TypeError(`expected must be an array for question ${id}`);
    if (!Array.isArray(entry.observed)) throw new TypeError(`observed must be an array for question ${id}`);
    const expectedValues = canonicalValues(entry.expected, `expected for question ${id}`);
    const observedValues = canonicalValues(entry.observed, `observed for question ${id}`);
    const expectedSet = new Set(expectedValues);
    const observedSet = new Set(observedValues);
    const truePositives = expectedValues.filter((value) => observedSet.has(value)).length;
    const falsePositives = observedValues.filter((value) => !expectedSet.has(value)).length;
    const falseNegatives = expectedValues.filter((value) => !observedSet.has(value)).length;
    questions.push({
      id,
      expectedValues,
      observedValues,
      truePositives,
      falsePositives,
      falseNegatives,
      precision: ratio(truePositives, observedValues.length),
      recall: ratio(truePositives, expectedValues.length),
      exactMatch: falsePositives === 0 && falseNegatives === 0,
    });
  }
  questions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const totalTruePositives = questions.reduce((sum, q) => sum + q.truePositives, 0);
  const totalFalsePositives = questions.reduce((sum, q) => sum + q.falsePositives, 0);
  const totalFalseNegatives = questions.reduce((sum, q) => sum + q.falseNegatives, 0);
  const microPrecision = ratio(totalTruePositives, totalTruePositives + totalFalsePositives);
  const microRecall = ratio(totalTruePositives, totalTruePositives + totalFalseNegatives);
  const microF1 = (microPrecision === null || microRecall === null)
    ? null
    : ((microPrecision + microRecall) > 0
      ? (2 * microPrecision * microRecall) / (microPrecision + microRecall)
      : 0);
  return {
    status: 'measured',
    questionCount: questions.length,
    exactMatchCount: questions.filter((q) => q.exactMatch).length,
    exactMatchRate: ratio(questions.filter((q) => q.exactMatch).length, questions.length),
    totalTruePositives,
    totalFalsePositives,
    totalFalseNegatives,
    microPrecision,
    microRecall,
    microF1,
    macroPrecision: mean(questions.map((q) => q.precision).filter((p) => p !== null)),
    macroRecall: mean(questions.map((q) => q.recall).filter((r) => r !== null)),
    questions,
  };
}

function narrativeNotMeasured() {
  return {
    status: 'not-measured',
    reason: 'no-narrative-evidence',
    narrativeCount: 0,
    totalMentions: null,
    validMentions: null,
    invalidMentions: null,
    mentionValidity: null,
    unknownMentions: [],
    invalidNarratives: [],
  };
}

function buildNarrativeMentionValidity(narratives, authoritativeKeys) {
  const entries = optionalArray(narratives, 'narratives');
  if (!entries || entries.length === 0) return narrativeNotMeasured();
  // Measuring mention validity without an explicit authoritative key Set would
  // guess provenance, so it fails closed instead of reporting a number.
  if (!(authoritativeKeys instanceof Set)) {
    throw new TypeError('authoritativeKeys must be a Set of authoritative graph keys when narratives are provided');
  }
  const seenIds = new Set();
  let totalMentions = 0;
  let validMentions = 0;
  const unknown = new Set();
  const invalidNarratives = [];
  for (const entry of entries) {
    if (!isPlainObject(entry)) throw new TypeError('narratives entries must be objects');
    if (!Object.hasOwn(entry, 'narrative')) throw new TypeError('narratives entries must have a narrative property');
    let id = null;
    if (Object.hasOwn(entry, 'id')) id = uniqueId(entry.id, 'narrative id', seenIds);
    if (Array.isArray(entry.narrative?.mentions)) {
      for (const mention of entry.narrative.mentions) {
        if (typeof mention !== 'string') continue; // malformed mentions are structural errors, not counted values
        totalMentions += 1;
        if (authoritativeKeys.has(mention)) validMentions += 1;
        else unknown.add(mention);
      }
    }
    const result = validateNarrative(entry.narrative, { symbolKeys: authoritativeKeys });
    if (!result.valid) invalidNarratives.push({ id, errors: result.errors });
  }
  return {
    status: 'measured',
    narrativeCount: entries.length,
    totalMentions,
    validMentions,
    invalidMentions: totalMentions - validMentions,
    mentionValidity: ratio(validMentions, totalMentions),
    unknownMentions: [...unknown].sort(),
    invalidNarratives,
  };
}

function taskNotMeasured() {
  return {
    status: 'not-measured',
    reason: 'no-recorded-task-evidence',
    taskCount: 0,
    successCount: null,
    failureCount: null,
    successRate: null,
    totalFileReads: null,
    meanFileReadsPerTask: null,
    tasks: [],
  };
}

function buildAgentTaskSuccess(recordedTaskEvidence) {
  const entries = optionalArray(recordedTaskEvidence, 'recordedTaskEvidence');
  if (!entries || entries.length === 0) return taskNotMeasured();
  const seenIds = new Set();
  const tasks = [];
  for (const entry of entries) {
    if (!isPlainObject(entry)) throw new TypeError('recordedTaskEvidence entries must be objects');
    const taskId = uniqueId(entry.taskId, 'recorded task taskId', seenIds);
    if (typeof entry.success !== 'boolean') throw new TypeError(`success must be a boolean for recorded task ${taskId}`);
    if (!Number.isInteger(entry.fileReads) || entry.fileReads < 0) {
      throw new TypeError(`fileReads must be a non-negative integer for recorded task ${taskId}`);
    }
    tasks.push({ taskId, success: entry.success, fileReads: entry.fileReads });
  }
  tasks.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  const successCount = tasks.filter((task) => task.success).length;
  const totalFileReads = tasks.reduce((sum, task) => sum + task.fileReads, 0);
  return {
    status: 'measured',
    taskCount: tasks.length,
    successCount,
    failureCount: tasks.length - successCount,
    successRate: ratio(successCount, tasks.length),
    totalFileReads,
    meanFileReadsPerTask: ratio(totalFileReads, tasks.length),
    tasks,
  };
}

function judgeNotMeasured() {
  return {
    status: 'not-measured',
    reason: 'no-recorded-judge-evidence',
    sampleCount: 0,
    passCount: null,
    failCount: null,
    passRate: null,
    samples: [],
  };
}

function buildSampledJudge(judgeEvidence) {
  const entries = optionalArray(judgeEvidence, 'judgeEvidence');
  if (!entries || entries.length === 0) return judgeNotMeasured();
  const seenIds = new Set();
  const samples = [];
  for (const entry of entries) {
    if (!isPlainObject(entry)) throw new TypeError('judgeEvidence entries must be objects');
    const sampleId = uniqueId(entry.sampleId, 'judge sampleId', seenIds);
    if (entry.verdict !== 'pass' && entry.verdict !== 'fail') {
      throw new TypeError(`verdict must be 'pass' or 'fail' for judge sample ${sampleId}`);
    }
    samples.push({ sampleId, verdict: entry.verdict });
  }
  samples.sort((a, b) => (a.sampleId < b.sampleId ? -1 : a.sampleId > b.sampleId ? 1 : 0));
  const passCount = samples.filter((sample) => sample.verdict === 'pass').length;
  return {
    status: 'measured',
    sampleCount: samples.length,
    passCount,
    failCount: samples.length - passCount,
    passRate: ratio(passCount, samples.length),
    samples,
  };
}

export function buildOfflineEvaluationReport(input = {}) {
  if (!isPlainObject(input)) throw new TypeError('input must be an object');
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) throw new TypeError(`Unknown input key: ${key}`);
  }
  return {
    kind: OFFLINE_EVALUATION_REPORT_KIND,
    relationAccuracy: buildRelationAccuracy(input.relationQuestions),
    narrativeMentionValidity: buildNarrativeMentionValidity(input.narratives, input.authoritativeKeys),
    agentTaskSuccess: buildAgentTaskSuccess(input.recordedTaskEvidence),
    sampledJudge: buildSampledJudge(input.judgeEvidence),
  };
}
