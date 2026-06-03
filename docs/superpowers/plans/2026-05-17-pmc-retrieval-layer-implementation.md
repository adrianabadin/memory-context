# PMC Retrieval Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local query engine that lets the agent retrieve structural context (symbols, graph neighbors, call chains, impact scope) from PMC data on disk, with configurable depth levels and a /get-context command.

**Architecture:** Query engine reads graph.json + symbol-index.json + worklist.json from .planning/project-memory-context/, performs BFS graph traversal, joins with enriched .memory.json files. Context renderer produces markdown with token budget management. New /get-context command exposes retrieval to the agent. Auto-injection of base context at session start via AGENTS.md.

**Tech Stack:** Node.js (ESM), native test runner, no external dependencies.

**Spec:** `docs/superpowers/specs/2026-05-17-pmc-retrieval-layer-design.md`

---

## Task 1: Depth Config and Query Engine Factory

**Files:**
- Create: `tools/project-memory-context/src/retrieval/query-engine.mjs`
- Create: `tools/project-memory-context/tests/query-engine.test.mjs`

- [ ] **Step 1: Write failing tests for createDepthConfig and createQueryEngine factory**

```js
// tools/project-memory-context/tests/query-engine.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDepthConfig, createQueryEngine } from '../src/retrieval/query-engine.mjs';

test('createDepthConfig returns compact defaults', () => {
  const config = createDepthConfig('compact');
  assert.equal(config.maxHops, 1);
  assert.equal(config.includeCommunity, false);
  assert.equal(config.maxTokens, 2000);
  assert.equal(config.readSourceFiles, false);
});

test('createDepthConfig returns extended config', () => {
  const config = createDepthConfig('extended');
  assert.equal(config.maxHops, 2);
  assert.equal(config.includeCommunity, true);
  assert.equal(config.maxTokens, 5000);
  assert.equal(config.readSourceFiles, false);
});

test('createDepthConfig returns deep config', () => {
  const config = createDepthConfig('deep');
  assert.equal(config.maxHops, 3);
  assert.equal(config.includeCommunity, true);
  assert.equal(config.maxTokens, 10000);
  assert.equal(config.readSourceFiles, false);
});

test('createDepthConfig returns disk config with source file reading', () => {
  const config = createDepthConfig('disk');
  assert.equal(config.maxHops, 3);
  assert.equal(config.includeCommunity, true);
  assert.equal(config.maxTokens, 15000);
  assert.equal(config.readSourceFiles, true);
});

test('createDepthConfig defaults to compact for unknown depth', () => {
  const config = createDepthConfig('unknown');
  assert.equal(config.maxHops, 1);
  assert.equal(config.maxTokens, 2000);
});

test('createQueryEngine loads data and builds inverted index', () => {
  const engine = createQueryEngine({
    graph: {
      nodes: [
        { id: 'node_a', label: 'ClassA', source_file: 'src/a.ts' },
        { id: 'node_b', label: 'funcB', source_file: 'src/b.ts' },
      ],
      links: [],
    },
    symbolIndex: {
      'ts|src/a.ts|class|exported|ClassA|0': { memoryId: 'mem-1', graphNodeId: 'node_a', codeHash: 'h1', status: 'enriched', lastEnrichedAt: '2026-01-01' },
      'ts|src/b.ts|function|exported|funcB|0': { memoryId: 'mem-2', graphNodeId: 'node_b', codeHash: 'h2', status: 'enriched', lastEnrichedAt: '2026-01-01' },
    },
    worklist: [
      { symbolKey: 'ts|src/a.ts|class|exported|ClassA|0', name: 'ClassA', filePath: 'src/a.ts', kind: 'class', range: { startLine: 1, endLine: 10 } },
    ],
  });

  assert.equal(engine.graphNodeIdToSymbolKey('node_a'), 'ts|src/a.ts|class|exported|ClassA|0');
  assert.equal(engine.graphNodeIdToSymbolKey('node_b'), 'ts|src/b.ts|function|exported|funcB|0');
  assert.equal(engine.graphNodeIdToSymbolKey('node_unknown'), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tools/project-memory-context/tests/query-engine.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement createDepthConfig and createQueryEngine factory**

```js
// tools/project-memory-context/src/retrieval/query-engine.mjs
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEPTH_CONFIGS = {
  compact: { maxHops: 1, includeCommunity: false, maxTokens: 2000, readSourceFiles: false },
  extended: { maxHops: 2, includeCommunity: true, maxTokens: 5000, readSourceFiles: false },
  deep: { maxHops: 3, includeCommunity: true, maxTokens: 10000, readSourceFiles: false },
  disk: { maxHops: 3, includeCommunity: true, maxTokens: 15000, readSourceFiles: true },
};

