#!/usr/bin/env node
// tools/project-memory-context/tools/offline-eval.mjs
//
// F5.2B / S21: LOCAL offline golden evaluation runner (source-tree runner,
// intentionally not an npm package command).
//
// It evaluates the covered layered-app golden relation questions
// (tests/fixtures/layered-app/expected.json) against observed answers produced
// by the CURRENT public MCP query/card surface — pmc_relations (incl.
// stopAtRole), pmc_entrypoints_for and pmc_impact — on an ISOLATED temp
// fixture assembled with the existing native extractors and the approved F2
// generic role seeding, exactly like the owned test harnesses do. Expected
// arrays are only ever read as the authoritative side of the comparison:
// observed values are never copied from them or hardcoded.
//
// Output contract:
//   - stdout: exactly one deterministic machine-readable JSON report (pretty
//     JSON, no timestamps/randomness/machine paths) — also emitted when the
//     gate fails so the report exists on golden mismatch;
//   - stderr: diagnostics only, each line prefixed `offline-eval: `;
//   - exit 0: evaluation succeeded and EVERY covered question matched
//     exactly (no precision/accuracy thresholds — exact set equality only);
//   - exit 1: evaluation succeeded but at least one covered question
//     mismatched the golden expectation (report still printed on stdout);
//   - exit 2: runner error / malformed golden or fixture input / CLI misuse
//     (no report on stdout).
//
// Honesty: narrative mention validity, agent task success and sampled judge
// sections stay `not-measured` with null numerics unless real recorded
// evidence is supplied — no validated fixture narrative artifacts and no
// recorded task/judge evidence exist today, and fabricating them is
// forbidden. Golden questions outside the coverage table are listed under
// `notMeasuredQuestions`, never silently evaluated or forced to pass.
//
// The stored fixture and the authoritative expected.json are read-only here;
// everything else happens in an owned temp directory that is removed on exit.
// No installs, no persistence, no inference, no network, no git access.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerQueryTools } from '../mcp/query-tools.mjs';
import { extractNativeCalls } from '../src/relations/native-calls.mjs';
import { extractNativeImportBindings } from '../src/relations/native-import-bindings.mjs';
import { extractSymbolsForFile } from '../src/extractors/tree-sitter/extract.mjs';
import { classifySymbol, loadProfile } from '../src/roles/classify.mjs';
import { buildFromGraphJson, createSqliteGraphStore, hashGraphJson } from '../src/graph-store/graph-db.mjs';
import { buildOfflineEvaluationReport } from '../src/evaluation/offline-report.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FIXTURE_DIR = join(packageRoot, 'tests', 'fixtures', 'layered-app');
const DEFAULT_EXPECTED = join(DEFAULT_FIXTURE_DIR, 'expected.json');

const USAGE = `usage: node tools/offline-eval.mjs [--help] [--expected <path>] [--fixture-dir <path>]

Deterministic offline golden evaluation runner (F5.2B / S21).
Evaluates the covered layered-app golden relation questions through the public
MCP query surface on an isolated temp fixture and prints one JSON report on
stdout (diagnostics only on stderr).

exit codes:
  0  evaluation succeeded, every covered golden question matched exactly
  1  covered golden mismatch (honest report still printed on stdout)
  2  runner/fixture/CLI error (message on stderr, no report)

options:
  --help, -h            show this help and exit 0
  --expected <path>     golden questions input
                         (default: tests/fixtures/layered-app/expected.json)
  --fixture-dir <path>  layered-app source directory
                         (default: tests/fixtures/layered-app)
`;

// The layered-app sources evaluated by the golden fixture (same fixed source
// set every owned harness uses; the fixture directory is read-only input).
const FIXTURE_SOURCES = [
  'src/cli/main.ts',
  'src/controllers/user.controller.ts',
  'src/services/user.service.ts',
  'src/repositories/user.repository.ts',
  'src/db/client.ts',
  'src/models/user.model.ts',
  'src/interfaces/user-repository.ts',
  'src/utils/format.ts',
  'src/views/user.view.ts',
  'tests/user.service.test.ts',
];

