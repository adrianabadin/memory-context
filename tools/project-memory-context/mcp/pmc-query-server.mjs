#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { createQueryOrchestrator } from '../src/query/orchestrator.mjs';

const projectRoot = process.env.PMC_PROJECT_ROOT || process.cwd();
const orchestrator = createQueryOrchestrator({ projectRoot });

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

const server = new McpServer({
  name: 'pmc-query',
  version: '0.1.5',
});

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

await server.connect(new StdioServerTransport());