export function createDepthConfig(depth) {
  return DEPTH_CONFIGS[depth] ?? DEPTH_CONFIGS.compact;
}

export function createQueryEngine({ graph, symbolIndex, worklist, enrichmentDir, projectSlug }) {
  const nodes = graph?.nodes ?? [];
  const links = graph?.links ?? [];
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  const graphNodeIdToSymbolKeyMap = new Map();
  for (const [symbolKey, entry] of Object.entries(symbolIndex ?? {})) {
    if (entry.graphNodeId) {
      graphNodeIdToSymbolKeyMap.set(entry.graphNodeId, symbolKey);
    }
  }

  const nameToSymbolKeys = new Map();
  for (const [symbolKey, entry] of Object.entries(symbolIndex ?? {})) {
    const parts = symbolKey.split('|');
    const name = parts[4] ?? '';
    if (!nameToSymbolKeys.has(name)) nameToSymbolKeys.set(name, []);
    nameToSymbolKeys.get(name).push(symbolKey);
  }

  const filePathToSymbolKeys = new Map();
  for (const [symbolKey, entry] of Object.entries(symbolIndex ?? {})) {
    const parts = symbolKey.split('|');
    const filePath = parts[1] ?? '';
    if (!filePathToSymbolKeys.has(filePath)) filePathToSymbolKeys.set(filePath, []);
    filePathToSymbolKeys.get(filePath).push(symbolKey);
  }

  function graphNodeIdToSymbolKey(graphNodeId) {
    return graphNodeIdToSymbolKeyMap.get(graphNodeId) ?? null;
  }

  function findSymbolKeyByName(name) {
    return nameToSymbolKeys.get(name) ?? [];
  }

  function findSymbolKeysByFilePath(filePath) {
    return filePathToSymbolKeys.get(filePath) ?? [];
  }

  return {
    graphNodeIdToSymbolKey,
    findSymbolKeyByName,
    findSymbolKeysByFilePath,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tools/project-memory-context/tests/query-engine.test.mjs`
Expected: 6 PASS

---

## Task 2: Graph Traversal (traverseGraph)

**Files:**
- Modify: `tools/project-memory-context/src/retrieval/query-engine.mjs`
- Modify: `tools/project-memory-context/tests/query-engine.test.mjs`

- [ ] **Step 1: Write failing tests for traverseGraph**

Append to `tests/query-engine.test.mjs`:

```js
test('traverseGraph performs BFS from seed nodes returning neighbors within maxHops', () => {
  const engine = createQueryEngine({
    graph: {
      nodes: [
        { id: 'a', label: 'A', source_file: 'f.ts' },
        { id: 'b', label: 'B', source_file: 'f.ts' },
        { id: 'c', label: 'C', source_file: 'f.ts' },
        { id: 'd', label: 'D', source_file: 'f.ts' },
      ],
      links: [
        { source: 'a', target: 'b', relation: 'calls' },
        { source: 'b', target: 'c', relation: 'calls' },
        { source: 'c', target: 'd', relation: 'calls' },
      ],
    },
    symbolIndex: {},
    worklist: [],
  });

  const result = engine.traverseGraph({ nodeIds: ['a'], maxHops: 1 });
  assert.deepEqual(result.nodes.map((n) => n.id).sort(), ['a', 'b']);
  assert.equal(result.depth_reached, 1);
});

test('traverseGraph respects maxHops=2 reaching 2 hops', () => {
  const engine = createQueryEngine({
    graph: {
      nodes: [
        { id: 'a', label: 'A', source_file: 'f.ts' },
        { id: 'b', label: 'B', source_file: 'f.ts' },
        { id: 'c', label: 'C', source_file: 'f.ts' },
        { id: 'd', label: 'D', source_file: 'f.ts' },
      ],
      links: [
        { source: 'a', target: 'b', relation: 'calls' },
        { source: 'b', target: 'c', relation: 'calls' },
        { source: 'c', target: 'd', relation: 'calls' },
      ],
    },
    symbolIndex: {},
    worklist: [],
  });

  const result = engine.traverseGraph({ nodeIds: ['a'], maxHops: 2 });
  assert.deepEqual(result.nodes.map((n) => n.id).sort(), ['a', 'b', 'c']);
  assert.equal(result.depth_reached, 2);
});

test('traverseGraph filters by edgeTypes', () => {
  const engine = createQueryEngine({
    graph: {
      nodes: [
        { id: 'a', label: 'A', source_file: 'f.ts' },
        { id: 'b', label: 'B', source_file: 'f.ts' },
        { id: 'c', label: 'C', source_file: 'f.ts' },
      ],
      links: [
        { source: 'a', target: 'b', relation: 'calls' },
        { source: 'a', target: 'c', relation: 'imports' },
      ],
    },
    symbolIndex: {},
    worklist: [],
  });

  const result = engine.traverseGraph({ nodeIds: ['a'], maxHops: 1, edgeTypes: ['calls'] });
  assert.deepEqual(result.nodes.map((n) => n.id).sort(), ['a', 'b']);
});

test('traverseGraph traverses inbound edges when direction is inbound', () => {
  const engine = createQueryEngine({
    graph: {
      nodes: [
        { id: 'a', label: 'A', source_file: 'f.ts' },
        { id: 'b', label: 'B', source_file: 'f.ts' },
        { id: 'c', label: 'C', source_file: 'f.ts' },
      ],
      links: [
        { source: 'b', target: 'a', relation: 'calls' },
        { source: 'c', target: 'a', relation: 'calls' },
      ],
    },
    symbolIndex: {},
    worklist: [],
  });

  const result = engine.traverseGraph({ nodeIds: ['a'], maxHops: 1, direction: 'inbound' });
  assert.deepEqual(result.nodes.map((n) => n.id).sort(), ['a', 'b', 'c']);
});

test('traverseGraph returns empty for unknown seed nodes', () => {
  const engine = createQueryEngine({
    graph: { nodes: [], links: [] },
    symbolIndex: {},
    worklist: [],
  });

  const result = engine.traverseGraph({ nodeIds: ['nonexistent'], maxHops: 3 });
  assert.deepEqual(result.nodes, []);
  assert.equal(result.depth_reached, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tools/project-memory-context/tests/query-engine.test.mjs`
Expected: New tests FAIL — traverseGraph not a function

- [ ] **Step 3: Implement traverseGraph in query-engine.mjs**

Add inside the `createQueryEngine` function body, before the return statement:

```js
  function traverseGraph({ nodeIds, maxHops, edgeTypes = ['calls', 'imports', 'imports_from', 'contains', 'method'], direction = 'outbound' }) {
    const edgeTypeSet = new Set(edgeTypes);
    const visited = new Set();
    const reachedNodes = [];
    const reachedEdges = [];
    let frontier = [...(nodeIds ?? [])];

    for (const id of frontier) {
      visited.add(id);
      const node = nodeMap.get(id);
      if (node) reachedNodes.push(node);
    }

    for (let hop = 0; hop < maxHops; hop++) {
      const nextFrontier = [];
      for (const nodeId of frontier) {
        for (const link of links) {
          if (!edgeTypeSet.has(link.relation)) continue;

          const neighborId = direction === 'inbound' ? link.source : link.target;
          const selfId = direction === 'inbound' ? link.target : link.source;

          if (selfId !== nodeId || visited.has(neighborId)) continue;

          visited.add(neighborId);
          const neighborNode = nodeMap.get(neighborId);
          if (neighborNode) reachedNodes.push(neighborNode);
          reachedEdges.push(link);
          nextFrontier.push(neighborId);
        }
      }

      if (nextFrontier.length === 0) break;
      frontier = nextFrontier;
    }

    return { nodes: reachedNodes, edges: reachedEdges, depth_reached: Math.min(maxHops, frontier.length === 0 && reachedNodes.length <= nodeIds.length ? 0 : maxHops) };
  }
```

Add `traverseGraph` to the return object:

```js
  return {
    graphNodeIdToSymbolKey,
    findSymbolKeyByName,
    findSymbolKeysByFilePath,
    traverseGraph,
  };
```

- [ ] **Step 4: Fix depth_reached calculation to be accurate**

Replace the `depth_reached` line in traverseGraph with:

```js
    let actualDepth = 0;
    const visitedDepth = new Set();
    for (const id of nodeIds ?? []) visitedDepth.add(id);

    for (let hop = 0; hop < maxHops; hop++) {
      const nextFrontier = [];
      for (const nodeId of frontier) {
        for (const link of links) {
          if (!edgeTypeSet.has(link.relation)) continue;
          const neighborId = direction === 'inbound' ? link.source : link.target;
          const selfId = direction === 'inbound' ? link.target : link.source;
          if (selfId !== nodeId || visited.has(neighborId)) continue;
          visited.add(neighborId);
          const neighborNode = nodeMap.get(neighborId);
          if (neighborNode) reachedNodes.push(neighborNode);
          reachedEdges.push(link);
          nextFrontier.push(neighborId);
        }
      }
      if (nextFrontier.length === 0) break;
      actualDepth = hop + 1;
      frontier = nextFrontier;
    }

    return { nodes: reachedNodes, edges: reachedEdges, depth_reached: actualDepth };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tools/project-memory-context/tests/query-engine.test.mjs`
Expected: All 11 PASS

---

## Task 3: High-Level Query Functions (querySymbolContext, queryFileContext, queryImpactScope)

**Files:**
- Modify: `tools/project-memory-context/src/retrieval/query-engine.mjs`
- Modify: `tools/project-memory-context/tests/query-engine.test.mjs`

- [ ] **Step 1: Write failing tests for querySymbolContext**

Append to tests:

```js
test('querySymbolContext returns enrichment and structural neighbors for a symbol', async () => {
  const engine = createQueryEngine({
    graph: {
      nodes: [
        { id: 'n_class', label: 'MyClass', source_file: 'src/mod.ts' },
        { id: 'n_method', label: '.run()', source_file: 'src/mod.ts' },
        { id: 'n_import', label: 'helper', source_file: 'src/helper.ts' },
      ],
      links: [
        { source: 'n_class', target: 'n_method', relation: 'method' },
        { source: 'n_class', target: 'n_import', relation: 'imports' },
      ],
    },
    symbolIndex: {
      'ts|src/mod.ts|class|exported|MyClass|0': { memoryId: 'mem-1', graphNodeId: 'n_class', codeHash: 'h1', status: 'enriched', lastEnrichedAt: '2026-01-01' },
      'ts|src/mod.ts|method|MyClass|run|0': { memoryId: 'mem-2', graphNodeId: 'n_method', codeHash: 'h2', status: 'enriched', lastEnrichedAt: '2026-01-01' },
      'ts|src/helper.ts|function|exported|helper|0': { memoryId: 'mem-3', graphNodeId: 'n_import', codeHash: 'h3', status: 'enriched', lastEnrichedAt: '2026-01-01' },
    },
    worklist: [
      { symbolKey: 'ts|src/mod.ts|class|exported|MyClass|0', name: 'MyClass', filePath: 'src/mod.ts', kind: 'class', range: { startLine: 1, endLine: 20 } },
      { symbolKey: 'ts|src/mod.ts|method|MyClass|run|0', name: 'run', filePath: 'src/mod.ts', kind: 'method', range: { startLine: 5, endLine: 10 } },
      { symbolKey: 'ts|src/helper.ts|function|exported|helper|0', name: 'helper', filePath: 'src/helper.ts', kind: 'function', range: { startLine: 1, endLine: 5 } },
    ],
    enrichmentDir: null,
  });

  const result = engine.querySymbolContext({
    symbolKey: 'ts|src/mod.ts|class|exported|MyClass|0',
    depth: 'compact',
    readMemoryContent: async () => ({ content: 'MyClass is the main class', category: 'architecture', tags: ['symbol'] }),
  });

  assert.equal(result.target.symbolKey, 'ts|src/mod.ts|class|exported|MyClass|0');
  assert.equal(result.target.graphNodeId, 'n_class');
  assert.ok(result.neighbors.length >= 1);
  assert.ok(result.neighbors.some((n) => n.graphNodeId === 'n_method'));
  assert.ok(result.neighbors.some((n) => n.graphNodeId === 'n_import'));
});

test('queryFileContext returns all symbols in a file with neighbors', () => {
  const engine = createQueryEngine({
    graph: {
      nodes: [
        { id: 'n_class', label: 'MyClass', source_file: 'src/mod.ts' },
        { id: 'n_method', label: '.run()', source_file: 'src/mod.ts' },
        { id: 'n_other', label: 'OtherClass', source_file: 'src/other.ts' },
      ],
      links: [
        { source: 'n_class', target: 'n_method', relation: 'method' },
        { source: 'n_other', target: 'n_class', relation: 'imports' },
      ],
    },
    symbolIndex: {
      'ts|src/mod.ts|class|exported|MyClass|0': { memoryId: 'mem-1', graphNodeId: 'n_class', codeHash: 'h1', status: 'enriched', lastEnrichedAt: '2026-01-01' },
      'ts|src/mod.ts|method|MyClass|run|0': { memoryId: 'mem-2', graphNodeId: 'n_method', codeHash: 'h2', status: 'enriched', lastEnrichedAt: '2026-01-01' },
    },
    worklist: [
      { symbolKey: 'ts|src/mod.ts|class|exported|MyClass|0', name: 'MyClass', filePath: 'src/mod.ts', kind: 'class', range: { startLine: 1, endLine: 20 } },
      { symbolKey: 'ts|src/mod.ts|method|MyClass|run|0', name: 'run', filePath: 'src/mod.ts', kind: 'method', range: { startLine: 5, endLine: 10 } },
    ],
    enrichmentDir: null,
  });

  const result = engine.queryFileContext({ filePath: 'src/mod.ts', depth: 'compact' });
  assert.equal(result.symbols.length, 2);
  assert.ok(result.symbols.some((s) => s.name === 'MyClass'));
  assert.ok(result.symbols.some((s) => s.name === 'run'));
  assert.ok(result.neighbors.length >= 1);
});

test('queryImpactScope returns inbound dependents', () => {
  const engine = createQueryEngine({
    graph: {
      nodes: [
        { id: 'n_target', label: 'target', source_file: 'src/a.ts' },
        { id: 'n_caller1', label: 'caller1', source_file: 'src/b.ts' },
        { id: 'n_caller2', label: 'caller2', source_file: 'src/c.ts' },
      ],
      links: [
        { source: 'n_caller1', target: 'n_target', relation: 'calls' },
        { source: 'n_caller2', target: 'n_target', relation: 'imports' },
      ],
    },
    symbolIndex: {
      'ts|src/a.ts|function|exported|target|0': { memoryId: 'mem-1', graphNodeId: 'n_target', codeHash: 'h1', status: 'enriched', lastEnrichedAt: '2026-01-01' },
      'ts|src/b.ts|function|exported|caller1|0': { memoryId: 'mem-2', graphNodeId: 'n_caller1', codeHash: 'h2', status: 'enriched', lastEnrichedAt: '2026-01-01' },
      'ts|src/c.ts|function|exported|caller2|0': { memoryId: 'mem-3', graphNodeId: 'n_caller2', codeHash: 'h3', status: 'enriched', lastEnrichedAt: '2026-01-01' },
    },
    worklist: [],
    enrichmentDir: null,
  });

  const result = engine.queryImpactScope({
    symbolKeys: ['ts|src/a.ts|function|exported|target|0'],
    depth: 'compact',
  });
  assert.equal(result.target.symbolKey, 'ts|src/a.ts|function|exported|target|0');
  assert.equal(result.dependents.length, 2);
  assert.ok(result.dependents.some((d) => d.graphNodeId === 'n_caller1'));
  assert.ok(result.dependents.some((d) => d.graphNodeId === 'n_caller2'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tools/project-memory-context/tests/query-engine.test.mjs`
Expected: New tests FAIL — methods not on return object

- [ ] **Step 3: Implement querySymbolContext, queryFileContext, queryImpactScope**

Add these three functions inside `createQueryEngine`, before the return:

```js
  function resolveWorklistEntry(symbolKey) {
    return (worklist ?? []).find((e) => e.symbolKey === symbolKey) ?? null;
  }

  function buildSymbolInfo(symbolKey) {
    const indexEntry = (symbolIndex ?? {})[symbolKey];
    const wlEntry = resolveWorklistEntry(symbolKey);
    return {
      symbolKey,
      name: wlEntry?.name ?? symbolKey.split('|')[4] ?? '',
      filePath: wlEntry?.filePath ?? symbolKey.split('|')[1] ?? '',
      kind: wlEntry?.kind ?? symbolKey.split('|')[2] ?? '',
      range: wlEntry?.range ?? null,
      graphNodeId: indexEntry?.graphNodeId ?? null,
      memoryId: indexEntry?.memoryId ?? null,
      status: indexEntry?.status ?? 'unknown',
    };
  }

  function querySymbolContext({ symbolKey, depth, readMemoryContent }) {
    const config = createDepthConfig(depth);
    const target = buildSymbolInfo(symbolKey);
    const seedNodeIds = target.graphNodeId ? [target.graphNodeId] : [];
    const traversal = seedNodeIds.length > 0
      ? traverseGraph({ nodeIds: seedNodeIds, maxHops: config.maxHops })
      : { nodes: [], edges: [], depth_reached: 0 };

    const neighbors = traversal.nodes
      .filter((n) => n.id !== target.graphNodeId)
      .map((n) => {
        const sk = graphNodeIdToSymbolKey(n.id);
        return sk ? buildSymbolInfo(sk) : { graphNodeId: n.id, label: n.label, sourceFile: n.source_file ?? null, symbolKey: null };
      });

    return { target, neighbors, edges: traversal.edges, depth_reached: traversal.depth_reached };
  }

  function queryFileContext({ filePath, depth }) {
    const config = createDepthConfig(depth);
    const fileSymbolKeys = findSymbolKeysByFilePath(filePath);
    const symbols = fileSymbolKeys.map(buildSymbolInfo);

    const fileNodeIds = (nodes ?? [])
      .filter((n) => n.source_file === filePath)
      .map((n) => n.id);

    const traversal = fileNodeIds.length > 0
      ? traverseGraph({ nodeIds: fileNodeIds, maxHops: config.maxHops })
      : { nodes: [], edges: [], depth_reached: 0 };

    const fileNodeSet = new Set(fileNodeIds);
    const neighbors = traversal.nodes
      .filter((n) => !fileNodeSet.has(n.id))
      .map((n) => {
        const sk = graphNodeIdToSymbolKey(n.id);
        return sk ? buildSymbolInfo(sk) : { graphNodeId: n.id, label: n.label, sourceFile: n.source_file ?? null, symbolKey: null };
      });

    return { symbols, neighbors, edges: traversal.edges, depth_reached: traversal.depth_reached };
  }

  function queryImpactScope({ symbolKeys, depth }) {
    const config = createDepthConfig(depth);
    const targets = symbolKeys.map(buildSymbolInfo);
    const targetNodeIds = targets.map((t) => t.graphNodeId).filter(Boolean);

    const traversal = targetNodeIds.length > 0
      ? traverseGraph({ nodeIds: targetNodeIds, maxHops: config.maxHops, direction: 'inbound' })
      : { nodes: [], edges: [], depth_reached: 0 };

    const targetNodeSet = new Set(targetNodeIds);
    const dependents = traversal.nodes
      .filter((n) => !targetNodeSet.has(n.id))
      .map((n) => {
        const sk = graphNodeIdToSymbolKey(n.id);
        return sk ? buildSymbolInfo(sk) : { graphNodeId: n.id, label: n.label, sourceFile: n.source_file ?? null, symbolKey: null };
      });

    return {
      target: targets.length === 1 ? targets[0] : targets,
      dependents,
      edges: traversal.edges,
      depth_reached: traversal.depth_reached,
    };
  }
```

Add all three to the return object:

```js
  return {
    graphNodeIdToSymbolKey,
    findSymbolKeyByName,
    findSymbolKeysByFilePath,
    traverseGraph,
    querySymbolContext,
    queryFileContext,
    queryImpactScope,
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tools/project-memory-context/tests/query-engine.test.mjs`
Expected: All 14 PASS

---

## Task 4: Focus Parameter Edge Type Mapping

**Files:**
- Modify: `tools/project-memory-context/src/retrieval/query-engine.mjs`
- Modify: `tools/project-memory-context/tests/query-engine.test.mjs`

- [ ] **Step 1: Write failing test for focusToEdgeTypes**

```js
test('focusToEdgeTypes maps focus keywords to edge types', () => {
  const { focusToEdgeTypes } = await import('../src/retrieval/query-engine.mjs');
  assert.deepEqual(focusToEdgeTypes('dependencies'), ['imports', 'imports_from']);
  assert.deepEqual(focusToEdgeTypes('callers'), ['calls']);
  assert.deepEqual(focusToEdgeTypes('containment'), ['contains', 'method']);
  assert.deepEqual(focusToEdgeTypes('all'), ['calls', 'imports', 'imports_from', 'contains', 'method']);
});
```

Note: use top-level await or restructure as `test('...', async () => { ... })`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tools/project-memory-context/tests/query-engine.test.mjs`
Expected: FAIL — focusToEdgeTypes not exported

- [ ] **Step 3: Implement focusToEdgeTypes**

Add to `query-engine.mjs`:

```js
export function focusToEdgeTypes(focus) {
  const map = {
    dependencies: ['imports', 'imports_from'],
    callers: ['calls'],
    containment: ['contains', 'method'],
  };
  return map[focus] ?? ['calls', 'imports', 'imports_from', 'contains', 'method'];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tools/project-memory-context/tests/query-engine.test.mjs`
Expected: All 15 PASS

---

## Task 5: Context Renderer

**Files:**
- Create: `tools/project-memory-context/src/retrieval/context-renderer.mjs`
- Create: `tools/project-memory-context/tests/context-renderer.test.mjs`

- [ ] **Step 1: Write failing tests for context renderer**

```js
// tools/project-memory-context/tests/context-renderer.test.mjs
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tools/project-memory-context/tests/context-renderer.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Implement renderContext**

```js
// tools/project-memory-context/src/retrieval/context-renderer.mjs
import { createDepthConfig } from './query-engine.mjs';

export function renderContext({ target, neighbors, edges, depth, depthReached, projectBase, memoryContents, sourceCode }) {
  const config = createDepthConfig(depth);
  const maxChars = config.maxTokens * 4;
  const sections = [];

  sections.push(renderProjectBase(projectBase));
  sections.push(renderTarget(target, memoryContents));

  if (neighbors.length > 0) {
    sections.push(renderNeighbors(neighbors, edges, memoryContents));
  }

  if (config.includeCommunity && neighbors.length > 0) {
    sections.push(renderCommunityInfo(neighbors));
  }

  if (depth === 'deep' || depth === 'disk') {
    sections.push(renderImpactInfo(target, neighbors, edges));
  }

  if (sourceCode && config.readSourceFiles) {
    sections.push(renderSourceCode(target, sourceCode));
  }

  let output = sections.filter(Boolean).join('\n\n');
  if (output.length > maxChars) {
    output = output.slice(0, maxChars);
  }

  return output;
}

function renderProjectBase(base) {
  if (!base) return '';
  return `## Project Base\nStack: ${base.stack ?? 'unknown'} | Architecture: ${base.architecture ?? 'unknown'}`;
}

function renderTarget(target, memoryContents) {
  const enrichment = memoryContents?.get(target.memoryId) ?? '(no enrichment available)';
  const location = target.filePath ? `${target.filePath}` : 'unknown location';
  return `### Target: ${target.name} (${target.kind})\nFile: ${location}\n${enrichment}`;
}

function renderNeighbors(neighbors, edges, memoryContents) {
  const lines = ['### Structural Neighbors'];
  for (const n of neighbors) {
    const enrichment = memoryContents?.get(n.memoryId);
    const edge = edges.find((e) => e.target === n.graphNodeId || e.source === n.graphNodeId);
    const rel = edge ? ` [${edge.relation}]` : '';
    const desc = enrichment ? ` — ${enrichment.split('\n')[0]}` : '';
    lines.push(`- \`${n.name ?? n.label ?? 'unknown'}\` (${n.kind ?? '?'})${rel}${desc}`);
  }
  return lines.join('\n');
}

function renderCommunityInfo(neighbors) {
  const communities = new Map();
  for (const n of neighbors) {
    const c = n.community ?? 'unknown';
    if (!communities.has(c)) communities.set(c, []);
    communities.get(c).push(n);
  }
  if (communities.size === 0) return '';
  const lines = ['### Module Communities'];
  for (const [id, members] of communities) {
    lines.push(`- Community ${id}: ${members.map((m) => m.name ?? m.label ?? '?').join(', ')}`);
  }
  return lines.join('\n');
}

function renderImpactInfo(target, neighbors, edges) {
  const inboundEdges = edges.filter((e) => e.target === target.graphNodeId);
  if (inboundEdges.length === 0) return '';
  const lines = ['### Impact Scope'];
  for (const e of inboundEdges) {
    const caller = neighbors.find((n) => n.graphNodeId === e.source);
    lines.push(`- \`${caller?.name ?? e.source}\` depends on this (${e.relation})`);
  }
  return lines.join('\n');
}

function renderSourceCode(target, sourceCode) {
  const range = target.range ? ` (lines ${target.range.startLine}-${target.range.endLine})` : '';
  return `### Source Code\n// ${target.filePath ?? 'unknown'}${range}\n${sourceCode}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tools/project-memory-context/tests/context-renderer.test.mjs`
Expected: 3 PASS

---

## Task 6: `/get-context` Command

**Files:**
- Create: `~/.config/opencode/commands/get-context.md`

- [ ] **Step 1: Write the command file**

```markdown
---
description: Retrieve structural context from PMC for a target (file, symbol, or description). Reduces need to read source files directly.
arguments:
  - name: target
    description: "File path, symbol name, or free-text description"
    required: true
  - name: depth
    description: "compact (default) | extended | deep | disk"
    required: false
  - name: focus
    description: "all (default) | dependencies | callers | containment"
    required: false
---

# /get-context — Structural Context Retrieval

You are retrieving pre-computed structural context from PMC (Project Memory Context) to understand the codebase before making changes.

## Instructions

Given `target=$ARGUMENTS`, follow these steps:

### 1. Resolve Target

- If target contains `/` or `\\` → treat as file path
- If target is a CamelCase or camelCase identifier → treat as symbol name
- Otherwise → treat as free-text description

### 2. Load PMC Data

Read these files from `.planning/project-memory-context/`:
- `graph/graph.json` — structural graph (nodes + edges)
- `enrichment/symbol-index.json` — enriched symbols with graphNodeId links
- `enrichment/worklist.json` — symbol metadata (name, kind, filePath, range)

### 3. Build Query Engine

Use `tools/project-memory-context/src/retrieval/query-engine.mjs`:

```
createQueryEngine({ graph, symbolIndex, worklist })
```

### 4. Execute Query

- **File target**: `engine.queryFileContext({ filePath, depth })`
- **Symbol target**: `engine.querySymbolContext({ symbolKey, depth })`
  - Find symbolKey by searching worklist entries where `name` matches target
- **Free text**: `agent-memory_search` with query=target, then extract symbolKeys from results

Apply `focus` filter using `focusToEdgeTypes(focus)` to constrain edge types in traversal.

### 5. Load Enrichment Content

For each symbol with a `memoryId`, read the corresponding `.memory.json` file from `.planning/project-memory-context/enrichment/`.

### 6. Fetch Project Base Context

Call `agent-memory_search` with `tags: ["project-context"]` to get the 9 base memories (stack, architecture, structure, etc.).

### 7. Render Context

Use `renderContext()` from `tools/project-memory-context/src/retrieval/context-renderer.mjs` to produce structured markdown.

### 8. For depth=disk

Additionally read source files directly using the `range` fields from worklist entries.

### Rules

- Do NOT read source files unless `depth=disk` or you have exhausted the available enrichment context.
- If PMC data is missing, inform the user: "PMC not initialized. Run `/new-project` first."
- If target is ambiguous (multiple matches), list candidates and ask for clarification.
- Always present the context before making any code changes.
```

- [ ] **Step 2: Verify file exists and is well-formed**

Run: `type "%USERPROFILE%\.config\opencode\commands\get-context.md"`
Expected: File contents displayed

---

## Task 7: Auto-Injection Enhancement in AGENTS.md

**Files:**
- Modify: `~/.config/opencode/AGENTS.md`

- [ ] **Step 1: Read current AGENTS.md**

Read: `~/.config/opencode/AGENTS.md`

- [ ] **Step 2: Add auto-injection to pmc-autostart block**

Add after step 5 (sync-manifest check), before the "Do NOT block" line:

```
6. If `.planning/project-memory-context/` exists, call `agent-memory_search` with `query: "project context overview"` and `tags: ["project-context"]` to fetch base context (stack, architecture, structure). Present a brief summary (~500 tokens) to establish session context.
7. Remind the user: "Use `/get-context <target>` for structural deep-dive before reading files."
```

Renumber the existing "Do NOT block" line to step 8.

- [ ] **Step 3: Verify AGENTS.md is valid**

Read the file and confirm the pmc-autostart block has steps 1-8 with the new auto-injection.

---

## Task 8: Run Full Test Suite

**Files:** None (verification only)

- [ ] **Step 1: Run PMC tests**

Run: `node --test tools/project-memory-context/tests/*.test.mjs`
Expected: All tests pass (106 previous + ~15 new = ~121)

- [ ] **Step 2: Run agent-memory tests**

Run: `cd agent-memory-mcp && npm test`
Expected: 89 PASS, 0 FAIL

- [ ] **Step 3: Verify new-project sync includes retrieval/**

Run: `node -e "import {readdirSync} from 'fs'; import {resolve} from 'path'; const src=resolve('tools/project-memory-context/src/retrieval'); try{console.log(readdirSync(src))}catch(e){console.log('dir not found')}"`
Expected: Shows `['query-engine.mjs', 'context-renderer.mjs']` — `copyTree` in `new-project.mjs` already copies all `.mjs` files recursively under `src/`, so retrieval/ is included automatically.