const SERVICE = 'ts|src/services/user.service.ts|method|member|UserService.findById|1';
const SERVICE_CLASS = 'ts|src/services/user.service.ts|class|exported|UserService|0';
const FORMAT = 'ts|src/utils/format.ts|function|exported|formatName|1';
const MAIN = 'ts|src/cli/main.ts|function|exported|main|0';
const RENDER = 'ts|src/views/user.view.ts|function|exported|renderUser|1';
const FIND_ONE = 'ts|src/repositories/user.repository.ts|method|member|UserRepository.findOne|1';
const USER_CONTROLLER = 'ts|src/controllers/user.controller.ts|class|exported|UserController|0';

const pickKeys = (result, field, side) => {
  if (!Array.isArray(result[field])) throw new Error(`unexpected tool shape: missing ${field}[]`);
  return result[field].map((entry) => {
    const value = side ? entry?.[side]?.symbolKey : entry?.symbolKey;
    if (typeof value !== 'string') throw new Error(`unexpected tool shape: ${field} entry without symbolKey`);
    return value;
  });
};

// Coverage table: golden question id -> public tool call -> observed symbol
// keys. Golden questions missing from this table are reported as
// `notMeasuredQuestions` (not-covered-by-current-public-api), never evaluated
// by proxy and never forced pass.
const COVERAGE = [
  { id: 'q1-callers-user-service-find-by-id', tool: 'pmc_relations',
    args: { target: SERVICE, direction: 'in', relations: ['calls'], depth: 1 },
    pick: (result) => pickKeys(result, 'edges', 'source') },
  { id: 'q2-callees-user-service-find-by-id', tool: 'pmc_relations',
    args: { target: SERVICE, direction: 'out', relations: ['calls'], depth: 1 },
    pick: (result) => pickKeys(result, 'edges', 'target') },
  { id: 'q3-dependents-format-name', tool: 'pmc_relations',
    args: { target: FORMAT, direction: 'in', relations: ['calls'], depth: 1 },
    pick: (result) => pickKeys(result, 'edges', 'source') },
  { id: 'q4-callers-main', tool: 'pmc_relations',
    args: { target: MAIN, direction: 'in', relations: ['calls'], depth: 1 },
    pick: (result) => pickKeys(result, 'edges', 'source') },
  { id: 'q5-callees-main', tool: 'pmc_relations',
    args: { target: MAIN, direction: 'out', relations: ['calls'], depth: 1 },
    pick: (result) => pickKeys(result, 'edges', 'target') },
  { id: 'q6-dependencies-render-user', tool: 'pmc_relations',
    args: { target: RENDER, direction: 'out', relations: ['calls'], depth: 1 },
    pick: (result) => pickKeys(result, 'edges', 'target') },
  { id: 'q7-nearest-controller-user-service', tool: 'pmc_relations',
    args: { target: SERVICE_CLASS, direction: 'in', relations: ['calls'], depth: 1, stopAtRole: 'controller' },
    pick: (result) => pickKeys(result, 'matches') },
  { id: 'q8-entrypoint-user-service', tool: 'pmc_entrypoints_for',
    args: { target: SERVICE_CLASS },
    pick: (result) => pickKeys(result, 'entrypoints') },
  { id: 'q9-callers-user-repository-find-one', tool: 'pmc_relations',
    args: { target: FIND_ONE, direction: 'in', relations: ['calls'], depth: 1 },
    pick: (result) => pickKeys(result, 'edges', 'source') },
  { id: 'q10-callees-user-repository-find-one', tool: 'pmc_relations',
    args: { target: FIND_ONE, direction: 'out', relations: ['calls'], depth: 1 },
    pick: (result) => pickKeys(result, 'edges', 'target') },
  { id: 'q11-imports-user-controller', tool: 'pmc_relations',
    args: { target: USER_CONTROLLER, direction: 'out', relations: ['imports'], depth: 1 },
    pick: (result) => pickKeys(result, 'edges', 'target') },
  { id: 'q12-tests-user-service', tool: 'pmc_impact',
    args: { target: SERVICE_CLASS },
    pick: (result) => pickKeys(result, 'tests') },
];

