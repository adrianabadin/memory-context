import test from 'node:test';
import assert from 'node:assert/strict';

import { createQueryEngine } from '../src/retrieval/query-engine.mjs';
import { renderContext } from '../src/retrieval/context-renderer.mjs';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMemoryStore(overrides = {}) {
  return {
    async getBySymbol(symbolKey) {
      return overrides[symbolKey] ?? [];
    },
    ...overrides,
  };
}

function makeEngine({ memoryStore, symbolIndex, worklist, graph } = {}) {
  return createQueryEngine({
    graphStore: undefined,
    graph: graph ?? {
      nodes: [
        { id: 'n1', label: 'MyClass', kind: 'class', source_file: 'src/mod.ts' },
        { id: 'n2', label: 'helper', kind: 'function', source_file: 'src/helper.ts' },
      ],
      links: [
        { source: 'n1', target: 'n2', relation: 'imports' },
      ],
    },
    symbolIndex: symbolIndex ?? {
      'ts|src/mod.ts|class|exported|MyClass|0': { graphNodeId: 'n1', memoryId: 'mem-1', codeHash: 'h1', status: 'enriched' },
      'ts|src/helper.ts|function|exported|helper|0': { graphNodeId: 'n2', memoryId: 'mem-2', codeHash: 'h2', status: 'enriched' },
    },
    worklist: worklist ?? [
      { symbolKey: 'ts|src/mod.ts|class|exported|MyClass|0', name: 'MyClass', filePath: 'src/mod.ts', kind: 'class', range: { startLine: 1, endLine: 20 } },
      { symbolKey: 'ts|src/helper.ts|function|exported|helper|0', name: 'helper', filePath: 'src/helper.ts', kind: 'function', range: { startLine: 1, endLine: 5 } },
    ],
    enrichmentDir: '/tmp/enrich',
    projectSlug: 'test',
    memoryStore,
  });
}

// ── query-engine: MemoryStore integration ────────────────────────────────────

test('querySymbolContext includes linked memories when MemoryStore provided', async () => {
  const sk = 'ts|src/mod.ts|class|exported|MyClass|0';
  const linkedResults = [
    { id: 'lm-1', source: 'memory', symbolKey: sk, content: 'MyClass manages user sessions', createdAt: '2026-06-23T00:00:00.000Z' },
    { id: 'lm-2', source: 'memory', symbolKey: sk, content: 'Handles authentication flows', createdAt: '2026-06-23T00:00:00.000Z' },
  ];
  const memoryStore = {
    async getBySymbol(symbolKey) {
      if (symbolKey === sk) return linkedResults;
      return [];
    },
  };

  const engine = makeEngine({ memoryStore });
  const result = await engine.querySymbolContext({
    symbolKey: 'ts|src/mod.ts|class|exported|MyClass|0',
    depth: 'compact',
  });

  assert.ok(Array.isArray(result.target.linkedMemories), 'target should have linkedMemories array');
  assert.equal(result.target.linkedMemories.length, 2);
  assert.equal(result.target.linkedMemories[0].content, 'MyClass manages user sessions');
});

test('querySymbolContext returns empty linkedMemories when no MemoryStore', async () => {
  const engine = makeEngine();
  const result = await engine.querySymbolContext({
    symbolKey: 'ts|src/mod.ts|class|exported|MyClass|0',
    depth: 'compact',
  });

  assert.ok(Array.isArray(result.target.linkedMemories));
  assert.equal(result.target.linkedMemories.length, 0);
});

test('querySymbolContext returns empty linkedMemories when MemoryStore returns nothing', async () => {
  const memoryStore = { async getBySymbol() { return []; } };
  const engine = makeEngine({ memoryStore });
  const result = await engine.querySymbolContext({
    symbolKey: 'ts|src/mod.ts|class|exported|MyClass|0',
    depth: 'compact',
  });

  assert.ok(Array.isArray(result.target.linkedMemories));
  assert.equal(result.target.linkedMemories.length, 0);
});

