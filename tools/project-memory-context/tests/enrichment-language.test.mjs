/**
 * Enrichment output language contract (prospective only).
 *
 * All future symbol enrichments must explicitly require English descriptive
 * output in the prompt surfaces the pipeline actually uses:
 *   1. src/semantic-unit.mjs        -> buildSemanticPrompt (runtime test)
 *   2. cli/enrich-queue.mjs         -> buildSymbolPromptMeta via the real
 *      runQueueSymbolEnrichment path (fixture integration, not a fake helper)
 *   3. cli/retry-errors.mjs         -> buildSymbolPrompt (runtime test; the
 *      module only autoruns main() under its main-guard, so importing is safe)
 *   4. mcp/local-model-server.mjs   -> generateSemanticReport system prompt.
 *      Source contract, NOT runtime: the module connects an stdio MCP transport
 *      at import time (top-level `await server.connect(...)`), so importing it
 *      from a test would hang the runner.
 *   5. templates/{opencode,claude-code,antigravity}/enrich.* -> the subagent
 *      wrapper instruction. Source contract: these are agent-facing markdown
 *      templates, not executable modules. The wrapper sentence also overrides
 *      queued entries whose stored prompt predates the English requirement,
 *      without rewriting the queue.
 *
 * These tests assert that the English requirement and the preserve-verbatim
 * contract are present in the prompts. They do NOT (and cannot) guarantee what
 * an LLM eventually writes, and they intentionally do not classify or reject
 * non-English records.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSemanticUnit } from '../src/semantic-unit.mjs';
import { runQueueSymbolEnrichment } from '../cli/enrich-queue.mjs';
import { ensureProjectMemoryContextDirs } from '../src/artifacts.mjs';

const PMC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ENGLISH_INSTRUCTION =
  'Write all descriptive explanation fields in English, regardless of source comments or conversation language. Preserve code, identifiers, paths, tags and structured keys exactly.';

// ---------------------------------------------------------------------------
// 1. semantic-unit.mjs — buildSemanticPrompt (runtime)
// ---------------------------------------------------------------------------

test('buildSemanticPrompt requires English output and preserves code, identifiers and programming-language line', () => {
  const unit = buildSemanticUnit({
    symbol: {
      symbolKey: 'ts|src/user.ts|function|exported|getUser|3',
      language: 'ts',
      filePath: 'src/user.ts',
      kind: 'function',
      name: 'getUser',
      range: { startLine: 3, endLine: 5 },
    },
    content: [
      "import { api } from './api';",
      '',
      'export async function getUser(id, includePosts) {',
      '  return api.get(id);',
      '}',
    ].join('\n'),
  });

  assert.ok(
    unit.prompt.includes(ENGLISH_INSTRUCTION),
    'prompt must carry the explicit English-output instruction',
  );
  // Preserve-verbatim contract: code and identifiers unchanged in the prompt.
  assert.ok(unit.prompt.includes('export async function getUser(id, includePosts) {'));
  assert.ok(unit.prompt.includes("import { api } from './api';"));
  // symbol.language is the programming language; it is never rewritten to 'en'.
  assert.ok(unit.prompt.includes('Language: ts'));
  assert.ok(!unit.prompt.includes('Language: en'));
});

// ---------------------------------------------------------------------------
// 2. cli/enrich-queue.mjs — real active path through runQueueSymbolEnrichment
//    (fixture integration: no pre-built prompt override, so buildSymbolPrompt
//    -> buildSymbolPromptMeta actually runs).
// ---------------------------------------------------------------------------

test('queue enrichment active path builds prompts with explicit English instruction', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-enrichment-language-'));
  try {
    const dirs = await ensureProjectMemoryContextDirs(projectRoot);
    const sourceDir = join(projectRoot, 'src');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, 'user.ts'),
      [
        "import { db } from './db';",
        '',
        'export async function getUser(id) {',
        '  return db.users.find(id);',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const symbol = {
      symbolKey: 'ts|src/user.ts|function|exported|getUser|1',
      name: 'getUser',
      kind: 'function',
      language: 'ts',
      filePath: 'src/user.ts',
      codeHash: 'hash-lang',
      range: { startLine: 3, endLine: 5 },
      status: 'pending',
    };

    const worklistFile = join(dirs.enrichment, 'worklist.json');
    const symbolIndexFile = join(dirs.enrichment, 'symbol-index.json');
    const worklist = [structuredClone(symbol)];
    await writeFile(worklistFile, JSON.stringify(worklist, null, 2), 'utf8');
    await writeFile(symbolIndexFile, JSON.stringify({}, null, 2), 'utf8');

    let receivedPrompt;
    const result = await runQueueSymbolEnrichment({
      symbol,
      projectRoot,
      projectSlug: 'language-test',
      timeoutMs: 30_000,
      enrichmentDir: dirs.enrichment,
      worklist,
      worklistFile,
      symbolIndex: {},
      symbolIndexFile,
      config: { preferredModes: ['local-model'] },
      providers: [],
      runEnrichmentWithFallbackImpl: async ({ request }) => {
        receivedPrompt = request.prompt;
        return {
          status: 'succeeded',
          content: 'Looks up a user by id.',
          mode: 'local-model',
          attempts: [],
        };
      },
    });

    assert.equal(result.status, 'enriched');
    assert.ok(
      receivedPrompt.includes(ENGLISH_INSTRUCTION),
      'actively built queue prompt must carry the explicit English-output instruction',
    );
    assert.ok(receivedPrompt.includes('export async function getUser(id) {'));
    assert.ok(receivedPrompt.includes("import { db } from './db';"));
    assert.ok(receivedPrompt.includes('Language: ts'));
    assert.ok(!receivedPrompt.includes('Language: en'));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. cli/retry-errors.mjs — buildSymbolPrompt (runtime; main() only autoruns
//    under the module's main-guard, so a dynamic import is side-effect free).
// ---------------------------------------------------------------------------

test('retry-errors buildSymbolPrompt requires English output and preserves code and language line', async () => {
  const mod = await import('../cli/retry-errors.mjs');
  assert.equal(typeof mod.buildSymbolPrompt, 'function', 'retry-errors must export its prompt builder for this contract');

  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-retry-language-'));
  try {
    const srcDir = join(projectRoot, 'src');
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      join(srcDir, 'bar.ts'),
      [
        'export function bar(x) {',
        '  return x * 2;',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );

    const symbol = {
      symbolKey: 'ts|src/bar.ts|function|exported|bar|1',
      name: 'bar',
      kind: 'function',
      language: 'ts',
      filePath: 'src/bar.ts',
      range: { startLine: 1, endLine: 3 },
    };

    const prompt = await mod.buildSymbolPrompt(symbol, projectRoot);
    assert.ok(
      prompt.includes(ENGLISH_INSTRUCTION),
      'retry prompt must carry the explicit English-output instruction',
    );
    assert.ok(prompt.includes('export function bar(x) {'));
    assert.ok(prompt.includes('Language: ts'));
    assert.ok(!prompt.includes('Language: en'));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. mcp/local-model-server.mjs — generateSemanticReport system prompt.
//    Source contract (see header comment for why this is not a runtime test).
// ---------------------------------------------------------------------------

test('local-model-server system prompt requires English output (source contract; module connects stdio MCP at import)', async () => {
  const source = await readFile(
    join(PMC_ROOT, 'mcp', 'local-model-server.mjs'),
    'utf8',
  );
  assert.ok(
    source.includes(ENGLISH_INSTRUCTION),
    'semantic_report system prompt must carry the explicit English-output instruction',
  );
});

// ---------------------------------------------------------------------------
// 5. Agent template wrapper instructions (source contract; agent-facing
//    markdown). The wrapper sentence also applies to queued entries whose
//    stored prompt predates the English requirement — the queue is not
//    rewritten.
// ---------------------------------------------------------------------------

test('enrich agent templates (opencode, claude-code, antigravity) override queued prompt language prospectively', async () => {
  const templatePaths = [
    ['templates', 'opencode', 'agent', 'enrich.md'],
    ['templates', 'claude-code', 'agents', 'enrich.md'],
    ['templates', 'antigravity', 'skills', 'enrich', 'SKILL.md'],
  ];

  for (const parts of templatePaths) {
    const path = join(PMC_ROOT, ...parts);
    const source = await readFile(path, 'utf8');
    assert.ok(
      source.includes(ENGLISH_INSTRUCTION),
      `${parts.join('/')} subagent wrapper must carry the explicit English-output instruction`,
    );
    // The instruction must sit in the wrapper prompt block (which wraps
    // <entry.prompt>), not somewhere unrelated in the document.
    const wrapperIndex = source.indexOf('Return ONLY the structured explanation');
    assert.ok(wrapperIndex !== -1, `${parts.join('/')} must keep the wrapper instruction`);
    assert.ok(
      source.indexOf(ENGLISH_INSTRUCTION) > wrapperIndex,
      `${parts.join('/')} English instruction must follow the wrapper instruction block`,
    );
  }
});
