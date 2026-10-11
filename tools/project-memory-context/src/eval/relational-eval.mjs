import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveGraphify } from '../platform.mjs';
import { runGraphifyUpdate } from '../graphify-runner.mjs';
import { extractTopLevelSymbols } from '../symbol-extractor.mjs';
import { attachGraphNodeIds } from '../graph-node-resolver.mjs';
import { createQueryOrchestrator } from '../query/orchestrator.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SUPPORTED_SCHEMA_VERSIONS = new Set([1, '1', '1.0', '1.0.0']);
const ALLOWED_QUESTION_TYPES = new Set([
  'callers',
  'callees',
  'dependents',
  'dependencies',
  'nearest_controller',
  'entrypoint',
  'tests',
]);

export function isValidSymbolKey(key) {
  if (typeof key !== 'string' || !key.trim()) return false;
  const parts = key.split('|');
  if (parts.some((p) => p.trim() === '')) return false;
  if (parts[0] === 'csharp') {
    return parts.length === 7;
  }
  return parts.length === 6;
}

export function validateGoldenSchema(golden) {
  if (!golden || typeof golden !== 'object' || Array.isArray(golden)) {
    return { valid: false, error: 'Golden must be a non-null object' };
  }
  if (golden.schemaVersion === undefined || golden.schemaVersion === null) {
    return { valid: false, error: 'Missing schemaVersion' };
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.has(golden.schemaVersion)) {
    return { valid: false, error: `Unsupported schemaVersion: ${golden.schemaVersion}` };
  }
  if (typeof golden.fixture !== 'string' || !golden.fixture.trim()) {
    return { valid: false, error: 'Missing or invalid fixture name' };
  }
  if (!golden.symbols || typeof golden.symbols !== 'object' || Array.isArray(golden.symbols)) {
    return { valid: false, error: 'Missing or invalid symbols map' };
  }
  for (const [key, meta] of Object.entries(golden.symbols)) {
    if (!isValidSymbolKey(key)) {
      return { valid: false, error: `Invalid symbol key in symbols map: ${key}` };
    }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      return { valid: false, error: `Invalid metadata for symbol ${key}` };
    }
  }

  if (!Array.isArray(golden.questions) || golden.questions.length === 0) {
    return { valid: false, error: 'Missing or empty questions array' };
  }

  const seenIds = new Set();
  for (let i = 0; i < golden.questions.length; i++) {
    const q = golden.questions[i];
    if (!q || typeof q !== 'object' || Array.isArray(q)) {
      return { valid: false, error: `Invalid question object at index ${i}` };
    }
    if (typeof q.id !== 'string' || !q.id.trim()) {
      return { valid: false, error: `Missing or blank id at index ${i}` };
    }
    if (seenIds.has(q.id)) {
      return { valid: false, error: `Duplicate question id: ${q.id}` };
    }
    seenIds.add(q.id);

    if (typeof q.type !== 'string' || !ALLOWED_QUESTION_TYPES.has(q.type)) {
      return { valid: false, error: `Unknown question type: ${q.type} at index ${i}` };
    }
    if (typeof q.target !== 'string' || !q.target.trim()) {
      return { valid: false, error: `Missing or blank target for question ${q.id}` };
    }
    if (!isValidSymbolKey(q.target)) {
      return { valid: false, error: `Target for question ${q.id} is not a valid symbolKey: ${q.target}` };
    }
    if (!golden.symbols[q.target]) {
      return { valid: false, error: `Target for question ${q.id} is not defined in symbols map: ${q.target}` };
    }

    if (!Array.isArray(q.expected)) {
      return { valid: false, error: `Expected must be an array for question ${q.id}` };
    }
    const expectedSet = new Set();
    for (const id of q.expected) {
      if (typeof id !== 'string') {
        return { valid: false, error: `Non-string ID in expected for question ${q.id}` };
      }
      if (!id.trim()) {
        return { valid: false, error: `Blank ID in expected for question ${q.id}` };
      }
      if (!isValidSymbolKey(id)) {
        return { valid: false, error: `Expected ID "${id}" in question ${q.id} is not a valid symbolKey` };
      }
      if (expectedSet.has(id)) {
        return { valid: false, error: `Duplicate ID in expected for question ${q.id}: ${id}` };
      }
      expectedSet.add(id);
      if (!golden.symbols[id]) {
        return { valid: false, error: `Expected ID "${id}" in question ${q.id} is not defined in symbols map` };
      }
    }
  }
  return { valid: true };
}

