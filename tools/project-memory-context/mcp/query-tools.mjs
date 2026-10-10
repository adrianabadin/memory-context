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
import { createQueryOrchestrator } from '../src/query/orchestrator.mjs';

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
        return textResult(await orchestrator.getDependents(symbol));
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
        return textResult(await orchestrator.getDependencies(symbol));
      } catch (error) {
        return errorResult('pmc_get_dependencies', error);
      }
    },
  );
}