function parseArgs(argv) {
  const options = { help: false, expected: null, fixtureDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') { options.help = true; continue; }
    if (argument === '--expected' || argument === '--fixture-dir') {
      const value = argv[index + 1];
      if (value === undefined || !value.trim()) throw new Error(`missing value for ${argument}`);
      index += 1;
      if (argument === '--expected') options.expected = value;
      else options.fixtureDir = value;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function requireDirectory(path, label) {
  try {
    if (!statSync(path).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`${label} not found: ${path}`);
  }
  return path;
}

function requireFile(path, label) {
  try {
    if (!statSync(path).isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`${label} not found: ${path}`);
  }
  return path;
}

function readJson(path, label) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${label}: ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`malformed ${label}: ${path}: ${error.message}`);
  }
}

function loadGolden(path) {
  const golden = readJson(path, 'golden questions input');
  if (!Array.isArray(golden.questions) || golden.questions.length === 0) {
    throw new Error(`malformed golden questions input: ${path}: questions[] must be a non-empty array`);
  }
  const byId = new Map();
  for (const question of golden.questions) {
    if (question === null || typeof question !== 'object' || Array.isArray(question)) {
      throw new Error('malformed golden questions input: every question must be an object');
    }
    if (typeof question.id !== 'string' || !question.id.trim()) {
      throw new Error('malformed golden questions input: every question needs a non-blank id');
    }
    if (byId.has(question.id)) throw new Error(`malformed golden questions input: duplicate question id: ${question.id}`);
    byId.set(question.id, question);
  }
  return byId;
}

// Owned temp fixture: same assembly convention as the owned MCP harnesses
// (graph.json + graph.db + native relations + F2 role ledger), never touching
// the stored fixture directory.
async function buildIsolatedFixture(projectRoot, fixtureDir) {
  const pmcRoot = join(projectRoot, '.planning', 'project-memory-context');
  mkdirSync(join(pmcRoot, 'graph'), { recursive: true });
  mkdirSync(join(pmcRoot, 'enrichment'), { recursive: true });

  const files = FIXTURE_SOURCES.map((relativePath) => {
    try {
      return { path: relativePath, content: readFileSync(join(fixtureDir, relativePath), 'utf8') };
    } catch (error) {
      throw new Error(`fixture source missing: ${join(fixtureDir, relativePath)}: ${error.message}`);
    }
  });

  const calls = await extractNativeCalls({ files });
  const imports = await extractNativeImportBindings({ files });
  const graph = {
    nodes: calls.symbols.map((symbol) => ({
      id: symbol.id, label: symbol.id.split('|')[4], kind: symbol.kind,
      source_file: symbol.path, metadata: { symbolKey: symbol.id, semanticSummary: '' },
    })),
    links: [],
  };
  const json = JSON.stringify(graph);
  writeFileSync(join(pmcRoot, 'graph', 'graph.json'), json);
  const dbPath = join(pmcRoot, 'graph', 'graph.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE nodes(id TEXT PRIMARY KEY,label TEXT,kind TEXT,source_file TEXT,community INTEGER,degree INTEGER,metadata TEXT); CREATE TABLE edges(source TEXT,target TEXT,relation TEXT);');
    buildFromGraphJson(db, graph, hashGraphJson(json));
    const store = createSqliteGraphStore(db);
    store.persistNativeRelations(calls);
    store.persistNativeRelations(imports);
    // F2 generic role ledger from the actual extraction records — no
    // hardcoded roles, no golden edits (required by q7/q8/q12 coverage).
    const records = [];
    for (const file of files) records.push(...await extractSymbolsForFile({ filePath: file.path, content: file.content }));
    const profile = loadProfile('generic');
    const assignments = calls.symbols.map((symbol) => {
      const record = records.find((candidate) => candidate.symbolKey === symbol.symbolKey);
      if (!record) throw new Error(`fixture extraction record missing for ${symbol.symbolKey}`);
      return { endpoint: symbol, classification: classifySymbol(record, { profile, allSymbols: records }) };
    });
    const seeded = store.persistNodeRoles(assignments);
    if (seeded.updated !== assignments.length) {
      throw new Error(`role seeding incomplete: ${seeded.updated}/${assignments.length}`);
    }
  } finally {
    db.close();
  }

  const index = Object.fromEntries(calls.symbols.map((symbol) => [symbol.id, { graphNodeId: symbol.id, semanticSummary: '' }]));
  writeFileSync(join(pmcRoot, 'enrichment', 'symbol-index.json'), JSON.stringify(index));
  writeFileSync(join(pmcRoot, 'enrichment', 'worklist.json'),
    JSON.stringify(calls.symbols.map((symbol) => ({
      symbolKey: symbol.id, name: symbol.id.split('|')[4], filePath: symbol.path, kind: symbol.kind,
    }))));
}

