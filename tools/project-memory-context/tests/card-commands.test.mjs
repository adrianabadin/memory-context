import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, renameSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { registerQueryTools } from '../mcp/query-tools.mjs';
import { createRelationsReader } from '../src/query/relations.mjs';
import { extractNativeCalls } from '../src/relations/native-calls.mjs';
import { extractNativeImportBindings } from '../src/relations/native-import-bindings.mjs';
import { buildFromGraphJson, createSqliteGraphStore } from '../src/graph-store/graph-db.mjs';
import { narrativeMemoryPath } from '../src/cards/narrative-cache.mjs';
import { PROMPT_VERSION } from '../src/cards/prompt-v2.mjs';

// S23 — public aggregate-card exposure (MCP + CLI) over S18/S19 builders.
// All probes run on ONE isolated owned layered-app fixture in tmpdir: never the
// live repo DB, never production commands. Narratives come only from accepted
// `.memory.json` artifacts bound three ways (symbol-index ↔ worklist ↔ artifact
// narrativeEvidence). Invalid inputs must leave DB/schema/roles/config/
// artifacts byte-identical (final preservation test).

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(TEST_DIR, '..');
const BIN_PATH = resolve(PACKAGE_ROOT, 'bin', 'pmc.mjs');

const MAIN = 'src/cli/main.ts';
const CONTROLLER = 'src/controllers/user.controller.ts';
const MODEL = 'src/models/user.model.ts';
const REPO = 'src/repositories/user.repository.ts';
const SERVICE = 'src/services/user.service.ts';
const FORMAT = 'src/utils/format.ts';
const TESTS_FILE = 'tests/user.service.test.ts';
const STANDALONE = 'src/views/user.view.ts'; // coherent file endpoint, no extracted symbols

const CLASS = 'ts|src/services/user.service.ts|class|exported|UserService|0';
const METHOD = 'ts|src/services/user.service.ts|method|member|UserService.findById|1';
const CTOR = 'ts|src/services/user.service.ts|method|member|UserService.constructor|1';
const REPO_CLASS = 'ts|src/repositories/user.repository.ts|class|exported|UserRepository|0';
const REPO_CTOR = 'ts|src/repositories/user.repository.ts|method|member|UserRepository.constructor|1';
const REPO_FIND = 'ts|src/repositories/user.repository.ts|method|member|UserRepository.findOne|1';
const CONTROLLER_CLASS = 'ts|src/controllers/user.controller.ts|class|exported|UserController|0';
const COLLIDE_DOT = `ts|${FORMAT}|function|exported|collide.x|0`;
const COLLIDE_US = `ts|${FORMAT}|function|exported|collide_x|0`; // sanitizes to the SAME artifact filename
const GHOST = 'ts|src/auth.ts|function|exported|ghost|0';

const SCANNED_FILES = [
  MAIN, CONTROLLER, MODEL, REPO, SERVICE, FORMAT, STANDALONE, TESTS_FILE,
].sort();

const METHOD_SUMMARY = 'Locates a user record by its identifier.';
const COLLIDE_SUMMARY = 'Formats identifiers deterministically.';
const SEMANTIC_METHOD = 'Finds a user by ID.';
const SEMANTIC_CLASS = 'A user service aggregate.';

const HELP_TEXT = [
  'Usage: pmc card file <path>',
  '       pmc card community <community-id>',
  '       pmc card feature <name> --member <canonical-key> [--member <canonical-key>]',
  '',
  'Aggregate card commands: deterministic read-only cards over the existing graph and accepted narrative artifacts. JSON on stdout; diagnostics on stderr.',
  '',
  'Options:',
  '  --member <canonical-key>   Explicit canonical symbol or file key (repeatable; feature cards)',
  '  --help, -h                 Show this help',
  '',
  'Examples:',
  '  pmc card file src/services/user.service.ts',
  '  pmc card community 1',
  '  pmc card feature auth --member "ts|src/auth.ts|function|exported|login|2" --member file|src/auth.ts',
  '',
].join('\n');

const fingerprint = hash => ({ narrativeHash: hash, calleeSummaryHashes: {}, promptVersion: PROMPT_VERSION });
const narrative = (summary, mentions = []) => ({
  summary, behavior: ['Looks things up.'], sideEffects: [], errors: [], contracts: [],
  changeNotes: 'Stable.', mentions,
});

let root;
let pmc;
let enrichmentDir;
let dbPath;
let indexPath;
let worklistPath;
let client;
let server;
let MODEL_KEY;
let GOLDEN;

const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');

function artifactSnapshot() {
  const out = {};
  if (existsSync(enrichmentDir)) {
    for (const name of readdirSync(enrichmentDir).sort()) out[name] = sha(join(enrichmentDir, name));
  }
  return out;
}

function snapshotState() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let tables;
  try {
    tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(r => r.name);
  } finally { db.close(); }
  return {
    dbHash: sha(dbPath),
    indexHash: sha(indexPath),
    worklistHash: sha(worklistPath),
    installHash: sha(join(pmc, 'install.json')),
    tables,
    artifacts: artifactSnapshot(),
  };
}

async function connect(projectRoot, register = registerQueryTools) {
  const mcpServer = new McpServer({ name: 'aggregate-cards-fixture', version: '1.0.0' });
  register(mcpServer, { projectRoot });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(st);
  const mcpClient = new Client({ name: 'aggregate-cards-client', version: '1.0.0' });
  await mcpClient.connect(ct);
  return { server: mcpServer, client: mcpClient };
}

function scrubbedEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^PMC_/.test(key) || key === 'MEMORY_DB_PATH') continue;
    env[key] = value;
  }
  for (const key of ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP']) env[key] = join(root, 'sandbox');
  return env;
}

function runCli(args, { cwd = root, binPath = BIN_PATH } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd,
      env: scrubbedEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (signal) { rejectPromise(new Error(`CLI exited from signal ${signal}`)); return; }
      resolvePromise({ code: code ?? 0, stdout, stderr });
    });
  });
}

async function mcpText(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, result.content[0]?.text);
  return result.content[0].text;
}

async function mcpPayload(name, args) {
  return JSON.parse(await mcpText(name, args));
}

async function mcpError(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `expected ${name} to be an isError response`);
  return result;
}

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'pmc-aggregate-cards-'));
  pmc = join(root, '.planning', 'project-memory-context');
  enrichmentDir = join(pmc, 'enrichment');
  dbPath = join(pmc, 'graph', 'graph.db');
  indexPath = join(enrichmentDir, 'symbol-index.json');
  worklistPath = join(enrichmentDir, 'worklist.json');
  mkdirSync(join(pmc, 'graph'), { recursive: true });
  mkdirSync(enrichmentDir, { recursive: true });
  mkdirSync(join(root, 'sandbox'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true }); // nested-cwd walk-up probe
  writeFileSync(join(pmc, 'install.json'), JSON.stringify({ installedAt: '2026-05-19T00:00:00.000Z', version: '0.1.0' }, null, 2));

  const paths = [MAIN, CONTROLLER, SERVICE, REPO, MODEL, FORMAT, TESTS_FILE];
  const files = paths.map(path => ({ path, content: readFileSync(new URL(`./fixtures/layered-app/${path}`, import.meta.url), 'utf8') }));
  const calls = await extractNativeCalls({ files });
  const community = { [SERVICE]: 1, [REPO]: 1, [CONTROLLER]: 2, [MODEL]: 3 };
  const nodes = calls.symbols.map(symbol => ({
    id: symbol.id, label: symbol.id.split('|')[4], kind: symbol.kind, source_file: symbol.path,
    community: community[symbol.path] ?? null, metadata: { symbolKey: symbol.id },
  }));
  MODEL_KEY = (() => {
    const inModel = calls.symbols.filter(s => s.path === MODEL);
    const klass = inModel.find(s => s.kind === 'class') ?? inModel[0];
    assert.ok(klass, 'fixture must carry at least one model symbol');
    return klass.id;
  })();
  nodes.push(
    { id: COLLIDE_DOT, label: 'collide.x', kind: 'function', source_file: FORMAT, community: null, metadata: { symbolKey: COLLIDE_DOT } },
    { id: COLLIDE_US, label: 'collide_x', kind: 'function', source_file: FORMAT, community: null, metadata: { symbolKey: COLLIDE_US } },
    // Coherent standalone file endpoint with no extracted symbols: must still
    // be enumerated internally by the community card.
    { id: `file|${STANDALONE}`, label: STANDALONE, kind: 'file', source_file: STANDALONE, community: null },
  );
  const graph = { nodes, links: [] };
  const graphJson = JSON.stringify(graph);

  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE nodes(id TEXT PRIMARY KEY,label TEXT,kind TEXT,source_file TEXT,community INTEGER,degree INTEGER,metadata TEXT); CREATE TABLE edges(source TEXT,target TEXT,relation TEXT); CREATE TABLE community_names(community_id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT,updated_at TEXT);');
    buildFromGraphJson(db, graph, createHash('sha256').update(graphJson).digest('hex'));
    const store = createSqliteGraphStore(db);
    store.persistNativeRelations(calls);
    store.persistNativeRelations(await extractNativeImportBindings({ files }));
    store.upsertCommunityName('1', 'Persistence & Service');
  } finally { db.close(); }

  // symbol-index: every extracted/collided key bound to its node; fingerprint
  // bundles only where the stage demands them.
  const staged = {
    [METHOD]: { semanticSummary: SEMANTIC_METHOD, ...fingerprint('nh-method') },
    [CLASS]: { semanticSummary: SEMANTIC_CLASS, ...fingerprint('nh-class') },
    [REPO_FIND]: { ...fingerprint('nh-repo') },
    [CONTROLLER_CLASS]: { ...fingerprint('nh-controller') },
    [MODEL_KEY]: { ...fingerprint('nh-model') },
    [COLLIDE_DOT]: { ...fingerprint('nh-collide') },
    [COLLIDE_US]: { ...fingerprint('nh-collide-alt') },
  };
  const symbolIndex = {};
  const worklist = [];
  for (const symbol of [...calls.symbols,
    { id: COLLIDE_DOT, kind: 'function', path: FORMAT },
    { id: COLLIDE_US, kind: 'function', path: FORMAT }]) {
    symbolIndex[symbol.id] = { graphNodeId: symbol.id, status: 'enriched', semanticSummary: '', ...(staged[symbol.id] ?? {}) };
    worklist.push({ symbolKey: symbol.id, name: symbol.id.split('|')[4], filePath: symbol.path, kind: symbol.kind });
  }
  // CTOR: worklist fingerprint present, index fingerprint deliberately absent.
  worklist.find(entry => entry.symbolKey === CTOR).narrativeHash = 'nh-ctor';
  worklist.find(entry => entry.symbolKey === CTOR).calleeSummaryHashes = {};
  worklist.find(entry => entry.symbolKey === CTOR).promptVersion = PROMPT_VERSION;
  for (const [key, hash] of [[METHOD, 'nh-method'], [CLASS, 'nh-class'], [REPO_FIND, 'nh-repo'],
    [CONTROLLER_CLASS, 'nh-controller'], [MODEL_KEY, 'nh-model'],
    [COLLIDE_DOT, 'nh-collide'], [COLLIDE_US, 'nh-collide-alt']]) {
    const entry = worklist.find(item => item.symbolKey === key);
    entry.narrativeHash = hash;
    entry.calleeSummaryHashes = {};
    entry.promptVersion = PROMPT_VERSION;
  }
  writeFileSync(indexPath, JSON.stringify(symbolIndex, null, 2));
  writeFileSync(worklistPath, JSON.stringify(worklist, null, 2));

  // Accepted-artifact matrix at canonical narrativeMemoryPath locations.
  const writeArtifact = (key, payload) =>
    writeFileSync(narrativeMemoryPath(enrichmentDir, key), typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
  const accepted = (key, summary, hash, mentions = []) => ({
    content: JSON.stringify(narrative(summary, mentions)),
    category: 'architecture',
    tags: ['symbol', 'ts', 'function'],
    narrativeEvidence: { symbolKey: key, ...fingerprint(hash) },
  });
  writeArtifact(METHOD, accepted(METHOD, METHOD_SUMMARY, 'nh-method', [CLASS]));
  writeArtifact(REPO_FIND, accepted(REPO_FIND, 'Finds a repository row.', 'nh-repo-STALE'));
  writeArtifact(CONTROLLER_CLASS, {
    content: JSON.stringify({ ...narrative(`${Array(26).fill('word').join(' ')}`), mentions: [] }),
    category: 'architecture', tags: ['symbol', 'ts', 'class'],
    narrativeEvidence: { symbolKey: CONTROLLER_CLASS, ...fingerprint('nh-controller') },
  });
  // Payload itself is not JSON: must surface as corrupt-artifact.
  writeArtifact(MODEL_KEY, '{BROKEN-ARTIFACT-JSON');
  writeArtifact(COLLIDE_DOT, accepted(COLLIDE_DOT, COLLIDE_SUMMARY, 'nh-collide'));
  // CTOR artifact exists and is internally consistent, but the index carries no
  // fingerprint: acceptance cannot be proven, so it must be withheld.
  writeArtifact(CTOR, accepted(CTOR, 'Constructs the service.', 'nh-ctor'));

  ({ server, client } = await connect(root));
  GOLDEN = snapshotState();
});

