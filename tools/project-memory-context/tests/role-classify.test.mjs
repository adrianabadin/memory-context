// tools/project-memory-context/tests/role-classify.test.mjs
//
// F2 R1 (plan 2.1-2.5, bounded to S1/S3/S4 + generic/node-cli profiles): the
// pure rule-based role classifier. Every input is caller-provided (structured
// annotations/heritage/topology/side-effects from real syntax inspection, or
// actual extractor records); the classifier NEVER reads a project, a fixture,
// or a graph at call time and NEVER hardcodes golden keys/paths. Weaker
// evidence (name, path, topology, side-effect markers) is honestly labeled a
// marker or heuristic, never a verified AST/execution fact.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  frameworkAnnotationSignal,
  structuredHeritageSignal,
  containerRoleSignal,
  nameSuffixSignal,
  decoratorFactorySignal,
  directoryTokenSignal,
  topologySignal,
  sideEffectMarkerSignal,
} from '../src/roles/signals.mjs';
import {
  loadProfile,
  classifySymbol,
  classifyFile,
} from '../src/roles/classify.mjs';
import { extractTopLevelSymbols } from '../src/symbol-extractor.mjs';

// ── Fixture extraction (real extractor records, not hand-authored keys) ───────

const FIXTURE_ROOT = new URL('./fixtures/layered-app/', import.meta.url);
const FIXTURE_PATHS = [
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

let allSymbols;
let byKey;

before(async () => {
  allSymbols = [];
  for (const p of FIXTURE_PATHS) {
    const content = readFileSync(new URL(p, FIXTURE_ROOT), 'utf8');
    const records = await extractTopLevelSymbols({ filePath: p, content });
    allSymbols.push(...records);
  }
  byKey = new Map(allSymbols.map((r) => [r.symbolKey, r]));
});

const SHAPED = ['confidence', 'evidence', 'layer', 'role'];

// ── S1: six kinds of pure signal evidence ────────────────────────────────────

test('S1 signals: every signal returns {signal, role, weight, evidence} or null', () => {
  const generic = loadProfile('generic');

  const ann = frameworkAnnotationSignal({
    annotations: { decorators: ['Controller'] },
    profile: generic,
  });
  assert.equal(ann.signal, 'framework-annotation');
  assert.equal(ann.role, 'controller');
  assert.ok(ann.weight > 0 && ann.weight <= 1 && Number.isFinite(ann.weight));
  assert.match(ann.evidence, /structured decorator annotation '@Controller'/);

  const heritage = structuredHeritageSignal({
    heritage: ['UserRepository'],
    profile: generic,
  });
  assert.equal(heritage.signal, 'structured-heritage');
  assert.equal(heritage.role, 'repository');
  assert.ok(heritage.weight > 0 && heritage.weight <= 1);
  assert.match(heritage.evidence, /structured heritage 'UserRepository'/);

  const suffix = nameSuffixSignal({
    record: { kind: 'class', name: 'UserService', filePath: 'src/x.ts' },
    profile: generic,
  });
  assert.equal(suffix.signal, 'name-suffix');
  assert.equal(suffix.role, 'service');
  assert.ok(suffix.weight > 0 && suffix.weight <= 1);
  assert.match(suffix.evidence, /name suffix marker/);

  const dir = directoryTokenSignal({
    path: 'src/controllers/user.controller.ts',
    profile: generic,
  });
  assert.equal(dir.signal, 'directory-token');
  assert.equal(dir.role, 'controller');
  assert.ok(dir.weight > 0 && dir.weight <= 1);
  assert.match(dir.evidence, /directory token marker/);

  const topo = topologySignal({
    topology: { fanIn: 0, fanOut: 12 },
    profile: generic,
  });
  assert.equal(topo.signal, 'topology');
  assert.ok(topo.weight > 0 && topo.weight <= 1);
  assert.match(topo.evidence, /topology heuristic \(weak\)/);

  const side = sideEffectMarkerSignal({
    sideEffects: ['child-process'],
    profile: generic,
  });
  assert.equal(side.signal, 'side-effect-marker');
  assert.equal(side.role, 'cli');
  assert.ok(side.weight > 0 && side.weight <= 1);
  assert.match(side.evidence, /not a verified execution fact/);
});

test('S1 decorator-factory evidence is an honest name marker, not verified decorator syntax', () => {
  const generic = loadProfile('generic');
  const signal = decoratorFactorySignal({
    record: { kind: 'function', exportScope: 'local', name: 'Controller', filePath: 'src/c.ts' },
    profile: generic,
  });
  assert.equal(signal.signal, 'decorator-factory');
  assert.equal(signal.role, 'decorator');
  assert.match(signal.evidence, /name marker only/);
  assert.match(signal.evidence, /decorator syntax not verified/);
  // Not fired for exported functions, classes, or non-decorator names.
  assert.equal(decoratorFactorySignal({
    record: { kind: 'function', exportScope: 'exported', name: 'Controller', filePath: 'src/c.ts' },
    profile: generic,
  }), null);
  assert.equal(decoratorFactorySignal({
    record: { kind: 'class', exportScope: 'local', name: 'Controller', filePath: 'src/c.ts' },
    profile: generic,
  }), null);
});

test('S1 signals return null when their evidence is absent', () => {
  const generic = loadProfile('generic');
  assert.equal(frameworkAnnotationSignal({ annotations: {}, profile: generic }), null);
  assert.equal(structuredHeritageSignal({ heritage: null, profile: generic }), null);
  assert.equal(containerRoleSignal({
    record: { kind: 'class', name: 'X', filePath: 'src/x.ts' }, allSymbols: [], profile: generic,
  }), null);
  assert.equal(nameSuffixSignal({
    record: { kind: 'class', name: 'Thing', filePath: 'src/x.ts' }, profile: generic,
  }), null);
  assert.equal(directoryTokenSignal({ path: 'src/mystery/thing.ts', profile: generic }), null);
  assert.equal(topologySignal({ topology: null, profile: generic }), null);
  assert.equal(sideEffectMarkerSignal({ sideEffects: [], profile: generic }), null);
});

test('S1 name-suffix excludes abstraction kinds and test scope (role beats a coincidental suffix)', () => {
  const generic = loadProfile('generic');
  // An interface named *Repository names what it exposes; its role is not repository.
  assert.equal(nameSuffixSignal({
    record: { kind: 'interface', name: 'IUserRepository', filePath: 'src/interfaces/r.ts' }, profile: generic,
  }), null);
  // A function in a tests/ dir named *Service is a test, not a service.
  assert.equal(nameSuffixSignal({
    record: { kind: 'function', name: 'testUserService', filePath: 'tests/user.service.test.ts' }, profile: generic,
  }), null);
  // Concrete symbols keep the stereotype.
  assert.equal(nameSuffixSignal({
    record: { kind: 'class', name: 'UserService', filePath: 'src/services/user.service.ts' }, profile: generic,
  }).role, 'service');
});

// ── Profile resolution and priority ──────────────────────────────────────────

test('profile priority: node-cli overrides generic cli mapping and keeps generic tables', () => {
  const generic = loadProfile('generic');
  const nodeCli = loadProfile('node-cli');

  // node-cli redefines cli/ as a CLI command; generic keeps it as the plain cli role.
  assert.equal(classifyFile({ path: 'cli/enrich-queue.mjs' }, { profile: generic }).role, 'cli');
  assert.equal(classifyFile({ path: 'cli/enrich-queue.mjs' }, { profile: nodeCli }).role, 'cli-command');

  // node-cli still inherits generic layered tokens (merge, not replace).
  assert.equal(classifyFile({ path: 'src/controllers/user.controller.ts' }, { profile: nodeCli }).role, 'controller');

  // Unknown profiles fail closed.
  assert.throws(() => loadProfile('unknown-profile'), TypeError);
});

// ── S3: output shape, member inheritance, explicit override, purity, unknown ─

test('S3 shape: classifySymbol and classifyFile return exactly {role, layer, confidence, evidence}', () => {
  const generic = loadProfile('generic');
  const svc = byKey.get('ts|src/services/user.service.ts|class|exported|UserService|0');
  const symbolResult = classifySymbol(svc, { profile: generic, allSymbols });
  assert.deepEqual(Object.keys(symbolResult).sort(), SHAPED);
  assert.equal(symbolResult.role, 'service');
  assert.equal(symbolResult.layer, 'application');
  assert.ok(symbolResult.confidence > 0 && symbolResult.confidence <= 1 && Number.isFinite(symbolResult.confidence));
  assert.ok(Array.isArray(symbolResult.evidence) && symbolResult.evidence.length > 0);
  assert.ok(symbolResult.evidence.every((e) => typeof e === 'string'));

  const fileResult = classifyFile({ path: 'src/utils/format.ts' }, { profile: generic });
  assert.deepEqual(Object.keys(fileResult).sort(), SHAPED);
  assert.equal(fileResult.role, 'util');
  assert.equal(fileResult.layer, 'cross-cutting');
});

test('S3 member inherits a uniquely identified container role', () => {
  const generic = loadProfile('generic');
  const container = {
    language: 'ts', filePath: 'src/mystery/helper.ts', kind: 'class',
    name: 'UserService', exportScope: 'exported', symbolKey: 'k|container',
  };
  const member = {
    language: 'ts', filePath: 'src/mystery/helper.ts', kind: 'method',
    name: 'doThing', container: 'UserService', exportScope: 'member', symbolKey: 'k|member',
  };
  const result = classifySymbol(member, { profile: generic, allSymbols: [member, container] });
  assert.equal(result.role, 'service');
  assert.match(result.evidence.join(' '), /inherits role from unique container 'UserService'/);
});

test('S3 ambiguous container is never resolved by array order', () => {
  const generic = loadProfile('generic');
  const classA = {
    language: 'ts', filePath: 'src/mystery/helper.ts', kind: 'class',
    name: 'UserService', exportScope: 'exported', symbolKey: 'k|a',
  };
  const classB = {
    language: 'ts', filePath: 'src/mystery/helper.ts', kind: 'class',
    name: 'UserService', exportScope: 'exported', symbolKey: 'k|b',
  };
  const member = {
    language: 'ts', filePath: 'src/mystery/helper.ts', kind: 'method',
    name: 'doThing', container: 'UserService', exportScope: 'member', symbolKey: 'k|member',
  };
  // Two same-name containers => ambiguous => no inheritance => unknown (null role).
  const result = classifySymbol(member, { profile: generic, allSymbols: [member, classA, classB] });
  assert.equal(result.role, null);
  assert.equal(result.confidence, 0);
});

test('S3 own stronger provided evidence overrides the inherited container role', () => {
  const generic = loadProfile('generic');
  const container = {
    language: 'ts', filePath: 'src/mystery/helper.ts', kind: 'class',
    name: 'UserService', exportScope: 'exported', symbolKey: 'k|container',
  };
  const member = {
    language: 'ts', filePath: 'src/mystery/helper.ts', kind: 'method',
    name: 'doThing', container: 'UserService', exportScope: 'member', symbolKey: 'k|member',
    annotations: { decorators: ['Controller'] },
  };
  // Structured decorator annotation (0.9) outranks container inheritance (service).
  const result = classifySymbol(member, { profile: generic, allSymbols: [member, container] });
  assert.equal(result.role, 'controller');
  assert.match(result.evidence.join(' '), /@Controller/);
});

test('S3 purity: classification never mutates inputs and is deterministic', () => {
  const generic = loadProfile('generic');
  const svc = byKey.get('ts|src/repositories/user.repository.ts|class|exported|UserRepository|0');
  const snapshot = JSON.parse(JSON.stringify({ svc, allSymbols }));
  const first = classifySymbol(svc, { profile: generic, allSymbols });
  const second = classifySymbol(svc, { profile: generic, allSymbols });
  assert.deepEqual(first, second);
  assert.deepEqual(JSON.parse(JSON.stringify({ svc, allSymbols })), snapshot);
});

test('S3 unknown without support returns null role/layer, zero confidence, empty evidence', () => {
  const generic = loadProfile('generic');
  const mystery = {
    language: 'ts', filePath: 'src/mystery/thing.ts', kind: 'function',
    name: 'compute', exportScope: 'exported', symbolKey: 'k|thing',
  };
  const result = classifySymbol(mystery, { profile: generic, allSymbols: [mystery] });
  assert.deepEqual(result, { role: null, layer: null, confidence: 0, evidence: [] });
});

// ── S4: golden fixture accuracy and PMC own-repo categories ──────────────────

test('S4 golden: >=15 of all 16 expected symbols classify correctly with nonempty evidence', async () => {
  const generic = loadProfile('generic');
  const golden = JSON.parse(readFileSync(new URL('./fixtures/layered-app/expected.json', import.meta.url), 'utf8'));
  const entries = Object.entries(golden.symbols);
  assert.equal(entries.length, 16, 'golden fixture must keep all 16 symbols');

  let correct = 0;
  const misses = [];
  for (const [key, expected] of entries) {
    const record = byKey.get(key);
    assert.ok(record, `extractor must produce golden symbol ${key}`);
    const result = classifySymbol(record, { profile: generic, allSymbols });
    assert.ok(result.evidence.length > 0, `golden symbol ${key} must carry recognized evidence`);
    assert.ok(result.confidence > 0 && Number.isFinite(result.confidence));
    if (result.role === expected.role && result.layer === expected.layer) {
      correct++;
    } else {
      misses.push({ key, expected, got: { role: result.role, layer: result.layer } });
    }
  }
  // eslint-disable-next-line no-console
  console.log(`golden role accuracy: ${correct}/16 (${(correct / 16 * 100).toFixed(1)}%)`, misses.length ? misses : '');
  assert.ok(correct >= 15, `expected >=15/16 correct, got ${correct}: ${JSON.stringify(misses)}`);
});

test('S4 own-repo: PMC source paths classify into cli-command/mcp-tool/extractor/store via node-cli', () => {
  const nodeCli = loadProfile('node-cli');
  const cases = [
    ['tools/project-memory-context/cli/enrich-queue.mjs', 'cli-command', 'entrypoint'],
    ['tools/project-memory-context/mcp/query-tools.mjs', 'mcp-tool', 'entrypoint'],
    ['tools/project-memory-context/src/extractors/tree-sitter/extract.mjs', 'extractor', 'infrastructure'],
    ['tools/project-memory-context/src/graph-store/graph-db.mjs', 'store', 'data'],
  ];
  for (const [path, role, layer] of cases) {
    const result = classifyFile({ path }, { profile: nodeCli });
    assert.equal(result.role, role, `${path} should be ${role}`);
    assert.equal(result.layer, layer, `${path} layer should be ${layer}`);
    assert.ok(result.evidence.length > 0, `${path} must carry recognized evidence`);
    assert.ok(result.confidence > 0 && Number.isFinite(result.confidence));
  }
});