function computeMetrics(expectedSet, actualSet) {
  const missing = Array.from(expectedSet).filter((id) => !actualSet.has(id)).sort();
  const extra = Array.from(actualSet).filter((id) => !expectedSet.has(id)).sort();
  const exactMatch = missing.length === 0 && extra.length === 0;

  let precision = 0;
  let recall = 0;

  if (expectedSet.size === 0 && actualSet.size === 0) {
    precision = 1;
    recall = 1;
  } else if (expectedSet.size === 0 && actualSet.size > 0) {
    precision = 0;
    recall = 0;
  } else if (expectedSet.size > 0 && actualSet.size === 0) {
    precision = 0;
    recall = 0;
  } else {
    const truePositives = expectedSet.size - missing.length;
    precision = actualSet.size > 0 ? truePositives / actualSet.size : 0;
    recall = expectedSet.size > 0 ? truePositives / expectedSet.size : 0;
  }

  return { exactMatch, missing, extra, precision, recall };
}

function normalizeAdapterResult(raw) {
  if (raw === null || raw === undefined) {
    return { valid: false, error: 'Adapter returned null or undefined' };
  }
  let idArray = null;
  if (Array.isArray(raw)) {
    idArray = raw;
  } else if (raw instanceof Set) {
    idArray = Array.from(raw);
  } else if (typeof raw === 'object' && Array.isArray(raw.ids)) {
    idArray = raw.ids;
  } else {
    return { valid: false, error: `Adapter returned invalid result of type ${typeof raw}; expected Array, Set, or { ids: [] }` };
  }

  for (const item of idArray) {
    if (typeof item !== 'string') {
      return { valid: false, error: `Adapter result contains non-string ID: ${JSON.stringify(item)}` };
    }
  }

  return { valid: true, set: new Set(idArray) };
}

export async function runRelationalEval({ projectRoot, answer, goldenPath } = {}) {
  if (typeof answer !== 'function') {
    throw new TypeError('runRelationalEval requires an answer function: (question) => Promise<string[]>');
  }

  const targetGoldenPath = goldenPath ?? (
    projectRoot
      ? (projectRoot.endsWith('.json') ? projectRoot : resolve(projectRoot, 'tests', 'fixtures', 'layered-app', 'expected.json'))
      : resolve(__dirname, '../../tests/fixtures/layered-app/expected.json')
  );

  const fileContent = await readFile(targetGoldenPath, 'utf8');
  const golden = JSON.parse(fileContent);

  const schemaValidation = validateGoldenSchema(golden);
  if (!schemaValidation.valid) {
    throw new Error(`Golden schema validation failed: ${schemaValidation.error}`);
  }

  const questionReports = [];
  let totalPrecision = 0;
  let totalRecall = 0;

  for (const q of golden.questions) {
    const expectedSet = new Set(q.expected);
    const sortedExpected = Array.from(expectedSet).sort();

    try {
      const rawResult = await answer(q);
      const normalized = normalizeAdapterResult(rawResult);

      if (!normalized.valid) {
        questionReports.push({
          questionId: q.id,
          type: q.type,
          target: q.target,
          passed: false,
          expected: sortedExpected,
          actual: [],
          missing: sortedExpected,
          extra: [],
          precision: 0,
          recall: 0,
          error: normalized.error,
        });
        continue;
      }

      const actualSet = normalized.set;
      const sortedActual = Array.from(actualSet).sort();
      const { exactMatch, missing, extra, precision, recall } = computeMetrics(expectedSet, actualSet);

      totalPrecision += precision;
      totalRecall += recall;

      const failureReasons = [];
      if (missing.length > 0) failureReasons.push(`Missing IDs: ${missing.join(', ')}`);
      if (extra.length > 0) failureReasons.push(`Extra IDs: ${extra.join(', ')}`);

      questionReports.push({
        questionId: q.id,
        type: q.type,
        target: q.target,
        passed: exactMatch,
        expected: sortedExpected,
        actual: sortedActual,
        missing,
        extra,
        precision,
        recall,
        error: failureReasons.length > 0 ? failureReasons.join('; ') : null,
      });
    } catch (err) {
      questionReports.push({
        questionId: q.id,
        type: q.type,
        target: q.target,
        passed: false,
        expected: sortedExpected,
        actual: [],
        missing: sortedExpected,
        extra: [],
        precision: 0,
        recall: 0,
        error: `Adapter rejected: ${err.message || String(err)}`,
      });
    }
  }

  const totalQuestions = golden.questions.length;
  const passedQuestions = questionReports.filter((r) => r.passed).length;
  const accuracy = totalQuestions > 0 ? passedQuestions / totalQuestions : 0;
  const meanPrecision = totalPrecision > 0 ? totalPrecision / totalQuestions : 0;
  const meanRecall = totalRecall > 0 ? totalRecall / totalQuestions : 0;
  const f1 = (meanPrecision + meanRecall > 0)
    ? (2 * meanPrecision * meanRecall) / (meanPrecision + meanRecall)
    : 0;

  return {
    schemaVersion: golden.schemaVersion,
    fixture: golden.fixture,
    totalQuestions,
    passedQuestions,
    accuracy,
    meanPrecision,
    meanRecall,
    f1,
    questions: questionReports,
  };
}

