// tools/project-memory-context/tests/offline-eval-runner.test.mjs
//
// F5.2B / S21: contract tests for the PUBLIC offline evaluation runner
// `tools/offline-eval.mjs`. The runner must:
//   - emit ONE deterministic machine-readable JSON report on stdout (clean
//     JSON only), diagnostics on stderr, and preserve nonzero exit status;
//   - exit 0 only when every covered golden relation question matches the
//     authoritative expected arrays EXACTLY (no precision thresholds);
//   - exit 1 with an honest report (still emitted on stdout) plus a stderr
//     diagnostic when a covered golden question mismatches;
//   - exit 2 on runner errors, malformed golden/fixture input or CLI misuse,
//     with an empty stdout and a stderr message prefixed `offline-eval:`;
//   - produce observed relation answers from the current public query/card
//     surface on an ISOLATED temp fixture — never mutate the stored
//     layered-app fixture, its sources or the authoritative expected.json;
//   - report narrative / agent-task / sampled-judge sections as
//     `not-measured` with null numerics (no validated fixture narrative
//     artifacts and no recorded task/judge evidence exist — fabricated
//     semantic evidence is forbidden).
//
// This file NEVER imports or executes tests/relational-eval.test.mjs and the
// authoritative golden fixture is only read (hash-verified before/after).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = join(packageRoot, 'tools', 'offline-eval.mjs');
const FIXTURE_DIR = join(packageRoot, 'tests', 'fixtures', 'layered-app');
const GOLDEN = join(FIXTURE_DIR, 'expected.json');

// The exact covered question ids (F5.2B coverage list — q1..q12 are all
// supported by the current public MCP query surface; unsupported golden
// questions must surface under `notMeasuredQuestions`, never a forced pass).
const COVERED = [
  'q1-callers-user-service-find-by-id',
  'q2-callees-user-service-find-by-id',
  'q3-dependents-format-name',
  'q4-callers-main',
  'q5-callees-main',
  'q6-dependencies-render-user',
  'q7-nearest-controller-user-service',
  'q8-entrypoint-user-service',
  'q9-callers-user-repository-find-one',
  'q10-callees-user-repository-find-one',
  'q11-imports-user-controller',
  'q12-tests-user-service',
];

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function hashTree(dir) {
  const hash = createHash('sha256');
  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = join(current, entry.name);
      const rel = relative(dir, full).split('\\').join('/');
      if (entry.isDirectory()) {
        hash.update(`D:${rel}\n`);
        walk(full);
      } else if (entry.isFile()) {
        hash.update(`F:${rel}\n`);
        hash.update(readFileSync(full));
      }
    }
  };
  walk(dir);
  return hash.digest('hex');
}

function authoritativeState() {
  return { fixtureTree: hashTree(FIXTURE_DIR), golden: sha256(readFileSync(GOLDEN)) };
}

function runRunner(args) {
  const result = spawnSync(process.execPath, [RUNNER, ...args], {
    encoding: 'utf8', timeout: 30000, cwd: packageRoot,
  });
  assert.equal(result.error, undefined,
    `runner spawn failed/timed out: ${result.error?.message ?? 'unknown'}`);
  return result;
}

test('--help exits 0 with usage on stdout and clean stderr', () => {
  const result = runRunner(['--help']);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^usage: node tools\/offline-eval\.mjs/);
  assert.match(result.stdout, /--expected/);
  assert.match(result.stdout, /--fixture-dir/);
  assert.doesNotMatch(result.stdout, /\{/); // help is text, not a half-emitted report
});

test('default fixture run: exact schema, gate pass, honest not-measured sections, fixture preserved', () => {
  const before = authoritativeState();
  const result = runRunner([]);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.equal(result.stderr, '', 'success leaves stderr clean');
  assert.ok(result.stdout.startsWith('{'), 'stdout is clean JSON');
  const report = JSON.parse(result.stdout);

  assert.deepEqual(Object.keys(report).sort(),
    ['coveredQuestionIds', 'evaluation', 'fixture', 'gate', 'kind', 'notMeasuredQuestions']);
  assert.equal(report.kind, 'offline-evaluation-run');
  assert.equal(report.fixture, 'layered-app');
  assert.deepEqual(report.coveredQuestionIds, COVERED);
  assert.deepEqual(report.notMeasuredQuestions, []);
  assert.deepEqual(report.gate, { status: 'pass', mismatchedQuestionIds: [] });

  const evaluation = report.evaluation;
  assert.deepEqual(Object.keys(evaluation).sort(),
    ['agentTaskSuccess', 'kind', 'narrativeMentionValidity', 'relationAccuracy', 'sampledJudge']);
  assert.equal(evaluation.kind, 'offline-evaluation-report');

  const relation = evaluation.relationAccuracy;
  assert.equal(relation.status, 'measured');
  assert.equal(relation.questionCount, COVERED.length);
  assert.equal(relation.exactMatchCount, COVERED.length, 'every covered question matches exactly');
  assert.equal(relation.exactMatchRate, 1);
  assert.equal(relation.totalTruePositives > 0, true, 'the gate is non-vacuous');
  assert.equal(relation.totalFalsePositives, 0);
  assert.equal(relation.totalFalseNegatives, 0);
  assert.equal(relation.questions.length, COVERED.length);
  assert.deepEqual(relation.questions.map((q) => q.id).sort(), [...COVERED].sort());
  assert.ok(relation.questions.every((q) => q.exactMatch === true));

  assert.equal(evaluation.narrativeMentionValidity.status, 'not-measured');
  assert.equal(evaluation.narrativeMentionValidity.reason, 'no-narrative-evidence');
  assert.equal(evaluation.narrativeMentionValidity.narrativeCount, 0);
  assert.equal(evaluation.narrativeMentionValidity.mentionValidity, null);
  assert.equal(evaluation.agentTaskSuccess.status, 'not-measured');
  assert.equal(evaluation.agentTaskSuccess.reason, 'no-recorded-task-evidence');
  assert.equal(evaluation.agentTaskSuccess.successRate, null);
  assert.equal(evaluation.agentTaskSuccess.taskCount, 0);
  assert.equal(evaluation.sampledJudge.status, 'not-measured');
  assert.equal(evaluation.sampledJudge.reason, 'no-recorded-judge-evidence');
  assert.equal(evaluation.sampledJudge.passRate, null);
  assert.equal(evaluation.sampledJudge.sampleCount, 0);

  assert.deepEqual(authoritativeState(), before, 'stored fixture/golden stay byte-identical');
});