test('querySymbolContext attaches linkedMemories to neighbors too', async () => {
  const helperSk = 'ts|src/helper.ts|function|exported|helper|0';
  const neighborResults = [
    { id: 'nm-1', source: 'memory', symbolKey: helperSk, content: 'helper provides utility functions', createdAt: '2026-06-23T00:00:00.000Z' },
  ];
  const memoryStore = {
    async getBySymbol(symbolKey) {
      if (symbolKey === helperSk) return neighborResults;
      return [];
    },
  };

  const engine = makeEngine({ memoryStore });
  const result = await engine.querySymbolContext({
    symbolKey: 'ts|src/mod.ts|class|exported|MyClass|0',
    depth: 'compact',
  });

  const helperNeighbor = result.neighbors.find(n => n.symbolKey === 'ts|src/helper.ts|function|exported|helper|0');
  assert.ok(helperNeighbor, 'helper should be a neighbor');
  assert.ok(Array.isArray(helperNeighbor.linkedMemories));
  assert.equal(helperNeighbor.linkedMemories.length, 1);
  assert.equal(helperNeighbor.linkedMemories[0].content, 'helper provides utility functions');
});

test('querySymbolContext handles MemoryStore.getBySymbol throwing gracefully', async () => {
  const memoryStore = {
    async getBySymbol() { throw new Error('SQLITE_BUSY'); },
  };

  const engine = makeEngine({ memoryStore });
  const result = await engine.querySymbolContext({
    symbolKey: 'ts|src/mod.ts|class|exported|MyClass|0',
    depth: 'compact',
  });

  // Should not throw; linkedMemories should be empty on error
  assert.ok(Array.isArray(result.target.linkedMemories));
  assert.equal(result.target.linkedMemories.length, 0);
});

// ── context-renderer: Semantic Memory section ────────────────────────────────

test('renderContext includes Semantic Memory section when linkedMemories present', () => {
  const result = renderContext({
    target: {
      symbolKey: 'ts|src/a.ts|class|exported|MyClass|0',
      name: 'MyClass', filePath: 'src/a.ts', kind: 'class',
      graphNodeId: 'n1', memoryId: 'mem-1', status: 'enriched', range: null,
      linkedMemories: [
        { id: 'lm-1', content: 'MyClass is the main entry point for user management', type: 'manual', scope: 'project' },
      ],
    },
    neighbors: [],
    edges: [],
    depth: 'compact',
    depthReached: 0,
    projectBase: { stack: 'TS', architecture: 'Test' },
    memoryContents: new Map([['mem-1', 'Enrichment content']]),
  });

  assert.ok(result.includes('### Semantic Memory'), 'Should include Semantic Memory section');
  assert.ok(result.includes('MyClass is the main entry point'), 'Should include linked memory content');
});

test('renderContext truncates linked memory to 200 chars at compact depth', () => {
  const longContent = 'A'.repeat(500);
  const result = renderContext({
    target: {
      symbolKey: 'ts|src/a.ts|class|exported|MyClass|0',
      name: 'MyClass', filePath: 'src/a.ts', kind: 'class',
      graphNodeId: 'n1', memoryId: 'mem-1', status: 'enriched', range: null,
      linkedMemories: [
        { id: 'lm-1', content: longContent, type: 'manual', scope: 'project' },
      ],
    },
    neighbors: [],
    edges: [],
    depth: 'compact',
    depthReached: 0,
    projectBase: { stack: 'TS', architecture: 'Test' },
    memoryContents: new Map([['mem-1', 'Enrichment']]),
  });

  // At compact depth, linked memory should be truncated to 200 chars
  assert.ok(result.includes(longContent.slice(0, 200)), 'Should include first 200 chars');
  assert.ok(!result.includes(longContent), 'Should NOT include full 500 chars');
});

test('renderContext shows full linked memory at extended depth', () => {
  const content = 'B'.repeat(500);
  const result = renderContext({
    target: {
      symbolKey: 'ts|src/a.ts|class|exported|MyClass|0',
      name: 'MyClass', filePath: 'src/a.ts', kind: 'class',
      graphNodeId: 'n1', memoryId: 'mem-1', status: 'enriched', range: null,
      linkedMemories: [
        { id: 'lm-1', content, type: 'manual', scope: 'project' },
      ],
    },
    neighbors: [],
    edges: [],
    depth: 'extended',
    depthReached: 1,
    projectBase: { stack: 'TS', architecture: 'Test' },
    memoryContents: new Map([['mem-1', 'Enrichment']]),
  });

  assert.ok(result.includes(content), 'Should include full content at extended depth');
});

