import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { registerQueryTools } from '../mcp/query-tools.mjs';
import { loadQueryArtifacts } from '../src/query/load-artifacts.mjs';
import { persistEnrichmentSuccess, saveSymbolIndexMerged } from '../cli/enrich-queue.mjs';

function makeSymbol(overrides = {}) {
  return {
    symbolKey: 'ts|src/auth.ts|function|exported|verifyToken|1',
    name: 'verifyToken',
    filePath: 'src/auth.ts',
    language: 'typescript',
    kind: 'function',
    codeHash: 'hash-abc',
    graphNodeId: 'node-auth-1',
    range: { startLine: 1, endLine: 15 },
    ...overrides,
  };
}

async function createOwnedProjectFixture() {
  const root = await mkdtemp(join(tmpdir(), 'pmc-semantic-summary-fixture-'));
  const pmcDir = join(root, '.planning', 'project-memory-context');
  const enrichmentDir = join(pmcDir, 'enrichment');
  const graphDir = join(pmcDir, 'graph');
  const contextDir = join(pmcDir, 'project-context');

  await mkdir(enrichmentDir, { recursive: true });
  await mkdir(graphDir, { recursive: true });
  await mkdir(contextDir, { recursive: true });

  return { root, pmcDir, enrichmentDir, graphDir, contextDir };
}

