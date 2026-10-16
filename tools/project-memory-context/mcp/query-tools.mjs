#!/usr/bin/env node
// tools/project-memory-context/mcp/query-tools.mjs
//
// Composable PMC query tool registration. Extracts the tool definitions from
// pmc-query-server.mjs so they can be composed into a unified MCP server
// alongside agent-memory-mcp memory tools.
//
// Usage:
//   import { registerQueryTools } from './query-tools.mjs';
//   registerQueryTools(server, { projectRoot });

import { z } from 'zod';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createQueryOrchestrator } from '../src/query/orchestrator.mjs';
import { createRelationsReader } from '../src/query/relations.mjs';

function textResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(toolName, error) {
  return {
    content: [{ type: 'text', text: `${toolName} failed: ${String(error)}` }],
    isError: true,
  };
}

/**
 * Register PMC query tools on an existing McpServer instance.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {{ projectRoot?: string }} options
 */
export function registerQueryTools(server, options = {}) {
  const projectRoot = options.projectRoot || process.env.PMC_PROJECT_ROOT || process.cwd();
  const orchestrator = createQueryOrchestrator({ projectRoot });
  const reader = createRelationsReader({ projectRoot });
  const hasDb = () => existsSync(join(projectRoot, '.planning', 'project-memory-context', 'graph', 'graph.db'));

  server.tool(
    'pmc_query_project',
    'Query PMC project context and symbol artifacts using a natural-language question.',
    {
      question: z.string().describe('Natural-language project question'),
    },
    async ({ question }) => {
      try {
        return textResult(await orchestrator.query(question));
      } catch (error) {
        return errorResult('pmc_query_project', error);
      }
    },
  );

  server.tool(
    'pmc_search_symbols',
    'Search PMC symbols by semantic summary and optional file path filter.',
    {
      query: z.string().describe('Search query for symbols'),
      file: z.string().optional().describe('Optional normalized file path filter'),
    },
    async ({ query, file }) => {
      try {
        return textResult(await orchestrator.searchSymbols(query, file));
      } catch (error) {
        return errorResult('pmc_search_symbols', error);
      }
    },
  );

  server.tool(
    'pmc_get_dependents',
    'List symbols that depend on the given symbol key.',
    {
      symbol: z.string().describe('Normalized PMC symbol key'),
    },
    async ({ symbol }) => {
      try {
        const related = hasDb() ? await reader.relatedSymbols(symbol, 'in') : null;
        return textResult(related ?? await orchestrator.getDependents(symbol));
      } catch (error) {
        return errorResult('pmc_get_dependents', error);
      }
    },
  );

  server.tool(
    'pmc_get_dependencies',
    'List symbols the given symbol key depends on.',
    {
      symbol: z.string().describe('Normalized PMC symbol key'),
    },
    async ({ symbol }) => {
      try {
        const related = hasDb() ? await reader.relatedSymbols(symbol, 'out') : null;
        return textResult(related ?? await orchestrator.getDependencies(symbol));
      } catch (error) {
        return errorResult('pmc_get_dependencies', error);
      }
    },
  );

  server.registerTool('pmc_relations', {
    description: 'Read typed canonical relationships from graph.db; ambiguous targets return candidates; optional stopAtRole stops the walk at the first node with that canonical role.',
    inputSchema: z.object({
    target: z.string().min(1).describe('Canonical key, path#name, graph node ID, symbol name or file path'),
    direction: z.enum(['in', 'out', 'inbound', 'outbound']).default('out'),
    relations: z.array(z.enum(['calls', 'imports', 'imports_from', 'contains', 'method'])).optional(),
    depth: z.number().int().min(1).max(3).default(1),
    stopAtRole: z.string().min(1).optional().describe('Optional canonical role name: traversal stops expanding at the first node with this role'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async args => {
    try { return textResult(await reader.relations(args)); }
    catch (error) { return errorResult('pmc_relations', error); }
  });
  server.registerTool('pmc_card', {
    description: 'Read symbol/file facts and existing enrichment text; no role or narrative generation.',
    inputSchema: z.object({
    target: z.string().min(1).describe('Canonical key, path#name, graph node ID, symbol name or file path'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async args => {
    try { return textResult(await reader.card(args)); }
    catch (error) { return errorResult('pmc_card', error); }
  });
}