test('renderContext does NOT include Semantic Memory section when linkedMemories empty', () => {
  const result = renderContext({
    target: {
      symbolKey: 'ts|src/a.ts|class|exported|MyClass|0',
      name: 'MyClass', filePath: 'src/a.ts', kind: 'class',
      graphNodeId: 'n1', memoryId: 'mem-1', status: 'enriched', range: null,
      linkedMemories: [],
    },
    neighbors: [],
    edges: [],
    depth: 'compact',
    depthReached: 0,
    projectBase: { stack: 'TS', architecture: 'Test' },
    memoryContents: new Map([['mem-1', 'Enrichment']]),
  });

  assert.ok(!result.includes('### Semantic Memory'), 'Should NOT include Semantic Memory section');
});

test('renderContext does NOT include Semantic Memory section when linkedMemories absent', () => {
  const result = renderContext({
    target: {
      symbolKey: 'ts|src/a.ts|class|exported|MyClass|0',
      name: 'MyClass', filePath: 'src/a.ts', kind: 'class',
      graphNodeId: 'n1', memoryId: 'mem-1', status: 'enriched', range: null,
    },
    neighbors: [],
    edges: [],
    depth: 'compact',
    depthReached: 0,
    projectBase: { stack: 'TS', architecture: 'Test' },
    memoryContents: new Map([['mem-1', 'Enrichment']]),
  });

  assert.ok(!result.includes('### Semantic Memory'), 'Should NOT include Semantic Memory section');
});

test('renderContext shows Semantic Memory from neighbors at extended depth', () => {
  const result = renderContext({
    target: {
      symbolKey: 'ts|src/a.ts|class|exported|MyClass|0',
      name: 'MyClass', filePath: 'src/a.ts', kind: 'class',
      graphNodeId: 'n1', memoryId: 'mem-1', status: 'enriched', range: null,
      linkedMemories: [],
    },
    neighbors: [
      {
        symbolKey: 'ts|src/b.ts|function|exported|helper|0',
        name: 'helper', filePath: 'src/b.ts', kind: 'function',
        graphNodeId: 'n2', memoryId: 'mem-2', status: 'enriched', range: null,
        linkedMemories: [
          { id: 'nm-1', content: 'helper provides utility functions for the system', type: 'manual', scope: 'project' },
        ],
      },
    ],
    edges: [{ source: 'n1', target: 'n2', relation: 'imports' }],
    depth: 'extended',
    depthReached: 1,
    projectBase: { stack: 'TS', architecture: 'Test' },
    memoryContents: new Map([['mem-1', 'Enrichment'], ['mem-2', 'Helper enrichment']]),
  });

  assert.ok(result.includes('### Semantic Memory'), 'Should include Semantic Memory section');
  assert.ok(result.includes('helper provides utility functions'), 'Should include neighbor linked memory');
});

// ── lock-tolerant retry ──────────────────────────────────────────────────────

test('withLockRetry retries on SQLITE_BUSY and succeeds on second attempt', async () => {
  const { withLockRetry } = await import('../src/retrieval/lock-retry.mjs');

  let attempts = 0;
  const result = await withLockRetry(() => {
    attempts++;
    if (attempts === 1) {
      const err = new Error('SQLITE_BUSY');
      err.code = 'SQLITE_BUSY';
      throw err;
    }
    return 'success';
  });

  assert.equal(result, 'success');
  assert.equal(attempts, 2);
});

test('withLockRetry returns stale data after maxAttempts exhausted', async () => {
  const { withLockRetry } = await import('../src/retrieval/lock-retry.mjs');

  let attempts = 0;
  const staleData = { data: 'stale', stale: true };
  const result = await withLockRetry(
    () => {
      attempts++;
      const err = new Error('SQLITE_BUSY');
      err.code = 'SQLITE_BUSY';
      throw err;
    },
    { maxAttempts: 3, staleFallback: staleData, baseDelay: 10 },
  );

  assert.deepEqual(result, staleData);
  assert.equal(attempts, 3);
});

test('withLockRetry does not retry on non-BUSY errors', async () => {
  const { withLockRetry } = await import('../src/retrieval/lock-retry.mjs');

  let attempts = 0;
  await assert.rejects(
    () => withLockRetry(() => {
      attempts++;
      throw new Error('SQLITE_CORRUPT');
    }),
    { message: 'SQLITE_CORRUPT' },
  );

  assert.equal(attempts, 1, 'Should not retry non-BUSY errors');
});

