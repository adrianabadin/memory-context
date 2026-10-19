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
  server.registerTool('pmc_entrypoints_for', {
    description: 'Which CLI commands, MCP tools, routes, or `main` functions reach X: complete reverse call reachability from the target, returning the canonical role match union plus its `entrypoints` (role entrypoint/cli-command/mcp-tool or an entrypoint layer) and `controllers` (role controller) projections with distance and evidence path.',
    inputSchema: z.object({
    target: z.string().min(1).describe('Canonical key, path#name, graph node ID, symbol name or file path'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async args => {
    try { return textResult(await reader.entrypoints(args)); }
    catch (error) { return errorResult('pmc_entrypoints_for', error); }
  });
  server.registerTool('pmc_impact', {
    description: 'Dependents, covering tests and affected roles for X, ranked by a deterministic dependency-free PageRank over the full known canonical calls/imports graph; covering tests are static import/test-path candidates, never executed coverage.',
    inputSchema: z.object({
    target: z.string().min(1).describe('Canonical key, path#name, graph node ID, symbol name or file path'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async args => {
    try { return textResult(await reader.impact(args)); }
    catch (error) { return errorResult('pmc_impact', error); }
  });
  server.registerTool('pmc_card', {
    description: 'Read symbol/file facts and existing enrichment text; no role or narrative generation. Omit `level` for the legacy facts-only payload. With `level`, returns a leveled card capped by a deterministic token ceiling (compact 2000 essentials, extended 5000 adds relation context, deep 10000 adds role evidence); ceilings are caps, never padded, and oversized lower-priority sections are dropped before essentials.',
    inputSchema: z.object({
    target: z.string().min(1).describe('Canonical key, path#name, graph node ID, symbol name or file path'),
    level: z.enum(['compact', 'extended', 'deep']).optional().describe('Optional detail level with a token ceiling; omit for the legacy facts-only output'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async args => {
    try { return textResult(await reader.card(args)); }
    catch (error) { return errorResult('pmc_card', error); }
  });
  server.registerTool('pmc_file_rollup', {
    description: 'Deterministic rollup of EXISTING accepted symbol narratives for one canonical file (S18; no model calls, no synthesis): byte-verbatim summaries in ascending canonical key order with symbolKey provenance, plus per-symbol `diagnostics` withholding missing/stale/conflicting/malformed/foreign artifacts. `target` must resolve to a canonical existing FILE — a symbol target returns an explicit not-a-file status, never a file rollup.',
    inputSchema: z.object({
    target: z.string().min(1).describe('Project-relative file path or file|<path> key; must resolve to an existing graph file'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async args => {
    try { return textResult(await reader.fileRollup(args)); }
    catch (error) { return errorResult('pmc_file_rollup', error); }
  });
  server.registerTool('pmc_community_card', {
    description: 'Community card for one graph community built ONLY from actual current community assignments (S19): the reader enumerates all known coherent file endpoints and indexed source files internally (never caller-supplied files), members are verified row-by-row with withheld collisions, the display name comes only from the stored community name (null when absent), and accepted narratives aggregate with byte-verbatim provenance plus honest `diagnostics`; no name/role guesses, no model calls.',
    inputSchema: z.object({
    communityId: z.union([z.string().min(1), z.number()]).describe('Graph community id as a string or number'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async args => {
    try { return textResult(await reader.communityCard(args)); }
    catch (error) { return errorResult('pmc_community_card', error); }
  });
  server.registerTool('pmc_feature_card', {
    description: 'Feature card from EXPLICIT caller-declared membership (S19): a feature name plus canonical symbol/file keys verified against the graph — unverifiable members are reported in `rejected` (symbol-not-in-graph, ambiguous-symbol-key, non-canonical-member-key), never guessed or inferred — and only accepted narratives aggregate with byte-verbatim provenance plus honest `diagnostics`; no persistent feature config, no model calls.',
    inputSchema: z.object({
    name: z.string().min(1).describe('Explicit feature name supplied by the consumer, reproduced verbatim'),
    members: z.array(z.string().min(1)).min(1).describe('Explicit canonical symbol keys or file|<path> keys verified against the graph'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async args => {
    try { return textResult(await reader.featureCard(args)); }
    catch (error) { return errorResult('pmc_feature_card', error); }
  });
}