test('changed expected golden: exit 1, honest mismatch report, stderr diagnostic, uncovered question not measured', () => {
  const before = authoritativeState();
  const tempDir = mkdtempSync(join(tmpdir(), 'offline-eval-owned-golden-'));
  try {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
    const mutatedId = 'q1-callers-user-service-find-by-id';
    const mutated = golden.questions.find((question) => question.id === mutatedId);
    assert.ok(mutated, 'mutated question exists in the authoritative golden');
    mutated.expected = [...mutated.expected, 'ts|src/ghosts.ts|function|exported|ghost|0'];
    // A golden question outside the coverage table must be reported as
    // not-measured — never silently evaluated, never forced pass.
    golden.questions.push({
      id: 'q99-future-uncovered', type: 'future-question',
      target: 'ts|src/ghosts.ts|function|exported|ghost|0',
      expected: ['ts|src/ghosts.ts|function|exported|ghost|0'],
    });
    const mutatedPath = join(tempDir, 'expected-mutated.json');
    writeFileSync(mutatedPath, JSON.stringify(golden, null, 2));

    const result = runRunner(['--expected', mutatedPath]);
    assert.equal(result.status, 1, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /mismatch/);
    assert.ok(result.stderr.includes(mutatedId), 'diagnostic names the mismatching question');
    assert.ok(result.stdout.startsWith('{'), 'honest report is still emitted on stdout');

    const report = JSON.parse(result.stdout);
    assert.equal(report.kind, 'offline-evaluation-run');
    assert.deepEqual(report.gate, { status: 'fail', mismatchedQuestionIds: [mutatedId] });
    assert.deepEqual(report.notMeasuredQuestions,
      [{ id: 'q99-future-uncovered', reason: 'not-covered-by-current-public-api' }]);

    const relation = report.evaluation.relationAccuracy;
    assert.equal(relation.status, 'measured');
    assert.equal(relation.questionCount, COVERED.length, 'uncovered questions are not evaluated');
    assert.equal(relation.exactMatchCount, COVERED.length - 1);
    const question = relation.questions.find((entry) => entry.id === mutatedId);
    assert.equal(question.exactMatch, false);
    assert.equal(question.falseNegatives, 1, 'the ghost expected value was honestly not observed');
    assert.equal(question.falsePositives, 0);
    assert.equal(question.observedValues.includes('ts|src/ghosts.ts|function|exported|ghost|0'), false,
      'observed values come from the live surface, never from the mutated expectation');
    assert.equal(report.evaluation.narrativeMentionValidity.status, 'not-measured');
    assert.equal(report.evaluation.agentTaskSuccess.status, 'not-measured');
    assert.equal(report.evaluation.sampledJudge.status, 'not-measured');

    assert.deepEqual(authoritativeState(), before, 'authoritative fixture/golden stay byte-identical');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('malformed expected input: exit 2, empty stdout, prefixed stderr, fixture preserved', () => {
  const before = authoritativeState();
  const tempDir = mkdtempSync(join(tmpdir(), 'offline-eval-owned-broken-'));
  try {
    const brokenPath = join(tempDir, 'expected-broken.json');
    writeFileSync(brokenPath, '{ this is not valid json');
    const result = runRunner(['--expected', brokenPath]);
    assert.equal(result.status, 2, `stderr: ${result.stderr}`);
    assert.equal(result.stdout, '', 'no partial report on runner error');
    assert.match(result.stderr, /^offline-eval: /);
    assert.deepEqual(authoritativeState(), before, 'authoritative fixture/golden stay byte-identical');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('missing fixture directory: exit 2, empty stdout, prefixed stderr, fixture preserved', () => {
  const before = authoritativeState();
  const missing = join(packageRoot, 'tests', 'fixtures', 'offline-eval-does-not-exist');
  assert.equal(existsSync(missing), false, 'probe path stays absent');
  const result = runRunner(['--fixture-dir', missing]);
  assert.equal(result.status, 2, `stderr: ${result.stderr}`);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^offline-eval: /);
  assert.ok(result.stderr.includes('fixture'), 'diagnostic names the fixture problem');
  assert.deepEqual(authoritativeState(), before, 'authoritative fixture/golden stay byte-identical');
});

test('two default runs emit byte-identical reports (no temp/timestamp leakage)', () => {
  const first = runRunner([]);
  assert.equal(first.status, 0, `stderr: ${first.stderr}`);
  const second = runRunner([]);
  assert.equal(second.status, 0, `stderr: ${second.stderr}`);
  assert.equal(first.stderr, '');
  assert.equal(second.stderr, '');
  assert.equal(first.stdout, second.stdout,
    'the report is deterministic across independent isolated temp fixtures');
});

test('unknown CLI argument: exit 2 with usage diagnostic and no report', () => {
  const result = runRunner(['--bogus-flag']);
  assert.equal(result.status, 2, `stderr: ${result.stderr}`);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^offline-eval: /);
});