test('end-to-end: persistEnrichmentSuccess writes semanticSummary to disk symbol-index, survives merge, and is returned by pmc_search_symbols tool in-process', async () => {
  const fixture = await createOwnedProjectFixture();
  try {
    const symbol = makeSymbol();
    const worklistFile = join(fixture.enrichmentDir, 'worklist.json');
    const symbolIndexFile = join(fixture.enrichmentDir, 'symbol-index.json');
    const graphFile = join(fixture.graphDir, 'graph.json');

    const worklist = [{ ...symbol, status: 'pending' }];
    const symbolIndex = {};

    await writeFile(worklistFile, JSON.stringify(worklist, null, 2), 'utf8');
    await writeFile(symbolIndexFile, JSON.stringify(symbolIndex, null, 2), 'utf8');
    await writeFile(
      graphFile,
      JSON.stringify(
        {
          nodes: [
            {
              id: 'node-auth-1',
              label: 'verifyToken',
              metadata: {
                symbolKey: symbol.symbolKey,
                semanticSummary: 'Fallback summary in graph node',
              },
            },
          ],
          edges: [],
        },
        null,
        2,
      ),
      'utf8',
    );

    const enrichmentContent = `
## Responsibility
Validates JWT signatures and extracts user claims. Rejects expired tokens immediately.

## Primary Inputs
- token: string

## Output
Decoded payload
`;

    // 1. Run persistEnrichmentSuccess
    const { memoryId } = await persistEnrichmentSuccess({
      symbol,
      content: enrichmentContent,
      enrichedByTag: 'enriched-by-queue',
      enrichmentDir: fixture.enrichmentDir,
      worklist,
      worklistFile,
      symbolIndex,
      symbolIndexFile,
      projectSlug: 'test-project',
      attempts: [],
    });

    assert.ok(memoryId, 'memoryId must be returned');

    // 2. Read back symbol-index from disk
    const diskIndex = JSON.parse(await readFile(symbolIndexFile, 'utf8'));
    assert.equal(
      diskIndex[symbol.symbolKey]?.semanticSummary,
      'Validates JWT signatures and extracts user claims.',
      'symbol-index on disk must persist semanticSummary extracted from Responsibility',
    );

    // 3. Verify disk merge retains semanticSummary
    const memIndexForMerge = {
      [symbol.symbolKey]: {
        memoryId,
        graphNodeId: 'node-auth-1',
        codeHash: 'hash-abc',
        status: 'enriched',
        semanticSummary: 'Validates JWT signatures and extracts user claims.',
        lastEnrichedAt: new Date().toISOString(),
      },
    };
    await saveSymbolIndexMerged(symbolIndexFile, memIndexForMerge);
    const mergedDiskIndex = JSON.parse(await readFile(symbolIndexFile, 'utf8'));
    assert.equal(
      mergedDiskIndex[symbol.symbolKey]?.semanticSummary,
      'Validates JWT signatures and extracts user claims.',
      'saveSymbolIndexMerged must preserve semanticSummary',
    );

    // 4. In-process MCP tool invocation: register pmc_search_symbols and call via InMemoryTransport
    const mcpServer = new McpServer({ name: 'pmc-test-server', version: '1.0.0' });
    registerQueryTools(mcpServer, { projectRoot: fixture.root });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);

    const client = new Client({ name: 'pmc-test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    try {
      const toolResult = await client.callTool({
        name: 'pmc_search_symbols',
        arguments: { query: 'JWT signatures' },
      });

      assert.equal(toolResult.isError, undefined);
      assert.ok(Array.isArray(toolResult.content));
      assert.equal(toolResult.content[0].type, 'text');

      const matches = JSON.parse(toolResult.content[0].text);
      assert.ok(Array.isArray(matches), 'Expected matches array');
      assert.ok(matches.length > 0, 'Expected at least one matching symbol');

      const matchedSymbol = matches.find((m) => m.symbolKey === symbol.symbolKey);
      assert.ok(matchedSymbol, 'Expected symbol to be found in search results');
      assert.equal(
        matchedSymbol.semanticSummary,
        'Validates JWT signatures and extracts user claims.',
        'Registered pmc_search_symbols tool must return persisted non-empty semanticSummary',
      );
    } finally {
      await client.close();
      await mcpServer.close();
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('query artifacts graph fallback: missing or null index summary falls back to graph node metadata without masking', async () => {
  const fixture = await createOwnedProjectFixture();
  try {
    const symbolIndexFile = join(fixture.enrichmentDir, 'symbol-index.json');
    const graphFile = join(fixture.graphDir, 'graph.json');

    // Index has null semanticSummary for sym1, omitted for sym2, and non-empty for sym3
    const symbolIndex = {
      'ts|src/a.ts|function|exported|fnA|1': {
        memoryId: 'mem_a',
        graphNodeId: 'node-a',
        codeHash: 'h-a',
        status: 'enriched',
        semanticSummary: null,
      },
      'ts|src/b.ts|function|exported|fnB|1': {
        memoryId: 'mem_b',
        graphNodeId: 'node-b',
        codeHash: 'h-b',
        status: 'enriched',
      },
      'ts|src/c.ts|function|exported|fnC|1': {
        memoryId: 'mem_c',
        graphNodeId: 'node-c',
        codeHash: 'h-c',
        status: 'enriched',
        semanticSummary: 'Overriding index summary.',
      },
    };

    const graph = {
      nodes: [
        {
          id: 'node-a',
          label: 'fnA',
          metadata: {
            symbolKey: 'ts|src/a.ts|function|exported|fnA|1',
            semanticSummary: 'Graph fallback summary for A.',
          },
        },
        {
          id: 'node-b',
          label: 'fnB',
          metadata: {
            symbolKey: 'ts|src/b.ts|function|exported|fnB|1',
            semanticSummary: 'Graph fallback summary for B.',
          },
        },
        {
          id: 'node-c',
          label: 'fnC',
          metadata: {
            symbolKey: 'ts|src/c.ts|function|exported|fnC|1',
            semanticSummary: 'Graph fallback summary for C.',
          },
        },
      ],
      edges: [],
    };

    await writeFile(symbolIndexFile, JSON.stringify(symbolIndex, null, 2), 'utf8');
    await writeFile(graphFile, JSON.stringify(graph, null, 2), 'utf8');

    const artifacts = await loadQueryArtifacts(fixture.root);

    const a = artifacts.symbols.find((s) => s.symbolKey === 'ts|src/a.ts|function|exported|fnA|1');
    const b = artifacts.symbols.find((s) => s.symbolKey === 'ts|src/b.ts|function|exported|fnB|1');
    const c = artifacts.symbols.find((s) => s.symbolKey === 'ts|src/c.ts|function|exported|fnC|1');

    assert.equal(a.semanticSummary, 'Graph fallback summary for A.');
    assert.equal(b.semanticSummary, 'Graph fallback summary for B.');
    assert.equal(c.semanticSummary, 'Overriding index summary.');
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