test('withLockRetry succeeds on first attempt without retry', async () => {
  const { withLockRetry } = await import('../src/retrieval/lock-retry.mjs');

  let attempts = 0;
  const result = await withLockRetry(() => {
    attempts++;
    return 42;
  });

  assert.equal(result, 42);
  assert.equal(attempts, 1);
});

// ── TRIANGULATION: additional edge cases ─────────────────────────────────────

test('querySymbolContext handles multiple linked memories on one symbol', async () => {
  const sk = 'ts|src/mod.ts|class|exported|MyClass|0';
  const memoryStore = {
    async getBySymbol(symbolKey) {
      if (symbolKey === sk) {
        return [
          { id: 'lm-1', source: 'memory', symbolKey: sk, content: 'First memory', createdAt: '2026-06-23T00:00:00.000Z' },
          { id: 'lm-2', source: 'memory', symbolKey: sk, content: 'Second memory', createdAt: '2026-06-23T00:00:00.000Z' },
          { id: 'lm-3', source: 'memory', symbolKey: sk, content: 'Third memory', createdAt: '2026-06-23T00:00:00.000Z' },
        ];
      }
      return [];
    },
  };

  const engine = makeEngine({ memoryStore });
  const result = await engine.querySymbolContext({
    symbolKey: sk,
    depth: 'compact',
  });

  assert.equal(result.target.linkedMemories.length, 3);
  assert.equal(result.target.linkedMemories[0].type, 'memory');
  assert.equal(result.target.linkedMemories[1].type, 'memory');
  assert.equal(result.target.linkedMemories[2].type, 'memory');
});

test('queryFileContext includes linkedMemories on file symbols', async () => {
  const sk = 'ts|src/mod.ts|class|exported|MyClass|0';
  const memoryStore = {
    async getBySymbol(symbolKey) {
      if (symbolKey === sk) {
        return [{ id: 'lm-1', source: 'memory', symbolKey: sk, content: 'MyClass linked memory', createdAt: '2026-06-23T00:00:00.000Z' }];
      }
      return [];
    },
  };

  const engine = makeEngine({ memoryStore });
  const result = await engine.queryFileContext({ filePath: 'src/mod.ts', depth: 'compact' });

  assert.ok(result.symbols.length >= 1);
  const myClass = result.symbols.find(s => s.name === 'MyClass');
  assert.ok(myClass, 'Should find MyClass symbol');
  assert.ok(Array.isArray(myClass.linkedMemories));
  assert.equal(myClass.linkedMemories.length, 1);
  assert.equal(myClass.linkedMemories[0].content, 'MyClass linked memory');
});

test('queryImpactScope includes linkedMemories on dependent symbols', async () => {
  const graph = {
    nodes: [
      { id: 'n1', label: 'MyClass', kind: 'class', source_file: 'src/mod.ts' },
      { id: 'n2', label: 'helper', kind: 'function', source_file: 'src/helper.ts' },
      { id: 'n3', label: 'caller', kind: 'function', source_file: 'src/caller.ts' },
    ],
    links: [
      { source: 'n3', target: 'n1', relation: 'calls' },
      { source: 'n1', target: 'n2', relation: 'imports' },
    ],
  };
  const symbolIndex = {
    'ts|src/mod.ts|class|exported|MyClass|0': { graphNodeId: 'n1', memoryId: 'mem-1', status: 'enriched' },
    'ts|src/helper.ts|function|exported|helper|0': { graphNodeId: 'n2', memoryId: 'mem-2', status: 'enriched' },
    'ts|src/caller.ts|function|exported|caller|0': { graphNodeId: 'n3', memoryId: 'mem-3', status: 'enriched' },
  };
  const callerSk = 'ts|src/caller.ts|function|exported|caller|0';
  const memoryStore = {
    async getBySymbol(symbolKey) {
      if (symbolKey === callerSk) {
        return [{ id: 'lm-1', source: 'memory', symbolKey: callerSk, content: 'caller invokes MyClass', createdAt: '2026-06-23T00:00:00.000Z' }];
      }
      return [];
    },
  };

  const engine = makeEngine({ graph, symbolIndex, memoryStore, worklist: [] });
  const result = await engine.queryImpactScope({
    symbolKeys: ['ts|src/mod.ts|class|exported|MyClass|0'],
    depth: 'compact',
  });

  assert.ok(result.dependents.length >= 1);
  const callerDep = result.dependents.find(d => d.symbolKey === callerSk);
  assert.ok(callerDep, 'caller should be a dependent');
  assert.ok(Array.isArray(callerDep.linkedMemories));
  assert.equal(callerDep.linkedMemories.length, 1);
});

