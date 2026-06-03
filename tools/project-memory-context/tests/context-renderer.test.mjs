import test from 'node:test';
import assert from 'node:assert/strict';
import { renderContext } from '../src/retrieval/context-renderer.mjs';

test('renderContext produces compact output with target and neighbors', () => {
  const result = renderContext({
    target: { symbolKey: 'ts|src/a.ts|class|exported|MyClass|0', name: 'MyClass', filePath: 'src/a.ts', kind: 'class', graphNodeId: 'n1', memoryId: 'mem-1', status: 'enriched', range: null },
    neighbors: [
      { symbolKey: 'ts|src/b.ts|function|exported|helper|0', name: 'helper', filePath: 'src/b.ts', kind: 'function', graphNodeId: 'n2', memoryId: 'mem-2', status: 'enriched', range: null },
    ],
    edges: [{ source: 'n1', target: 'n2', relation: 'imports' }],
    depth: 'compact',
    depthReached: 1,
    projectBase: { stack: 'TypeScript + Node.js', architecture: 'MCP server' },
    memoryContents: new Map([
      ['mem-1', 'MyClass is the main entry point'],
      ['mem-2', 'helper provides utility functions'],
    ]),
  });

  assert.ok(result.includes('## Context:'));
  assert.ok(result.includes('MyClass'));
  assert.ok(result.includes('helper'));
  assert.ok(result.includes('TypeScript'));
  assert.ok(!result.includes('### Source Code'));
});

test('renderContext includes source code section when depth is disk', () => {
  const result = renderContext({
    target: { symbolKey: 'ts|src/a.ts|class|exported|MyClass|0', name: 'MyClass', filePath: 'src/a.ts', kind: 'class', graphNodeId: 'n1', memoryId: 'mem-1', status: 'enriched', range: { startLine: 1, endLine: 5 } },
    neighbors: [],
    edges: [],
    depth: 'disk',
    depthReached: 0,
    projectBase: { stack: 'TS', architecture: 'Test' },
    memoryContents: new Map([['mem-1', 'A class']]),
    sourceCode: 'export class MyClass {\n  constructor() {}\n}',
  });

  assert.ok(result.includes('### Source Code'));
  assert.ok(result.includes('export class MyClass'));
});

test('renderContext truncates output to respect maxTokens budget', () => {
  const longContent = 'x'.repeat(20000);
  const result = renderContext({
    target: { symbolKey: 'ts|src/a.ts|class|exported|MyClass|0', name: 'MyClass', filePath: 'src/a.ts', kind: 'class', graphNodeId: null, memoryId: 'mem-1', status: 'enriched', range: null },
    neighbors: [],
    edges: [],
    depth: 'compact',
    depthReached: 0,
    projectBase: { stack: 'TS', architecture: 'Test' },
    memoryContents: new Map([['mem-1', longContent]]),
  });

  const approxTokens = result.length / 4;
  assert.ok(approxTokens <= 2200, `Expected <= 2200 tokens, got ${approxTokens}`);
});
