#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getPackageVersion } from '../src/package-version.mjs';
import { registerQueryTools } from './query-tools.mjs';

const projectRoot = process.env.PMC_PROJECT_ROOT || process.cwd();
const server = new McpServer({ name: 'pmc-query', version: getPackageVersion() });
registerQueryTools(server, { projectRoot });
await server.connect(new StdioServerTransport());