test('renderContext includes linked memories from both target and neighbors', () => {
  const result = renderContext({
    target: {
      symbolKey: 'ts|src/a.ts|class|exported|MyClass|0',
      name: 'MyClass', filePath: 'src/a.ts', kind: 'class',
      graphNodeId: 'n1', memoryId: 'mem-1', status: 'enriched', range: null,
      linkedMemories: [
        { id: 'lm-1', content: 'Target memory content', type: 'manual', scope: 'project' },
      ],
    },
    neighbors: [
      {
        symbolKey: 'ts|src/b.ts|function|exported|helper|0',
        name: 'helper', filePath: 'src/b.ts', kind: 'function',
        graphNodeId: 'n2', memoryId: 'mem-2', status: 'enriched', range: null,
        linkedMemories: [
          { id: 'lm-2', content: 'Neighbor memory content', type: 'architecture', scope: 'project' },
        ],
      },
    ],
    edges: [{ source: 'n1', target: 'n2', relation: 'imports' }],
    depth: 'extended',
    depthReached: 1,
    projectBase: { stack: 'TS', architecture: 'Test' },
    memoryContents: new Map([['mem-1', 'Enrichment'], ['mem-2', 'Helper enrichment']]),
  });

  assert.ok(result.includes('Target memory content'), 'Should include target linked memory');
  assert.ok(result.includes('Neighbor memory content'), 'Should include neighbor linked memory');
  assert.ok(result.includes('(manual)'), 'Should include type tag for target');
  assert.ok(result.includes('(architecture)'), 'Should include type tag for neighbor');
});

test('renderContext disk depth shows linked memories AND source code', () => {
  const result = renderContext({
    target: {
      symbolKey: 'ts|src/a.ts|class|exported|MyClass|0',
      name: 'MyClass', filePath: 'src/a.ts', kind: 'class',
      graphNodeId: 'n1', memoryId: 'mem-1', status: 'enriched',
      range: { startLine: 1, endLine: 10 },
      linkedMemories: [
        { id: 'lm-1', content: 'Important class info', type: 'manual', scope: 'project' },
      ],
    },
    neighbors: [],
    edges: [],
    depth: 'disk',
    depthReached: 0,
    projectBase: { stack: 'TS', architecture: 'Test' },
    memoryContents: new Map([['mem-1', 'Enrichment']]),
    sourceCode: 'export class MyClass { run() {} }',
  });

  assert.ok(result.includes('### Semantic Memory'), 'Should have Semantic Memory section');
  assert.ok(result.includes('Important class info'), 'Should include linked memory');
  assert.ok(result.includes('### Source Code'), 'Should have Source Code section');
  assert.ok(result.includes('export class MyClass'), 'Should include source code');
});

test('withLockRetry detects SQLITE_BUSY in error message (not just code)', async () => {
  const { withLockRetry } = await import('../src/retrieval/lock-retry.mjs');

  let attempts = 0;
  const result = await withLockRetry(() => {
    attempts++;
    if (attempts === 1) {
      throw new Error('database is locked');
    }
    return 'ok';
  }, { baseDelay: 10 });

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
});

test('withLockRetry uses exponential backoff delays', async () => {
  const { withLockRetry } = await import('../src/retrieval/lock-retry.mjs');

  const timestamps = [];
  let attempts = 0;
  await withLockRetry(() => {
    attempts++;
    timestamps.push(Date.now());
    if (attempts < 3) {
      const err = new Error('SQLITE_BUSY');
      err.code = 'SQLITE_BUSY';
      throw err;
    }
    return 'done';
  }, { baseDelay: 50 });

  assert.equal(attempts, 3);
  // First retry should be ~50ms, second ~100ms
  if (timestamps.length >= 3) {
    const gap1 = timestamps[1] - timestamps[0];
    const gap2 = timestamps[2] - timestamps[1];
    assert.ok(gap1 >= 40, `First gap ${gap1}ms should be >= 40ms (base 50ms)`);
    assert.ok(gap2 >= 80, `Second gap ${gap2}ms should be >= 80ms (base 100ms)`);
  }
});

// ── Integration: real get-context path with Semantic Memory ────────────────

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { runTargetContext } from '../cli/context.mjs';

