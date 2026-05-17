#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'deepseek-coder-v2:16b-ctx32k';

async function generateSemanticReport(prompt) {
  const system = [
    'You analyze a single code symbol and must answer in compact structured text.',
    'Always emit these lines exactly once:',
    'responsibility: ...',
    'inputs: item1, item2',
    'output: ...',
    'dependencies: dep1, dep2',
    'role: ...',
  ].join('\n');

  const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      system,
      stream: false,
      options: {
        temperature: 0.1,
        num_ctx: 8192,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error (${response.status})`);
  }

  const data = await response.json();
  const raw = String(data.response ?? '').trim();
  return {
    summary: raw.split('\n').find((line) => line.toLowerCase().startsWith('responsibility:'))?.split(':').slice(1).join(':').trim() ?? raw,
    findings: raw.split('\n').map((line) => line.trim()).filter(Boolean),
    raw,
  };
}

const server = new McpServer({
  name: 'pmc-local-model',
  version: '0.1.0',
});

server.tool(
  'semantic_report',
  'Analyze a single symbol prompt with a local Ollama model and return a structured semantic report.',
  {
    prompt: z.string().describe('Prepared semantic prompt for a single symbol'),
  },
  async ({ prompt }) => {
    try {
      const report = await generateSemanticReport(prompt);
      return {
        content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `semantic_report failed: ${String(error)}` }],
        isError: true,
      };
    }
  },
);

await server.connect(new StdioServerTransport());