async function connect(projectRoot) {
  const server = new McpServer({ name: 'offline-eval-fixture', version: '1.0.0' });
  registerQueryTools(server, { projectRoot });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'offline-eval-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) throw new Error(`tool ${name} failed: ${result.content?.[0]?.text ?? 'unknown error'}`);
  try {
    return JSON.parse(result.content[0].text);
  } catch (error) {
    throw new Error(`tool ${name} returned malformed JSON: ${error.message}`);
  }
}

const ENV_KEYS = ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP'];

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const fixtureDir = requireDirectory(resolve(options.fixtureDir ?? DEFAULT_FIXTURE_DIR), 'fixture directory');
  const expectedPath = requireFile(resolve(options.expected ?? DEFAULT_EXPECTED), 'golden questions input');
  const golden = loadGolden(expectedPath);

  const coveredIds = new Set();
  const coveredQuestions = [];
  for (const entry of COVERAGE) {
    const question = golden.get(entry.id);
    if (!question) throw new Error(`covered golden question missing from input: ${entry.id}`);
    if (!Array.isArray(question.expected)) throw new Error(`expected must be an array for question: ${entry.id}`);
    coveredIds.add(entry.id);
    coveredQuestions.push({ entry, question });
  }
  if (coveredQuestions.length === 0) throw new Error('no covered golden questions found in input');
  const notMeasuredQuestions = [...golden.keys()]
    .filter((id) => !coveredIds.has(id))
    .sort()
    .map((id) => ({ id, reason: 'not-covered-by-current-public-api' }));

  const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const envRoot = mkdtempSync(join(tmpdir(), 'pmc-offline-eval-'));
  let client = null;
  let server = null;
  let evaluation;
  try {
    for (const key of ENV_KEYS) process.env[key] = envRoot;
    const projectRoot = mkdtempSync(join(envRoot, 'project-'));
    await buildIsolatedFixture(projectRoot, fixtureDir);
    ({ client, server } = await connect(projectRoot));

    const relationQuestions = [];
    for (const { entry, question } of coveredQuestions) {
      const result = await callTool(client, entry.tool, entry.args);
      relationQuestions.push({ id: entry.id, expected: question.expected, observed: entry.pick(result) });
    }
    // Only relation evidence is supplied: narrative/agent-task/judge evidence
    // does not exist in this fixture, so those sections stay not-measured.
    evaluation = buildOfflineEvaluationReport({ relationQuestions });
  } finally {
    try { await client?.close(); } catch { /* already closed */ }
    try { await server?.close(); } catch { /* already closed */ }
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    try { rmSync(envRoot, { recursive: true, force: true }); } catch { /* owned temp removed best-effort */ }
  }

  const mismatchedQuestionIds = evaluation.relationAccuracy.questions
    .filter((question) => question.exactMatch === false)
    .map((question) => question.id);
  const report = {
    kind: 'offline-evaluation-run',
    fixture: basename(fixtureDir),
    coveredQuestionIds: COVERAGE.map((entry) => entry.id),
    notMeasuredQuestions,
    gate: { status: mismatchedQuestionIds.length === 0 ? 'pass' : 'fail', mismatchedQuestionIds },
    evaluation,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (mismatchedQuestionIds.length > 0) {
    for (const id of mismatchedQuestionIds) {
      const question = evaluation.relationAccuracy.questions.find((entry) => entry.id === id);
      process.stderr.write(
        `offline-eval: golden mismatch: ${id} `
        + `(exactMatch=false, falsePositives=${question.falsePositives}, falseNegatives=${question.falseNegatives})\n`,
      );
    }
    return 1;
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`offline-eval: ${error?.message ?? String(error)}\n`);
    process.exitCode = 2;
  },
);