async function findCodeFiles(dir, baseDir = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
        continue;
      }
      files.push(...await findCodeFiles(fullPath, baseDir));
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
      const relPath = fullPath.slice(baseDir.length + 1).replace(/\\/g, '/');
      files.push({ fullPath, relPath });
    }
  }
  return files;
}

export async function runBaseline({
  fixtureRoot,
  tempRoot,
  resolveGraphifyFn,
  runGraphifyUpdateFn,
} = {}) {
  const resolvedFixture = fixtureRoot
    ? resolve(fixtureRoot)
    : resolve(__dirname, '../../tests/fixtures/layered-app');

  let ownedChildDir = null;
  if (tempRoot) {
    const s = await stat(tempRoot);
    if (!s.isDirectory()) {
      throw new Error(`tempRoot must be an existing directory: ${tempRoot}`);
    }
    ownedChildDir = await mkdtemp(join(resolve(tempRoot), 'eval-child-'));
  } else {
    ownedChildDir = await mkdtemp(join(tmpdir(), 'pmc-eval-child-'));
  }

  try {
    // 1. Copy fixture sources only to owned child dir
    await mkdir(join(ownedChildDir, 'src'), { recursive: true });
    await mkdir(join(ownedChildDir, 'tests'), { recursive: true });
    await cp(join(resolvedFixture, 'src'), join(ownedChildDir, 'src'), { recursive: true });
    await cp(join(resolvedFixture, 'tests'), join(ownedChildDir, 'tests'), { recursive: true });

    // 2. Discover code files and measure extraction capabilities
    const codeFiles = await findCodeFiles(ownedChildDir);
    const extractedSymbols = [];
    const symbolKinds = {};

    for (const file of codeFiles) {
      const content = await readFile(file.fullPath, 'utf8');
      const symbols = await extractTopLevelSymbols({ filePath: file.relPath, content });
      for (const sym of symbols) {
        extractedSymbols.push(sym);
        symbolKinds[sym.kind] = (symbolKinds[sym.kind] ?? 0) + 1;
      }
    }

    const methodsExtracted = symbolKinds.method ?? 0;
    const extractionCapabilities = {
      filesScanned: codeFiles.length,
      symbolsExtracted: extractedSymbols.length,
      symbolKinds,
      methodsExtracted,
      note: 'Measured capabilities of symbol-extractor.mjs; TypeScript class methods currently unsupported until Task 1.2',
    };

    // 3. Probe graphify
    const resolveFn = resolveGraphifyFn ?? resolveGraphify;
    let graphifyBin = null;
    try {
      graphifyBin = resolveFn();
    } catch (err) {
      return {
        endToEnd: {
          status: 'UNAVAILABLE',
          reason: `graphify executable not found: ${err.message}`,
        },
        extractionCapabilities,
        graphifyProbe: { available: false, command: 'resolveGraphify', error: err.message },
      };
    }

    const graphifyProbe = { available: true, path: graphifyBin };

    // 4. Run graphify update on owned child dir
    const runUpdate = runGraphifyUpdateFn ?? runGraphifyUpdate;
    let graphResult;
    try {
      graphResult = await runUpdate(ownedChildDir, { timeoutMs: 30000, log: () => {} });
    } catch (err) {
      return {
        endToEnd: {
          status: 'NOT_RUN',
          reason: `graphify execution threw: ${err.message}`,
        },
        extractionCapabilities,
        graphifyProbe,
      };
    }

    if (!graphResult?.ran) {
      return {
        endToEnd: {
          status: 'NOT_RUN',
          reason: `graphify update did not complete successfully (ran=false${graphResult?.timedOut ? ', timed out' : ''})`,
        },
        extractionCapabilities,
        graphifyProbe,
      };
    }

    // 5. Read generated graph and link symbols
    const graphPath = join(ownedChildDir, '.planning', 'project-memory-context', 'graph', 'graph.json');
    let graph = { nodes: [], edges: [] };
    try {
      graph = JSON.parse(await readFile(graphPath, 'utf8'));
    } catch (err) {
      return {
        endToEnd: {
          status: 'NOT_RUN',
          reason: `Failed to read generated graph: ${err.message}`,
        },
        extractionCapabilities,
        graphifyProbe,
      };
    }

    const resolvedSymbols = attachGraphNodeIds({ symbols: extractedSymbols, graph });
    const enrichmentDir = join(ownedChildDir, '.planning', 'project-memory-context', 'enrichment');
    await mkdir(enrichmentDir, { recursive: true });

    const symbolIndex = {};
    for (const sym of resolvedSymbols) {
      symbolIndex[sym.symbolKey] = {
        graphNodeId: sym.graphNodeId,
        memoryId: null,
        codeHash: sym.codeHash,
        status: 'pending',
      };
    }
    await writeFile(join(enrichmentDir, 'symbol-index.json'), JSON.stringify(symbolIndex, null, 2), 'utf8');

    // 6. Query orchestrator evaluation
    const orchestrator = createQueryOrchestrator({ projectRoot: ownedChildDir });
    const evalResult = await runRelationalEval({
      goldenPath: join(resolvedFixture, 'expected.json'),
      answer: async (q) => {
        if (q.type === 'callers' || q.type === 'dependents') {
          const res = await orchestrator.getDependents(q.target);
          return (res ?? []).map((s) => s.symbolKey).filter(Boolean);
        }
        if (q.type === 'callees' || q.type === 'dependencies') {
          const res = await orchestrator.getDependencies(q.target);
          return (res ?? []).map((s) => s.symbolKey).filter(Boolean);
        }
        return [];
      },
    });

    return {
      endToEnd: {
        status: 'EVALUATED',
        accuracy: evalResult.accuracy,
        passedQuestions: evalResult.passedQuestions,
        totalQuestions: evalResult.totalQuestions,
        meanPrecision: evalResult.meanPrecision,
        meanRecall: evalResult.meanRecall,
        f1: evalResult.f1,
        questions: evalResult.questions,
      },
      extractionCapabilities,
      graphifyProbe,
    };
  } finally {
    if (ownedChildDir) {
      await rm(ownedChildDir, { recursive: true, force: true });
    }
  }
}

// CLI entrypoint
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  const args = process.argv.slice(2);
  const isStub = args.includes('--stub');

  if (isStub) {
    const fixtureGolden = resolve(__dirname, '../../tests/fixtures/layered-app/expected.json');
    readFile(fixtureGolden, 'utf8')
      .then(async (content) => {
        const golden = JSON.parse(content);
        const answers = new Map(golden.questions.map((q) => [q.id, q.expected]));
        const result = await runRelationalEval({
          goldenPath: fixtureGolden,
          answer: async (q) => answers.get(q.id) ?? [],
        });
        console.log(JSON.stringify({ mode: 'stub', ...result }, null, 2));
      })
      .catch((err) => {
        console.error(err);
        process.exitCode = 1;
      });
  } else {
    runBaseline()
      .then((report) => {
        console.log(JSON.stringify(report, null, 2));
      })
      .catch((err) => {
        console.error(err);
        process.exitCode = 1;
      });
  }
}