async function createSemanticFixtureProject({ symbolIndex, graph, worklist, memoryStore }) {
  const projectRoot = await mkdtemp(join(os.tmpdir(), 'pmc-sem-ctx-'));
  const pmcRoot = join(projectRoot, '.planning', 'project-memory-context');

  await mkdir(join(pmcRoot, 'graph'), { recursive: true });
  await mkdir(join(pmcRoot, 'enrichment'), { recursive: true });

  await writeFile(
    join(pmcRoot, 'install.json'),
    JSON.stringify({ installedAt: '2026-06-23T00:00:00.000Z', version: '0.1.0' }, null, 2),
    'utf8',
  );
  await writeFile(join(pmcRoot, 'graph', 'graph.json'), JSON.stringify(graph, null, 2), 'utf8');
  await writeFile(join(pmcRoot, 'enrichment', 'symbol-index.json'), JSON.stringify(symbolIndex, null, 2), 'utf8');
  await writeFile(join(pmcRoot, 'enrichment', 'worklist.json'), JSON.stringify(worklist, null, 2), 'utf8');

  return { projectRoot, memoryStore };
}

test('runTargetContext includes Semantic Memory section when memoryStore provides linked memories', async () => {
  const sk = 'ts|src/auth.ts||function|login|0';
  const linkedResults = [
    { id: 'lm-1', source: 'memory', symbolKey: sk, content: 'login handles user authentication with JWT tokens', createdAt: '2026-06-23T00:00:00.000Z' },
  ];
  const memoryStore = {
    async getBySymbol(symbolKey) {
      if (symbolKey === sk) return linkedResults;
      return [];
    },
  };

  const { projectRoot } = await createSemanticFixtureProject({
    symbolIndex: {
      [sk]: { graphNodeId: 'n1', memoryId: 'mem-1', status: 'enriched' },
    },
    graph: {
      nodes: [{ id: 'n1', label: 'login', kind: 'function', source_file: 'src/auth.ts' }],
      links: [],
    },
    worklist: [
      { symbolKey: sk, name: 'login', filePath: 'src/auth.ts', kind: 'function', range: { startLine: 1, endLine: 10 } },
    ],
    memoryStore,
  });

  try {
    const { output } = await runTargetContext({
      projectRoot,
      target: 'login',
      explicitMode: 'symbol',
      depth: 'compact',
      focus: 'all',
      memoryStore,
    });

    assert.ok(output.includes('Semantic Memory'), `output should contain Semantic Memory section:\n${output}`);
    assert.ok(output.includes('login handles user authentication'), `output should include linked memory content:\n${output}`);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('runTargetContext uses withLockRetry on memoryStore.getBySymbol', async () => {
  const sk = 'ts|src/service.ts||class|UserService|0';
  let callCount = 0;
  const memoryStore = {
    async getBySymbol(symbolKey) {
      callCount++;
      if (callCount === 1) {
        const err = new Error('SQLITE_BUSY: database is locked');
        err.code = 'SQLITE_BUSY';
        throw err;
      }
      if (symbolKey === sk) {
        return [{ id: 'lm-1', source: 'memory', symbolKey: sk, content: 'UserService manages user lifecycle', createdAt: '2026-06-23T00:00:00.000Z' }];
      }
      return [];
    },
  };

  const { projectRoot } = await createSemanticFixtureProject({
    symbolIndex: {
      [sk]: { graphNodeId: 'n1', memoryId: 'mem-1', status: 'enriched' },
    },
    graph: {
      nodes: [{ id: 'n1', label: 'UserService', kind: 'class', source_file: 'src/service.ts' }],
      links: [],
    },
    worklist: [
      { symbolKey: sk, name: 'UserService', filePath: 'src/service.ts', kind: 'class', range: { startLine: 1, endLine: 20 } },
    ],
    memoryStore,
  });

  try {
    const { output } = await runTargetContext({
      projectRoot,
      target: 'UserService',
      explicitMode: 'symbol',
      depth: 'compact',
      focus: 'all',
      memoryStore,
    });

    // Should retry and succeed on second attempt
    assert.ok(output.includes('Semantic Memory'), `should include Semantic Memory after retry:\n${output}`);
    assert.ok(output.includes('UserService manages user lifecycle'), 'should include content from retry success');
    assert.equal(callCount, 2, 'should have retried once');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

// ── Integration: REAL main() CLI path opens a real memory store ────────────
// This exercises the production entry point (main() → loadMemoryStore →
// runTargetContext) end-to-end. Unlike the runTargetContext tests above, NO
// memoryStore is injected: main() must construct one itself from the project's
// .mcp.json + memory DB. This is the test the prior corrective pass was missing.

import { DatabaseSync } from 'node:sqlite';
import { main } from '../cli/context.mjs';

async function seedSymbolLinkedMemoryDb(dbPath, { symbolKey, id, content }) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id          TEXT PRIMARY KEY,
      content     TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      symbol_key  TEXT
    );
  `);
  db.prepare('INSERT INTO memories (id, content, created_at, symbol_key) VALUES (?, ?, ?, ?)')
    .run(id, content, '2026-06-23T00:00:00.000Z', symbolKey);
  db.close();
}

test('main() renders Semantic Memory for a symbol with linked memory (real store, no injection)', async () => {
  const sk = 'ts|src/auth.ts||function|login|0';
  const { projectRoot } = await createSemanticFixtureProject({
    symbolIndex: { [sk]: { graphNodeId: 'n1', memoryId: 'mem-1', status: 'enriched' } },
    graph: {
      nodes: [{ id: 'n1', label: 'login', kind: 'function', source_file: 'src/auth.ts' }],
      links: [],
    },
    worklist: [
      { symbolKey: sk, name: 'login', filePath: 'src/auth.ts', kind: 'function', range: { startLine: 1, endLine: 10 } },
    ],
    memoryStore: null,
  });

  // Seed a real agent-memory SQLite DB and point .mcp.json at it.
  const memDbBase = join(projectRoot, '.planning', 'project-memory-context', 'memory-db');
  await seedSymbolLinkedMemoryDb(`${memDbBase}.db`, {
    symbolKey: sk,
    id: 'lm-real-1',
    content: 'login validates credentials and issues a JWT token',
  });
  await writeFile(
    join(projectRoot, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'agent-memory': { env: { MEMORY_DB_PATH: memDbBase } } } }, null, 2),
    'utf8',
  );

  const logs = [];
  const origLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };
  const origCwd = process.cwd;
  process.cwd = () => projectRoot;

  try {
    const exitCode = await main(['login']);
    const output = logs.join('\n');
    assert.equal(exitCode, 0, `main should exit 0, output:\n${output}`);
    assert.ok(output.includes('Semantic Memory'), `real main() output must contain Semantic Memory section:\n${output}`);
    assert.ok(
      output.includes('login validates credentials and issues a JWT token'),
      `real main() output must include the linked memory content:\n${output}`,
    );
  } finally {
    console.log = origLog;
    process.cwd = origCwd;
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('main() does not crash when memory DB has no symbol_key column (legacy DB)', async () => {
  const sk = 'ts|src/legacy.ts||function|legacyFn|0';
  const { projectRoot } = await createSemanticFixtureProject({
    symbolIndex: { [sk]: { graphNodeId: 'n1', memoryId: 'mem-1', status: 'enriched' } },
    graph: {
      nodes: [{ id: 'n1', label: 'legacyFn', kind: 'function', source_file: 'src/legacy.ts' }],
      links: [],
    },
    worklist: [
      { symbolKey: sk, name: 'legacyFn', filePath: 'src/legacy.ts', kind: 'function', range: { startLine: 1, endLine: 5 } },
    ],
    memoryStore: null,
  });

  // Legacy DB: memories table WITHOUT a symbol_key column (pre-v7 migration).
  const memDbBase = join(projectRoot, '.planning', 'project-memory-context', 'memory-db');
  const db = new DatabaseSync(`${memDbBase}.db`);
  db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, created_at TEXT NOT NULL);');
  db.close();
  await writeFile(
    join(projectRoot, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'agent-memory': { env: { MEMORY_DB_PATH: memDbBase } } } }, null, 2),
    'utf8',
  );

  const logs = [];
  const origLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };
  const origCwd = process.cwd;
  process.cwd = () => projectRoot;

  try {
    const exitCode = await main(['legacyFn']);
    const output = logs.join('\n');
    assert.equal(exitCode, 0, `main should exit 0 on legacy DB, output:\n${output}`);
    assert.ok(output.includes('legacyFn'), 'output should still render the symbol');
    assert.ok(!output.includes('Semantic Memory'), 'no Semantic Memory section without symbol links');
  } finally {
    console.log = origLog;
    process.cwd = origCwd;
    await rm(projectRoot, { recursive: true, force: true });
  }
});