after(async () => {
  await client?.close();
  await server?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

// ── Registry inventory: additive 8 → 11, old descriptors byte-pinned ─────────

test('S23 registry inventory is exactly the 11 tools (8 existing + 3 new aggregate cards)', async () => {
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'pmc_card', 'pmc_community_card', 'pmc_entrypoints_for', 'pmc_feature_card', 'pmc_file_rollup',
    'pmc_get_dependencies', 'pmc_get_dependents', 'pmc_impact', 'pmc_query_project',
    'pmc_relations', 'pmc_search_symbols',
  ]);
});

test('S23 the eight pre-existing tool descriptors stay byte-identical (pinned literals, no git history reads)', async () => {
  const tools = (await client.listTools()).tools;
  const expectedDescriptions = {
    pmc_query_project: 'Query PMC project context and symbol artifacts using a natural-language question.',
    pmc_search_symbols: 'Search PMC symbols by semantic summary and optional file path filter.',
    pmc_get_dependents: 'List symbols that depend on the given symbol key.',
    pmc_get_dependencies: 'List symbols the given symbol key depends on.',
    pmc_relations: 'Read typed canonical relationships from graph.db; ambiguous targets return candidates; optional stopAtRole stops the walk at the first node with that canonical role.',
    pmc_entrypoints_for: 'Which CLI commands, MCP tools, routes, or `main` functions reach X: complete reverse call reachability from the target, returning the canonical role match union plus its `entrypoints` (role entrypoint/cli-command/mcp-tool or an entrypoint layer) and `controllers` (role controller) projections with distance and evidence path.',
    pmc_impact: 'Dependents, covering tests and affected roles for X, ranked by a deterministic dependency-free PageRank over the full known canonical calls/imports graph; covering tests are static import/test-path candidates, never executed coverage.',
    pmc_card: 'Read symbol/file facts and existing enrichment text; no role or narrative generation. Omit `level` for the legacy facts-only payload. With `level`, returns a leveled card capped by a deterministic token ceiling (compact 2000 essentials, extended 5000 adds relation context, deep 10000 adds role evidence); ceilings are caps, never padded, and oversized lower-priority sections are dropped before essentials.',
  };
  const expectedProperties = {
    pmc_query_project: ['question'],
    pmc_search_symbols: ['query', 'file'],
    pmc_get_dependents: ['symbol'],
    pmc_get_dependencies: ['symbol'],
    pmc_relations: ['target', 'direction', 'relations', 'depth', 'stopAtRole'],
    pmc_entrypoints_for: ['target'],
    pmc_impact: ['target'],
    pmc_card: ['target', 'level'],
  };
  const expectedRequired = {
    pmc_query_project: ['question'],
    pmc_search_symbols: ['query'],
    pmc_get_dependents: ['symbol'],
    pmc_get_dependencies: ['symbol'],
    pmc_relations: ['target'],
    pmc_entrypoints_for: ['target'],
    pmc_impact: ['target'],
    pmc_card: ['target'],
  };
  const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  for (const [name, description] of Object.entries(expectedDescriptions)) {
    const tool = tools.find(candidate => candidate.name === name);
    assert.ok(tool, `${name} stays registered`);
    assert.equal(tool.description, description, `${name} description stays byte-identical`);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), expectedProperties[name], `${name} properties unchanged`);
    assert.deepEqual(tool.inputSchema.required, expectedRequired[name], `${name} required unchanged`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${name} stays strict`);
    if (['pmc_relations', 'pmc_entrypoints_for', 'pmc_impact', 'pmc_card'].includes(name)) {
      assert.deepEqual(tool.annotations, readOnlyAnnotations, `${name} annotations unchanged`);
    }
  }
});

test('S23 the three new tools are read-only, strict and carry no level argument', async () => {
  const tools = (await client.listTools()).tools;
  const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const expectations = {
    pmc_file_rollup: ['target'],
    pmc_community_card: ['communityId'],
    pmc_feature_card: ['name', 'members'],
  };
  for (const [name, properties] of Object.entries(expectations)) {
    const tool = tools.find(candidate => candidate.name === name);
    assert.ok(tool, `${name} joins the shared query registry`);
    assert.deepEqual(tool.annotations, readOnlyAnnotations);
    assert.deepEqual(Object.keys(tool.inputSchema.properties), properties, `${name} accepts only its own inputs`);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.required, properties, `${name} requires exactly its own inputs`);
    assert.ok(!('level' in tool.inputSchema.properties), `${name} has no level argument`);
    assert.ok(typeof tool.description === 'string' && tool.description.length > 0);
  }
});

test('S23 reader methods and the aggregate-cards helper exist on the shared reader', async () => {
  const reader = createRelationsReader({ projectRoot: root });
  assert.equal(typeof reader.fileRollup, 'function');
  assert.equal(typeof reader.communityCard, 'function');
  assert.equal(typeof reader.featureCard, 'function');
  const helper = await import('../src/query/aggregate-cards.mjs');
  assert.equal(typeof helper.loadAcceptedNarratives, 'function');
  assert.equal(typeof helper.enumerateKnownFilePaths, 'function');
});

// ── pmc_file_rollup ──────────────────────────────────────────────────────────

test('S23 file rollup: accepted artifact provenance with exact payload and honest diagnostics', async () => {
  const payload = await mcpPayload('pmc_file_rollup', { target: SERVICE });
  assert.deepEqual(payload, {
    status: 'resolved',
    target: SERVICE,
    path: SERVICE,
    kind: 'file-narrative-rollup',
    narratives: [{ symbolKey: METHOD, summary: METHOD_SUMMARY }],
    text: `- ${METHOD}: ${METHOD_SUMMARY}`,
    rejected: [],
    diagnostics: [
      { symbolKey: CLASS, reason: 'no-accepted-artifact' },
      { symbolKey: CTOR, reason: 'missing-index-fingerprint' },
    ],
  });
  // Byte-deterministic across independent calls.
  const first = await mcpText('pmc_file_rollup', { target: SERVICE });
  const second = await mcpText('pmc_file_rollup', { target: SERVICE });
  assert.equal(first, second);
  assert.equal(first, JSON.stringify(payload, null, 2));
});

test('S23 file rollup: file|<path> spelling resolves to the same rollup', async () => {
  const payload = await mcpPayload('pmc_file_rollup', { target: `file|${SERVICE}` });
  assert.equal(payload.status, 'resolved');
  assert.equal(payload.path, SERVICE);
});

test('S23 file rollup: a symbol target is never silently treated as a file', async () => {
  const payload = await mcpPayload('pmc_file_rollup', { target: CLASS });
  assert.deepEqual(payload, {
    status: 'not-a-file',
    reason: 'target-resolves-to-symbol',
    target: CLASS,
    candidates: [],
  });
});

test('S23 file rollup: missing files keep the shared missing shape', async () => {
  const payload = await mcpPayload('pmc_file_rollup', { target: 'src/missing.ts' });
  assert.deepEqual(payload, { status: 'missing', candidates: [] });
});

test('S23 file rollup: no accepted artifacts anywhere yields an honest empty rollup, never semanticSummary text', async () => {
  const payload = await mcpPayload('pmc_file_rollup', { target: MAIN });
  assert.equal(payload.status, 'resolved');
  assert.deepEqual(payload.narratives, []);
  assert.equal(payload.text, '');
  const mainKeys = payload.diagnostics.map(item => item.symbolKey);
  assert.deepEqual([...mainKeys].sort(), mainKeys, 'diagnostics sorted by canonical key');
  assert.ok(mainKeys.length > 0, 'every probed member is honestly reported');
  for (const item of payload.diagnostics) assert.equal(item.reason, 'no-accepted-artifact');
  // CLASS carries an index semanticSummary but no artifact: the summary must
  // never appear as structured narrative content.
  const service = await mcpPayload('pmc_file_rollup', { target: SERVICE });
  assert.ok(!service.text.includes(SEMANTIC_CLASS));
  assert.ok(!service.narratives.some(item => item.summary === SEMANTIC_CLASS));
});

test('S23 file rollup: stale, malformed and foreign artifacts are withheld with truthful diagnostics', async () => {
  const repo = await mcpPayload('pmc_file_rollup', { target: REPO });
  assert.ok(!repo.narratives.some(item => item.symbolKey === REPO_FIND), 'stale artifact never becomes content');
  assert.ok(repo.diagnostics.some(item => item.symbolKey === REPO_FIND && item.reason === 'fingerprint-mismatch'));

  const controller = await mcpPayload('pmc_file_rollup', { target: CONTROLLER });
  const controllerDiagnostic = controller.diagnostics.find(item => item.symbolKey === CONTROLLER_CLASS);
  assert.equal(controllerDiagnostic.reason, 'invalid-content');
  assert.ok(controllerDiagnostic.errors.some(error => /at most 25 words/.test(error)));
  assert.deepEqual(controller.narratives, []);

  const model = await mcpPayload('pmc_file_rollup', { target: MODEL });
  assert.ok(model.diagnostics.some(item => item.symbolKey === MODEL_KEY && item.reason === 'corrupt-artifact'));
  assert.deepEqual(model.narratives, []);
});

test('S23 file rollup: sanitized filename collision never aliases a foreign artifact (wrong-key withheld)', async () => {
  const payload = await mcpPayload('pmc_file_rollup', { target: FORMAT });
  // Both keys sanitize to the SAME .memory.json filename; only the key whose
  // evidence matches is accepted.
  assert.deepEqual(payload.narratives, [{ symbolKey: COLLIDE_DOT, summary: COLLIDE_SUMMARY }]);
  assert.ok(payload.diagnostics.some(item => item.symbolKey === COLLIDE_US && item.reason === 'wrong-key'),
    'the colliding key must see the foreign artifact as wrong-key, not as its own');
  const others = payload.diagnostics.filter(item => item.symbolKey !== COLLIDE_US);
  for (const item of others) assert.equal(item.reason, 'no-accepted-artifact');
});

test('S23 file rollup: strict inputs and path escape reject before any read', async () => {
  await mcpError('pmc_file_rollup', { target: SERVICE, level: 'compact' });
  await mcpError('pmc_file_rollup', { target: SERVICE, depth: 2 });
  await mcpError('pmc_file_rollup', {});
  await mcpError('pmc_file_rollup', { target: 42 });
  await mcpError('pmc_file_rollup', { target: '/etc/passwd' });
  await mcpError('pmc_file_rollup', { target: '../escape.ts' });
});

// ── pmc_community_card ───────────────────────────────────────────────────────

test('S23 community card: full internal enumeration of coherent file endpoints and indexed source files', async () => {
  const payload = await mcpPayload('pmc_community_card', { communityId: 1 });
  assert.equal(payload.kind, 'community-card');
  assert.equal(payload.communityId, '1');
  assert.equal(payload.name, 'Persistence & Service');
  assert.deepEqual(payload.scannedFiles, SCANNED_FILES, 'ALL coherent endpoints + indexed files, sorted');
  assert.deepEqual(payload.members, [
    { id: REPO_CLASS, symbolKey: REPO_CLASS, kind: 'class', path: REPO },
    { id: REPO_CTOR, symbolKey: REPO_CTOR, kind: 'method', path: REPO },
    { id: REPO_FIND, symbolKey: REPO_FIND, kind: 'method', path: REPO },
    { id: CLASS, symbolKey: CLASS, kind: 'class', path: SERVICE },
    { id: CTOR, symbolKey: CTOR, kind: 'method', path: SERVICE },
    { id: METHOD, symbolKey: METHOD, kind: 'method', path: SERVICE },
  ], 'membership comes only from actual graph community assignments');
  assert.deepEqual(payload.narratives, [{ symbolKey: METHOD, summary: METHOD_SUMMARY }]);
  assert.equal(payload.text, `- ${METHOD}: ${METHOD_SUMMARY}`);
  // scannedFiles honesty: the coherent standalone endpoint has no enumerable
  // symbol rows, and the builder reports that truthfully.
  assert.deepEqual(payload.rejected, [{ member: `file|${STANDALONE}`, reason: 'file-not-in-graph' }]);
  assert.deepEqual(payload.diagnostics, [
    { symbolKey: REPO_CLASS, reason: 'no-accepted-artifact' },
    { symbolKey: REPO_CTOR, reason: 'no-accepted-artifact' },
    { symbolKey: REPO_FIND, reason: 'fingerprint-mismatch' },
    { symbolKey: CLASS, reason: 'no-accepted-artifact' },
    { symbolKey: CTOR, reason: 'missing-index-fingerprint' },
  ]);
  const first = await mcpText('pmc_community_card', { communityId: 1 });
  const second = await mcpText('pmc_community_card', { communityId: 1 });
  assert.equal(first, second);
  assert.equal(first, JSON.stringify(payload, null, 2));
});

test('S23 community card: numeric id accepted, unknown community stays an honest empty card', async () => {
  const numeric = await mcpPayload('pmc_community_card', { communityId: 1 });
  const payload = await mcpPayload('pmc_community_card', { communityId: 99 });
  assert.equal(payload.communityId, '99');
  assert.equal(payload.name, null);
  assert.deepEqual(payload.scannedFiles, SCANNED_FILES);
  assert.deepEqual(payload.members, []);
  assert.deepEqual(payload.narratives, []);
  assert.equal(payload.text, '');
  assert.deepEqual(payload.diagnostics, []);
  assert.equal(payload.scannedFiles.length, numeric.scannedFiles.length);
});

test('S23 community card: strict inputs reject unknown options, wrong types and level', async () => {
  await mcpError('pmc_community_card', { communityId: 1, name: 'guess' });
  await mcpError('pmc_community_card', { communityId: 1, level: 'deep' });
  await mcpError('pmc_community_card', {});
  await mcpError('pmc_community_card', { communityId: '' });
  await mcpError('pmc_community_card', { communityId: null });
  await mcpError('pmc_community_card', { communityId: true });
  await mcpError('pmc_community_card', { communityId: {} });
  await mcpError('pmc_community_card', { communityId: [1] });
});

// ── pmc_feature_card ─────────────────────────────────────────────────────────

test('S23 feature card: explicit canonical membership with provenance and honest rejections', async () => {
  const payload = await mcpPayload('pmc_feature_card', {
    name: 'auth-flow',
    members: [METHOD, GHOST, '/etc/passwd', `file|${REPO}`],
  });
  assert.deepEqual(payload, {
    kind: 'feature-card',
    name: 'auth-flow',
    symbols: [{ id: METHOD, symbolKey: METHOD, kind: 'method', path: SERVICE }],
    files: [{ id: `file|${REPO}`, path: REPO, kind: 'file' }],
    narratives: [{ symbolKey: METHOD, summary: METHOD_SUMMARY }],
    text: `- ${METHOD}: ${METHOD_SUMMARY}`,
    rejected: [
      { member: '/etc/passwd', reason: 'non-canonical-member-key' },
      { member: GHOST, reason: 'symbol-not-in-graph' },
    ],
    diagnostics: [],
  });
  const first = await mcpText('pmc_feature_card', { name: 'auth-flow', members: [METHOD, GHOST, '/etc/passwd', `file|${REPO}`] });
  const second = await mcpText('pmc_feature_card', { name: 'auth-flow', members: [`file|${REPO}`, GHOST, METHOD, '/etc/passwd'] });
  assert.equal(first, second, 'byte-identical output independent of member order');
  assert.equal(first, JSON.stringify(payload, null, 2));
});

test('S23 feature card: file-only membership aggregates no narratives and probes no artifacts', async () => {
  const payload = await mcpPayload('pmc_feature_card', { name: 'storage', members: [`file|${REPO}`] });
  assert.deepEqual(payload.symbols, []);
  assert.deepEqual(payload.files, [{ id: `file|${REPO}`, path: REPO, kind: 'file' }]);
  assert.deepEqual(payload.narratives, []);
  assert.equal(payload.text, '');
  assert.deepEqual(payload.rejected, []);
  assert.deepEqual(payload.diagnostics, []);
});

test('S23 feature card: strict inputs reject missing/empty members, duplicates and level', async () => {
  await mcpError('pmc_feature_card', { name: 'x' });
  await mcpError('pmc_feature_card', { name: 'x', members: [] });
  await mcpError('pmc_feature_card', { name: 'x', members: [METHOD, METHOD] });
  await mcpError('pmc_feature_card', { name: 'x', members: [METHOD, 42] });
  await mcpError('pmc_feature_card', { name: '', members: [METHOD] });
  await mcpError('pmc_feature_card', { name: 'x', members: [METHOD], level: 'compact' });
  await mcpError('pmc_feature_card', { members: [METHOD] });
});

// ── Existing pmc_card stays byte-identical with narrative artifacts present ──

test('S23 pmc_card default file payload keeps enrichment empty even when narrative artifacts exist', async () => {
  const payload = await mcpPayload('pmc_card', { target: SERVICE });
  assert.deepEqual(Object.keys(payload).sort(), ['enrichment', 'facts', 'status', 'target']);
  assert.equal(payload.status, 'resolved');
  assert.equal(payload.target, SERVICE);
  assert.equal(payload.enrichment, '', 'file enrichment stays empty; narratives live only in pmc_file_rollup');
  assert.equal(payload.facts.kind, 'file');
  assert.equal(payload.facts.path, SERVICE);
  assert.equal(payload.facts.symbolCount, 3);
  assert.equal('narratives' in payload, false);
  assert.equal('diagnostics' in payload, false);
});

test('S23 pmc_card symbol enrichment stays the semantic summary, never the narrative summary', async () => {
  const payload = await mcpPayload('pmc_card', { target: METHOD });
  assert.equal(payload.status, 'resolved');
  assert.equal(payload.target, METHOD);
  assert.equal(payload.enrichment, SEMANTIC_METHOD);
  assert.notEqual(payload.enrichment, METHOD_SUMMARY);
});

test('S23 pmc_card level still works with narrative artifacts present', async () => {
  const payload = await mcpPayload('pmc_card', { target: SERVICE, level: 'compact' });
  assert.equal(payload.status, 'resolved');
  assert.equal(payload.level, 'compact');
  assert.equal(payload.tokenCeiling, 2000);
});

// ── CLI surface ──────────────────────────────────────────────────────────────

test('S23 CLI pmc card --help exits 0 with the exact options and examples on stdout', async () => {
  const result = await runCli(['card', '--help']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, HELP_TEXT);
  const subHelp = await runCli(['card', 'file', '--help']);
  assert.equal(subHelp.code, 0);
  assert.equal(subHelp.stdout, HELP_TEXT);
});

test('S23 CLI registers card in the auto-generated top usage', async () => {
  const result = await runCli(['help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: pmc </);
  assert.match(result.stdout, /\|card\|/);
});

test('S23 CLI file/community/feature succeed with JSON stdout, empty stderr, byte-equal to MCP', async () => {
  const file = await runCli(['card', 'file', SERVICE]);
  assert.equal(file.code, 0);
  assert.equal(file.stderr, '');
  assert.equal(file.stdout, `${await mcpText('pmc_file_rollup', { target: SERVICE })}\n`);

  const community = await runCli(['card', 'community', '1']);
  assert.equal(community.code, 0);
  assert.equal(community.stderr, '');
  assert.equal(community.stdout, `${await mcpText('pmc_community_card', { communityId: 1 })}\n`);

  const feature = await runCli(['card', 'feature', 'auth-flow', '--member', METHOD, '--member', `file|${REPO}`]);
  assert.equal(feature.code, 0);
  assert.equal(feature.stderr, '');
  assert.equal(feature.stdout, `${await mcpText('pmc_feature_card', { name: 'auth-flow', members: [METHOD, `file|${REPO}`] })}\n`);

  // Deterministic across independent processes.
  const again = await runCli(['card', 'file', SERVICE]);
  assert.equal(again.stdout, file.stdout);
});

test('S23 CLI walks up to the PMC project root from a nested cwd', async () => {
  const result = await runCli(['card', 'file', SERVICE], { cwd: join(root, 'src') });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /file-narrative-rollup/);
});

test('S23 CLI invalid inputs exit nonzero with stderr diagnostics and empty stdout', async () => {
  const cases = [
    { args: ['card'], pattern: /Usage: pmc card file/ },
    { args: ['card', 'bogus'], pattern: /unknown card command/ },
    { args: ['card', 'file'], pattern: /requires <path>/ },
    { args: ['card', 'file', SERVICE, 'extra.ts'], pattern: /unexpected argument/ },
    { args: ['card', 'file', METHOD], pattern: /not a file/ },
    { args: ['card', 'file', 'src/missing.ts'], pattern: /not found in graph/ },
    { args: ['card', 'file', '/etc/passwd'], pattern: /inside the project|not found in graph/ },
    { args: ['card', 'community'], pattern: /requires <community-id>/ },
    { args: ['card', 'feature', 'auth-flow'], pattern: /at least one --member/ },
    { args: ['card', 'feature', 'auth-flow', '--member'], pattern: /missing value for --member/ },
    { args: ['card', 'feature', 'auth-flow', '--member', METHOD, '--bogus'], pattern: /unknown flag/ },
    { args: ['card', 'feature', 'auth-flow', '--member', METHOD, '--member', METHOD], pattern: /duplicate members entry/ },
    { args: ['card', 'feature', 'auth-flow', 'extra', '--member', METHOD], pattern: /unexpected argument/ },
    { args: ['query', '--member', METHOD], pattern: /Unknown flag/ }, // sibling parser unchanged by new options
  ];
  for (const { args, pattern } of cases) {
    const result = await runCli(args);
    assert.notEqual(result.code, 0, `pmc ${args.join(' ')} must exit nonzero`);
    assert.equal(result.stdout, '', `pmc ${args.join(' ')} must keep stdout empty on failure`);
    assert.match(result.stderr, pattern, `pmc ${args.join(' ')}`);
  }
});

test('S23 conflicting duplicate worklist identities and foreign stored evidence are withheld', async () => {
  const original = readFileSync(worklistPath, 'utf8');
  const originalIndex = readFileSync(indexPath, 'utf8');
  try {
    const entries = JSON.parse(original);
    entries.push({ ...entries.find(entry => entry.symbolKey === METHOD), ...fingerprint('conflicting') });
    writeFileSync(worklistPath, JSON.stringify(entries));
    // Put the agreeing row LAST: last-row-wins must not establish acceptance.
    entries.reverse();
    writeFileSync(worklistPath, JSON.stringify(entries));
    const duplicate = await mcpPayload('pmc_file_rollup', { target: SERVICE });
    assert.ok(!duplicate.narratives.some(entry => entry.symbolKey === METHOD), 'duplicate acceptance must fail closed');
    writeFileSync(worklistPath, original);
    const index = JSON.parse(originalIndex);
    index[METHOD].symbolKey = CLASS;
    writeFileSync(indexPath, JSON.stringify(index));
    const foreign = await mcpPayload('pmc_feature_card', { name: 'explicit', members: [METHOD] });
    assert.deepEqual(foreign.narratives, [], 'foreign index evidence must not bind to the requested key');
  } finally {
    writeFileSync(worklistPath, original);
    writeFileSync(indexPath, originalIndex);
  }
});

test('S23 enrichment directory junction escape withholds artifacts through public MCP and CLI', async () => {
  // The target is owned fixture data outside the project, never a host file.
  const outside = mkdtempSync(join(tmpdir(), 'pmc-card-outside-'));
  const saved = `${enrichmentDir}-saved`;
  renameSync(enrichmentDir, saved);
  try {
    for (const name of readdirSync(saved)) writeFileSync(join(outside, name), readFileSync(join(saved, name)));
    symlinkSync(outside, enrichmentDir, process.platform === 'win32' ? 'junction' : 'dir');
    const response = await client.callTool({ name: 'pmc_file_rollup', arguments: { target: SERVICE } });
    assert.equal(response.isError, true, 'escaped metadata/artifacts must fail before host reads');
    const cli = await runCli(['card', 'file', SERVICE]);
    assert.equal(cli.code, 1);
    assert.equal(cli.stdout, '');
    assert.match(cli.stderr, /outside|escape|contain/i);
  } finally {
    if (existsSync(enrichmentDir)) rmSync(enrichmentDir, { recursive: true, force: true });
    renameSync(saved, enrichmentDir);
    rmSync(outside, { recursive: true, force: true });
  }
});

test('S23 community enumeration includes canonical native-import-only file endpoints', async () => {
  const original = readFileSync(dbPath);
  try {
    const db = new DatabaseSync(dbPath);
    try {
      createSqliteGraphStore(db).persistNativeRelations({ relations: [{
        source: { id: `file|${SERVICE}`, kind: 'file', path: SERVICE },
        target: { id: 'file|src/import-only.ts', kind: 'file', path: 'src/import-only.ts' },
        relation: 'imports', bindings: [],
      }], unresolved: [] });
    } finally { db.close(); }
    const result = await mcpPayload('pmc_community_card', { communityId: 1 });
    assert.deepEqual(result.scannedFiles, [...SCANNED_FILES, 'src/import-only.ts'].sort());
  } finally { writeFileSync(dbPath, original); }
});

test('S23 aggregate readers accept canonical seven-part C# graph membership without widening old defaults', async () => {
  const original = readFileSync(dbPath);
  const key = 'csharp|src/Example.cs|||method|Run|()';
  try {
    const db = new DatabaseSync(dbPath);
    try {
      buildFromGraphJson(db, { nodes: [{ id: key, kind: 'method', label: 'Run', source_file: 'src/Example.cs',
        community: 4, metadata: { symbolKey: key } }], links: [] }, 'csharp-fixture');
    } finally { db.close(); }
    const feature = await mcpPayload('pmc_feature_card', { name: 'explicit', members: [key] });
    assert.equal(feature.symbols[0]?.symbolKey, key);
    const community = await mcpPayload('pmc_community_card', { communityId: 4 });
    assert.equal(community.members[0]?.symbolKey, key);
  } finally { writeFileSync(dbPath, original); }
});

test('S23 owned same-clone baseline: full eight descriptors, responses, reader defaults and sibling CLI bytes', {
  skip: !process.env.S23_BASELINE,
}, async () => {
  const baseline = resolve(process.env.S23_BASELINE);
  const { registerQueryTools: register } = await import(pathToFileURL(join(baseline, 'mcp/query-tools.mjs')));
  const { createRelationsReader: oldReader } = await import(pathToFileURL(join(baseline, 'src/query/relations.mjs')));
  const old = await connect(root, register);
  try {
    const oldTools = (await old.client.listTools()).tools;
    const names = new Set(oldTools.map(tool => tool.name));
    assert.equal(names.size, 8);
    assert.deepEqual((await client.listTools()).tools.filter(tool => names.has(tool.name)), oldTools);
    for (const [name, args] of [
      ['pmc_query_project', { question: 'UserService' }],
      ['pmc_search_symbols', { query: 'user' }],
      ['pmc_search_symbols', { query: 'Finds', file: SERVICE }],
      ['pmc_get_dependencies', { symbol: METHOD }],
      ['pmc_get_dependents', { symbol: METHOD }],
      ['pmc_relations', { target: METHOD }],
      ['pmc_relations', { target: CLASS, direction: 'in', depth: 2 }],
      ['pmc_entrypoints_for', { target: METHOD }],
      ['pmc_impact', { target: SERVICE }],
      ['pmc_card', { target: SERVICE }],
      ['pmc_card', { target: METHOD }],
      ['pmc_card', { target: SERVICE, level: 'deep' }],
      ['pmc_card', { target: 'src/absent.ts' }],
    ]) assert.equal(JSON.stringify(await client.callTool({ name, arguments: args })),
      JSON.stringify(await old.client.callTool({ name, arguments: args })), `${name} complete response parity`);
    for (const target of [METHOD, SERVICE, CLASS, 'src/absent.ts']) {
      assert.deepEqual(await createRelationsReader({ projectRoot: root }).card({ target }),
        await oldReader({ projectRoot: root }).card({ target }));
    }
    for (const args of [
      ['query', 'UserService'], ['query', 'repository'], ['query', '--help'],
      ['query', '--member', METHOD], ['query', '--level', 'deep'],
      ['get-context', METHOD, 'compact'], ['get-context', SERVICE, 'compact'],
      ['get-context', 'src/absent.ts', 'compact'],
    ]) assert.deepEqual(await runCli(args), await runCli(args, { binPath: join(baseline, 'bin/pmc.mjs') }),
      `exact stdout/stderr/exit: ${args.join(' ')}`);
  } finally {
    await old.client.close();
    await old.server.close();
  }
});

// ── State preservation ───────────────────────────────────────────────────────

test('S23 every probe above preserves DB bytes, schema/tables, index, worklist, install config and artifacts', async () => {
  // Positive + invalid probes all ran before this final test; re-probe a few
  // representative rejections, then compare with the pre-probe golden snapshot.
  await mcpError('pmc_file_rollup', { target: SERVICE, level: 'deep' });
  await mcpError('pmc_feature_card', { name: 'x', members: [METHOD, METHOD] });
  await runCli(['card', 'file', '/etc/passwd']);
  await runCli(['card', 'bogus']);
  assert.deepEqual(snapshotState(), GOLDEN, 'read-only probes changed protected state');
});
