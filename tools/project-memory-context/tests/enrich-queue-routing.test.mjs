/**
 * Tests for the token-based routing logic in enrich-queue.mjs:
 * - Symbols with tokenCount >= threshold → subagent-queued in worklist + appended to subagent-queue.json
 * - Symbols with tokenCount < threshold  → enriched via runQueueSymbolEnrichment (Ollama path)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runQueueSymbolEnrichment, buildQueueSummary, persistEnrichmentSuccess, shouldRouteToSubagent } from '../cli/enrich-queue.mjs';
import { loadSubagentQueue } from '../src/subagent-queue.mjs';

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

async function makeTempProject() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'pmc-routing-test-'));
  const enrichmentDir = join(projectRoot, '.planning', 'project-memory-context', 'enrichment');
  await mkdir(enrichmentDir, { recursive: true });

  // Create a minimal source file so buildSymbolPrompt can read it
  const srcDir = join(projectRoot, 'src');
  await mkdir(srcDir, { recursive: true });
  await writeFile(join(srcDir, 'foo.mjs'), [
    'export function foo() {',
    '  return 42;',
    '}',
  ].join('\n'), 'utf8');

  return { projectRoot, enrichmentDir };
}

function makeSymbol(overrides = {}) {
  return {
    symbolKey: 'js|src/foo.mjs|function|exported|foo|0',
    name: 'foo',
    filePath: 'src/foo.mjs',
    language: 'js',
    kind: 'function',
    codeHash: 'abc123',
    graphNodeId: null,
    range: { startLine: 1, endLine: 3 },
    ...overrides,
  };
}

// -------------------------------------------------------------------
// persistEnrichmentSuccess
// -------------------------------------------------------------------

test('persistEnrichmentSuccess writes memory file and updates worklist and symbol-index', async () => {
  const { projectRoot, enrichmentDir } = await makeTempProject();
  try {
    const worklistFile = join(enrichmentDir, 'worklist.json');
    const symbolIndexFile = join(enrichmentDir, 'symbol-index.json');
    const symbol = makeSymbol();
    const worklist = [{ ...symbol, status: 'pending' }];
    const symbolIndex = {};

    await writeFile(worklistFile, JSON.stringify(worklist, null, 2), 'utf8');
    await writeFile(symbolIndexFile, JSON.stringify(symbolIndex, null, 2), 'utf8');

    const { memoryId } = await persistEnrichmentSuccess({
      symbol,
      content: 'foo is a function that returns 42.',
      enrichedByTag: 'enriched-by-queue',
      enrichmentDir,
      worklist,
      worklistFile,
      symbolIndex,
      symbolIndexFile,
      projectSlug: 'test-project',
      attempts: [],
    });

    assert.ok(memoryId, 'should return a memoryId');

    // Worklist entry updated
    const wlEntry = worklist.find((e) => e.symbolKey === symbol.symbolKey);
    assert.equal(wlEntry.status, 'enriched');
    assert.equal(wlEntry.memoryId, memoryId);

    // Symbol index updated
    assert.equal(symbolIndex[symbol.symbolKey].status, 'enriched');
    assert.equal(symbolIndex[symbol.symbolKey].memoryId, memoryId);

    // Memory file written
    const { readFile: rf } = await import('node:fs/promises');
    const safeSymbolKey = symbol.symbolKey.replace(/[^a-zA-Z0-9_-]+/g, '_');
    const memoryContent = JSON.parse(await rf(join(enrichmentDir, `${safeSymbolKey}.memory.json`), 'utf8'));
    assert.equal(memoryContent.content, 'foo is a function that returns 42.');
    // enrichedByTag appears in sync-manifest (not in memory.json tags)
    assert.ok(Array.isArray(memoryContent.tags));
    assert.ok(memoryContent.tags.includes('symbol'));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------
// runQueueSymbolEnrichment with pre-built prompt
// -------------------------------------------------------------------

test('runQueueSymbolEnrichment accepts a pre-built prompt (no double file read)', async () => {
  const { projectRoot, enrichmentDir } = await makeTempProject();
  try {
    const worklistFile = join(enrichmentDir, 'worklist.json');
    const symbolIndexFile = join(enrichmentDir, 'symbol-index.json');
    const symbol = makeSymbol();
    const worklist = [{ ...symbol, status: 'pending' }];
    const symbolIndex = {};

    await writeFile(worklistFile, JSON.stringify(worklist, null, 2), 'utf8');
    await writeFile(symbolIndexFile, JSON.stringify(symbolIndex, null, 2), 'utf8');

    let receivedPrompt;
    const mockFallback = async ({ request }) => {
      receivedPrompt = request.prompt;
      return { status: 'succeeded', content: 'result text', mode: 'local-model', attempts: [] };
    };

    const result = await runQueueSymbolEnrichment({
      symbol,
      projectRoot,
      projectSlug: 'test',
      timeoutMs: 5000,
      enrichmentDir,
      worklist,
      worklistFile,
      symbolIndex,
      symbolIndexFile,
      config: { preferredModes: ['local-model'], localModel: {}, subagentTokenThreshold: 10000 },
      providers: [],
      prompt: 'PRE-BUILT PROMPT',
      runEnrichmentWithFallbackImpl: mockFallback,
    });

    assert.equal(receivedPrompt, 'PRE-BUILT PROMPT', 'should use pre-built prompt');
    assert.equal(result.status, 'enriched');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------
// buildQueueSummary includes subagentQueued
// -------------------------------------------------------------------

test('buildQueueSummary counts subagent-queued entries separately', () => {
  const worklist = [
    { status: 'enriched', memoryId: 'a' },
    { status: 'already_enriched', memoryId: 'b' },
    { status: 'error' },
    { status: 'pending' },
    { status: 'stale' },
    { status: 'subagent-queued' },
    { status: 'subagent-queued' },
  ];

  const summary = buildQueueSummary(worklist);
  assert.equal(summary.enriched, 2);
  assert.equal(summary.errors, 1);
  assert.equal(summary.pending, 2);
  assert.equal(summary.subagentQueued, 2);
});

test('buildQueueSummary subagentQueued is 0 when no such entries', () => {
  const worklist = [
    { status: 'enriched', memoryId: 'a' },
    { status: 'pending' },
  ];
  const summary = buildQueueSummary(worklist);
  assert.equal(summary.subagentQueued, 0);
});

// -------------------------------------------------------------------
// shouldRouteToSubagent
// -------------------------------------------------------------------

test('shouldRouteToSubagent: file-coverage >= threshold routes to subagent regardless of tokens', () => {
  // Simulates an EF migration: 540 lines out of 560 total = 96% coverage, but low tokens
  const result = shouldRouteToSubagent({
    tokens: 1200,
    tokenThreshold: 5000,
    span: 540,
    totalLines: 560,
    coverageThreshold: 0.8,
  });
  assert.equal(result.route, true);
  assert.equal(result.reason, 'file-coverage');
  assert.ok(result.coverage >= 0.8);
});

test('shouldRouteToSubagent: token threshold routes to subagent when coverage is low', () => {
  const result = shouldRouteToSubagent({
    tokens: 6000,
    tokenThreshold: 5000,
    span: 50,
    totalLines: 400,
    coverageThreshold: 0.8,
  });
  assert.equal(result.route, true);
  assert.equal(result.reason, 'token-threshold');
  assert.ok(result.coverage < 0.8);
});

test('shouldRouteToSubagent: both below threshold routes to ollama', () => {
  const result = shouldRouteToSubagent({
    tokens: 300,
    tokenThreshold: 5000,
    span: 20,
    totalLines: 200,
    coverageThreshold: 0.8,
  });
  assert.equal(result.route, false);
  assert.equal(result.reason, 'ollama');
});

test('shouldRouteToSubagent: totalLines=0 does not throw and routes by tokens', () => {
  const result = shouldRouteToSubagent({
    tokens: 6000,
    tokenThreshold: 5000,
    span: 10,
    totalLines: 0,
    coverageThreshold: 0.8,
  });
  assert.equal(result.route, true);
  assert.equal(result.reason, 'token-threshold');
  assert.equal(result.coverage, 0);
});

test('shouldRouteToSubagent: totalLines=0 with low tokens routes to ollama', () => {
  const result = shouldRouteToSubagent({
    tokens: 100,
    tokenThreshold: 5000,
    span: 10,
    totalLines: 0,
    coverageThreshold: 0.8,
  });
  assert.equal(result.route, false);
  assert.equal(result.reason, 'ollama');
  assert.equal(result.coverage, 0);
});

test('shouldRouteToSubagent: exactly at coverage threshold routes to subagent', () => {
  const result = shouldRouteToSubagent({
    tokens: 100,
    tokenThreshold: 5000,
    span: 80,
    totalLines: 100,
    coverageThreshold: 0.8,
  });
  assert.equal(result.route, true);
  assert.equal(result.reason, 'file-coverage');
  assert.equal(result.coverage, 0.8);
});
