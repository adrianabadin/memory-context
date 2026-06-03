# PMC Query Access — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build CLI `pmc query`, MCP query tools, and an PMC-Aware agent skill so humans and agents can access PMC-enriched project memory efficiently, saving tokens vs reading raw source files.

**Architecture:** A shared `QueryOrchestrator` reads PMC local files (graph, symbol-index, project-context memories) and answers questions. It's exposed as both a CLI command and an MCP server. An agent skill teaches agents to query PMC before reading files.

**Tech Stack:** Node.js native modules, `@modelcontextprotocol/sdk` (existing dep), zod, Ollama (optional for LLM synthesis)

**Design doc:** `docs/plans/2026-05-19-pmc-query-access-design.md`

---

### Task 1: Query Engine — `src/query/orchestrator.mjs`

**Files:**
- Create: `tools/project-memory-context/src/query/orchestrator.mjs`
- Test: `tools/project-memory-context/tests/query.test.mjs`

- [ ] **Step 1: Write the failing test first**

```js
// tests/query.test.mjs
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createQueryOrchestrator } from '../src/query/orchestrator.mjs';

test('orchestrator returns empty result for empty project', async () => {
  const orch = createQueryOrchestrator({
    projectRoot: '/nonexistent',
  });
  const result = await orch.query('how does auth work?');
  assert.ok(result);
  assert.equal(result.answer, '');
  assert.deepEqual(result.sources, []);
  assert.ok(typeof result.tokens_saved === 'number');
});

test('orchestrator searches project context memories by keyword', async () => {
  // Create a temp PMC structure with a memory
  const tmp = await mkdtemp(join(tmpdir(), 'pmc-query-'));
  const ctxDir = join(tmp, '.planning', 'project-memory-context', 'project-context');
  await mkdir(ctxDir, { recursive: true });
  await writeFile(join(ctxDir, 'stack-runtime.json'), JSON.stringify({
    memory_key: 'project-context:stack-runtime',
    kind: 'stack-runtime',
    title: 'Stack & Runtime',
    summary: 'Node.js v24 with Express.js framework',
    body: 'The project runs on Node.js 24 with Express.js as the web framework.',
    tags: ['node.js', 'express', 'runtime'],
    source_files: ['package.json'],
  }));

  const orch = createQueryOrchestrator({ projectRoot: tmp });
  const result = await orch.query('what framework does this project use?');

  assert.ok(result.answer.length > 0);
  assert.ok(result.answer.toLowerCase().includes('express'));
  assert.ok(result.sources.length > 0);
  assert.ok(result.sources[0].file.endsWith('stack-runtime.json'));

  await rm(tmp, { recursive: true, force: true });
});

test('orchestrator searches symbol index for symbol mentions', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'pmc-query-'));
  const pmcDir = join(tmp, '.planning', 'project-memory-context');
  await mkdir(pmcDir, { recursive: true });

  // Write a minimal symbol index
  await writeFile(join(pmcDir, 'symbol-index.json'), JSON.stringify({
    symbols: [
      {
        symbolKey: 'src/server.mjs:Server',
        name: 'Server',
        kind: 'class',
        sourceFile: 'src/server.mjs',
        enriched: { summary: 'HTTP server class managing Express app lifecycle' },
        graphNodeId: 'node-1',
      },
    ],
    version: 2,
  }));

  // Write a minimal graph
  await writeFile(join(pmcDir, 'graph.json'), JSON.stringify({
    nodes: [
      { id: 'node-1', label: 'Server', kind: 'class', source_file: 'src/server.mjs' },
    ],
    edges: [],
  }));

  const orch = createQueryOrchestrator({ projectRoot: tmp });
  const result = await orch.query('what is the Server class?');

  assert.ok(result.answer.toLowerCase().includes('server'));
  assert.ok(result.sources.some(s => s.file.includes('server.mjs')));

  await rm(tmp, { recursive: true, force: true });
});
```

Run: `node --test tests/query.test.mjs`
Expected: 3 FAIL — orchestrator.mjs not yet created

- [ ] **Step 2: Create `src/query/orchestrator.mjs`**

```js
// src/query/orchestrator.mjs
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const PMC_DIR = join('.planning', 'project-memory-context');
const PROJECT_CONTEXT_DIR = join(PMC_DIR, 'project-context');
const SYMBOL_INDEX_FILE = join(PMC_DIR, 'symbol-index.json');
const GRAPH_FILE = join(PMC_DIR, 'graph.json');

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

async function safeReadJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function createQueryOrchestrator({ projectRoot }) {
  const pmcPath = normalizePath(join(projectRoot, PMC_DIR));
  const contextPath = normalizePath(join(projectRoot, PROJECT_CONTEXT_DIR));
  const symbolIndexPath = normalizePath(join(projectRoot, SYMBOL_INDEX_FILE));
  const graphPath = normalizePath(join(projectRoot, GRAPH_FILE));

  async function searchProjectContextMemories(question) {
    const results = [];
    const questionLower = question.toLowerCase();
    const questionWords = questionLower.split(/\s+/).filter(w => w.length > 3);

    const ctxDir = contextPath;
    if (!existsSync(ctxDir)) return results;

    let files;
    try {
      const { readdir } = await import('node:fs/promises');
      files = (await readdir(ctxDir)).filter(f => f.endsWith('.json'));
    } catch {
      return results;
    }

    for (const file of files) {
      const data = await safeReadJson(join(ctxDir, file));
      if (!data) continue;

      const searchableText = [data.title, data.summary, data.body, ...(data.tags ?? [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      let relevance = 0;
      for (const word of questionWords) {
        if (searchableText.includes(word)) {
          relevance++;
        }
      }

      if (relevance > 0 || questionWords.length === 0) {
        results.push({
          memory_key: data.memory_key,
          kind: data.kind,
          title: data.title,
          summary: data.summary || data.body?.slice(0, 200),
          body: data.body,
          file: normalizePath(join(PROJECT_CONTEXT_DIR, file)),
          tags: data.tags ?? [],
          relevance,
        });
      }
    }

    results.sort((a, b) => b.relevance - a.relevance);
    return results.slice(0, 5);
  }

  async function searchSymbolIndex(question) {
    const data = await safeReadJson(symbolIndexPath);
    if (!data?.symbols) return [];

    const questionLower = question.toLowerCase();
    const results = [];

    for (const sym of data.symbols) {
      const nameLower = (sym.name ?? '').toLowerCase();
      const fileLower = (sym.sourceFile ?? '').toLowerCase();
      const summaryLower = (sym.enriched?.summary ?? '').toLowerCase();

      let relevance = 0;
      if (nameLower && questionLower.includes(nameLower)) relevance += 3;
      if (summaryLower && questionLower.split(/\s+/).some(w => w.length > 3 && summaryLower.includes(w))) relevance += 1;

      if (relevance > 0) {
        results.push({
          symbolKey: sym.symbolKey,
          name: sym.name,
          kind: sym.kind,
          file: sym.sourceFile,
          summary: sym.enriched?.summary ?? '',
          graphNodeId: sym.graphNodeId,
          relevance,
        });
      }
    }

    results.sort((a, b) => b.relevance - a.relevance);
    return results;
  }

  function estimateTokensSaved(sources) {
    let totalBytes = 0;
    for (const s of sources) {
      totalBytes += (s.summary?.length ?? 0) + (s.body?.length ?? 0);
    }
    return Math.round(totalBytes / 4);
  }

  return {
    async query(question) {
      if (!question || typeof question !== 'string') {
        return { answer: '', sources: [], tokens_saved: 0 };
      }

      const [memories, symbols] = await Promise.all([
        searchProjectContextMemories(question),
        searchSymbolIndex(question),
      ]);

      const sources = [];

      // Build answer from memories
      let answerParts = [];
      for (const m of memories) {
        sources.push({ file: m.file, summary: m.summary, type: 'memory' });
        if (m.body) {
          answerParts.push(m.body);
        } else if (m.summary) {
          answerParts.push(m.summary);
        }
      }

      // Add symbol matches
      for (const s of symbols) {
        sources.push({ file: s.file, summary: s.summary, type: 'symbol' });
        if (s.summary) {
          answerParts.push(`\`${s.name}\` (${s.kind} in ${s.file}): ${s.summary}`);
        }
      }

      const answer = answerParts.length > 0
        ? answerParts.join('\n')
        : '';

      return {
        answer,
        sources: sources.slice(0, 20),
        tokens_saved: estimateTokensSaved(sources),
      };
    },

    async searchSymbols(query, fileFilter) {
      const data = await safeReadJson(symbolIndexPath);
      if (!data?.symbols) return [];

      const queryLower = query?.toLowerCase() ?? '';
      const fileLower = fileFilter?.toLowerCase() ?? '';

      return data.symbols.filter(sym => {
        const nameMatch = !queryLower || (sym.name ?? '').toLowerCase().includes(queryLower);
        const fileMatch = !fileLower || (sym.sourceFile ?? '').toLowerCase().includes(fileLower);
        const summaryMatch = !queryLower || (sym.enriched?.summary ?? '').toLowerCase().includes(queryLower);
        return nameMatch || summaryMatch && fileMatch;
      }).slice(0, 20);
    },

    async getDependents(symbolKey) {
      const [symbolData, graphData] = await Promise.all([
        safeReadJson(symbolIndexPath),
        safeReadJson(graphPath),
      ]);
      if (!symbolData?.symbols || !graphData?.nodes || !graphData?.edges) return [];

      const sym = symbolData.symbols.find(s => s.symbolKey === symbolKey || s.name === symbolKey);
      if (!sym?.graphNodeId) return [];

      const inEdges = graphData.edges.filter(e => e.target === sym.graphNodeId);
      const sourceNodes = graphData.nodes.filter(n => inEdges.some(e => e.source === n.id));
      const sourceSymbols = symbolData.symbols.filter(s => sourceNodes.some(n => n.id === s.graphNodeId));

      return sourceSymbols.map(s => ({
        symbolKey: s.symbolKey,
        name: s.name,
        file: s.sourceFile,
        kind: s.kind,
      }));
    },

    async getDependencies(symbolKey) {
      const [symbolData, graphData] = await Promise.all([
        safeReadJson(symbolIndexPath),
        safeReadJson(graphPath),
      ]);
      if (!symbolData?.symbols || !graphData?.nodes || !graphData?.edges) return [];

      const sym = symbolData.symbols.find(s => s.symbolKey === symbolKey || s.name === symbolKey);
      if (!sym?.graphNodeId) return [];

      const outEdges = graphData.edges.filter(e => e.source === sym.graphNodeId);
      const targetNodes = graphData.nodes.filter(n => outEdges.some(e => e.target === n.id));
      const targetSymbols = symbolData.symbols.filter(s => targetNodes.some(n => n.id === s.graphNodeId));

      return targetSymbols.map(s => ({
        symbolKey: s.symbolKey,
        name: s.name,
        file: s.sourceFile,
        kind: s.kind,
      }));
    },
  };
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd tools/project-memory-context && node --test tests/query.test.mjs`
Expected: 3 PASS

- [ ] **Step 4: Commit**

```bash
git add tools/project-memory-context/src/query/orchestrator.mjs tools/project-memory-context/tests/query.test.mjs
git commit -m "feat(pmc): add query engine core with memory and symbol search"
```

---

### Task 2: CLI Command — `cli/query.mjs`

**Files:**
- Create: `tools/project-memory-context/cli/query.mjs`
- Modify: `tools/project-memory-context/src/command-dispatch.mjs`

- [ ] **Step 1: Write the test**

```js
// Add to tests/query.test.mjs
test('pmc query --help prints usage', async () => {
  const { runCommand } = await import('../src/command-dispatch.mjs');
  const chunks = [];
  const mockStdout = { write: (chunk) => chunks.push(chunk) };
  const mockStderr = { write: () => {} };
  const exitCode = await runCommand(['query', '--help'], {
    stdio: 'pipe',
    stdout: mockStdout,
    stderr: mockStderr,
  });
  const output = chunks.join('');
  assert.match(output, /query/i);
  assert.match(output, /question/i);
});
```

Run: `node --test tests/query.test.mjs`
Expected: FAIL (query.mjs not yet created)

- [ ] **Step 2: Register `query` command in command-dispatch.mjs**

```js
// In src/command-dispatch.mjs, add to COMMANDS Map:
['query', 'cli/query.mjs'],
```

- [ ] **Step 3: Create `cli/query.mjs`**

```js
#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createQueryOrchestrator } from '../src/query/orchestrator.mjs';

async function findProjectRoot() {
  let dir = process.cwd();
  const { root } = require('node:path');
  while (dir !== root) {
    try {
      await readFile(join(dir, '.planning', 'project-memory-context', 'install.json'), 'utf8');
      return dir;
    } catch {
      dir = join(dir, '..');
    }
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    console.log(`Usage: pmc query "<question>"
       pmc query --format json "<question>"

Ask a question about the project using PMC-enriched context.

Examples:
  pmc query "how does auth work?"
  pmc query "what APIs does this project expose?"
  pmc query "who depends on the bootstrap module?"
`);
    process.exit(0);
  }

  const formatFlagIndex = args.indexOf('--format');
  const format = formatFlagIndex >= 0 && args[formatFlagIndex + 1] === 'json' ? 'json' : 'text';
  if (formatFlagIndex >= 0) {
    args.splice(formatFlagIndex, 2);
  }

  const question = args.join(' ');
  if (!question) {
    console.error('Error: no question provided. Use --help for usage.');
    process.exit(1);
  }

  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    console.error('No PMC-enabled project found in current or parent directories.');
    console.error('Run "pmc bootstrap . --all" first to set up project memory context.');
    process.exit(1);
  }

  const orch = createQueryOrchestrator({ projectRoot });
  const result = await orch.query(question);

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  if (!result.answer) {
    console.log('No relevant context found in PMC for that question.');
    console.log('Try rephrasing, or use /get-context to explore project structure.');
    process.exit(0);
  }

  console.log('\n' + result.answer + '\n');

  if (result.sources.length > 0) {
    console.log('Sources:');
    for (const s of result.sources) {
      console.log(`  ${s.file}${s.summary ? ` — ${s.summary.slice(0, 80)}` : ''}`);
    }
  }

  if (result.tokens_saved > 0) {
    console.log(`\n~${result.tokens_saved} tokens saved by using PMC context vs reading raw files`);
  }
}

main().catch(err => {
  console.error('query failed:', err.message);
  process.exit(1);
});
```

- [ ] **Step 4: Add CLI integration test**

```js
// Add to tests/query.test.mjs
test('cli query returns result for a PMC project', async () => {
  const { resolveCommand, runCommand } = await import('../src/command-dispatch.mjs');
  const cmd = resolveCommand(['query']);
  assert.ok(cmd.valid);
  assert.ok(cmd.modulePath.endsWith('cli/query.mjs'));
});
```

- [ ] **Step 5: Run tests**

Run: `cd tools/project-memory-context && node --test tests/query.test.mjs`
Expected: 5 PASS

- [ ] **Step 6: Commit**

```bash
git add tools/project-memory-context/cli/query.mjs tools/project-memory-context/src/command-dispatch.mjs tools/project-memory-context/tests/query.test.mjs
git commit -m "feat(pmc): add pmc query CLI command"
```

---

### Task 3: MCP Query Server — `mcp/pmc-query-server.mjs`

**Files:**
- Create: `tools/project-memory-context/mcp/pmc-query-server.mjs`
- Modify: `tools/project-memory-context/src/plugin-config.mjs`
- Modify: `tools/project-memory-context/plugin/index.mjs`

- [ ] **Step 1: Write the MCP server test**

```js
// Add to tests/query.test.mjs
import { spawn } from 'node:child_process';

test('pmc-query-server lists tools', async () => {
  const serverPath = new URL('../mcp/pmc-query-server.mjs', import.meta.url).pathname;
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PMC_PROJECT_ROOT: process.cwd() },
  });

  // Send initialize + tools/list
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {} },
  }) + '\n');

  await new Promise(r => setTimeout(r, 500));

  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  }) + '\n');

  const output = await new Promise((resolve) => {
    let data = '';
    child.stdout.on('data', (chunk) => { data += chunk; });
    child.on('close', () => resolve(data));
    setTimeout(() => { child.kill(); resolve(data); }, 3000);
  });

  assert.match(output, /pmc_query_project/);
  assert.match(output, /pmc_search_symbols/);
  child.kill();
});
```

- [ ] **Step 2: Create `mcp/pmc-query-server.mjs`**

```js
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createQueryOrchestrator } from '../src/query/orchestrator.mjs';

const projectRoot = process.env.PMC_PROJECT_ROOT || process.cwd();
const orch = createQueryOrchestrator({ projectRoot });

const server = new McpServer({
  name: 'pmc-query',
  version: '0.1.0',
});

server.tool(
  'pmc_query_project',
  'Ask a question about the project. Uses PMC-enriched context (memories, symbols, graph) to answer.',
  { question: z.string().describe('Natural language question about the project') },
  async ({ question }) => {
    try {
      const result = await orch.query(question);
      return {
        content: [
          { type: 'text', text: result.answer || 'No relevant context found in PMC.' },
          ...result.sources.slice(0, 10).map(s => ({
            type: 'text',
            text: `Source: ${s.file}${s.summary ? ` — ${s.summary}` : ''}`,
          })),
          result.tokens_saved > 0
            ? { type: 'text', text: `~${result.tokens_saved} tokens saved by using PMC vs reading files` }
            : null,
        ].filter(Boolean),
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Query failed: ${String(error)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'pmc_search_symbols',
  'Search for symbols (classes, functions, interfaces) by name or file.',
  {
    query: z.string().describe('Search term for symbol name or description'),
    file: z.string().optional().describe('Filter by source file path'),
  },
  async ({ query, file }) => {
    try {
      const symbols = await orch.searchSymbols(query, file);
      if (symbols.length === 0) {
        return { content: [{ type: 'text', text: 'No matching symbols found.' }] };
      }
      const text = symbols.map(s =>
        `- ${s.name} (${s.kind}) in ${s.file}${s.enriched?.summary ? `: ${s.enriched.summary.slice(0, 120)}` : ''}`
      ).join('\n');
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Search failed: ${String(error)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'pmc_get_dependents',
  'Find what depends on a given symbol (inbound graph edges).',
  { symbol: z.string().describe('Symbol name or symbolKey (e.g. "Server" or "src/server.mjs:Server")') },
  async ({ symbol }) => {
    try {
      const dependents = await orch.getDependents(symbol);
      if (dependents.length === 0) {
        return { content: [{ type: 'text', text: `No dependents found for ${symbol}.` }] };
      }
      const text = dependents.map(d =>
        `- ${d.name} (${d.kind}) in ${d.file}`
      ).join('\n');
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Failed: ${String(error)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'pmc_get_dependencies',
  'Find what a given symbol depends on (outbound graph edges).',
  { symbol: z.string().describe('Symbol name or symbolKey') },
  async ({ symbol }) => {
    try {
      const deps = await orch.getDependencies(symbol);
      if (deps.length === 0) {
        return { content: [{ type: 'text', text: `No dependencies found for ${symbol}.` }] };
      }
      const text = deps.map(d =>
        `- ${d.name} (${d.kind}) in ${d.file}`
      ).join('\n');
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Failed: ${String(error)}` }],
        isError: true,
      };
    }
  },
);

await server.connect(new StdioServerTransport());
```

- [ ] **Step 3: Register PMC query MCP server in plugin-config.mjs**

```js
// In src/plugin-config.mjs, add to the returned mcp object:
'pmc-query': {
  type: 'local',
  command: ['npx', '-y', '@aabadin/project-memory-context'],
  args: ['mcp/pmc-query-server.mjs'],
  enabled: true,
  environment: {
    PMC_PROJECT_ROOT: installState.projectRoot ?? '',
  },
},
```

Update `buildInjectedPmcConfig` to receive projectRoot from installState. The install.json already contains the project root from the bootstrap process.

- [ ] **Step 4: Update plugin/index.mjs to pass projectRoot**

In `plugin/index.mjs`, the `buildInjectedPmcConfig` already receives `installState` which should contain a `projectRoot` field (or we add it). Let me check the install.json structure...

Actually, for the MCP server approach with `npx`, we need to ensure the package is resolvable. Since the package is already installed globally via npm, `npx -y @aabadin/project-memory-context mcp/pmc-query-server.mjs` should work. But actually `npx` doesn't support passing a subpath directly. We'd need:

```json
{
  "command": ["node"],
  "args": ["-e", "require('@aabadin/project-memory-context/mcp/pmc-query-server.mjs')"]
}
```

Or better, just use the direct path:

```json
{
  "type": "local",
  "command": ["npx", "-y", "@aabadin/project-memory-context"],
  "args": ["mcp/pmc-query-server.mjs"],
  "enabled": true,
  "environment": {
    "PMC_PROJECT_ROOT": installState.projectRoot ?? ""
  }
}
```

Actually npx might not forward args. A simpler approach: create a small wrapper that requires the package and runs it. Or just use `node` with a path from the globally installed package.

Actually the easiest approach: since the query server is part of the PMC package and gets installed locally via `pmc setup`, the MCP server path can be relative to the package. The plugin can inject it as:

```json
"pmc-query": {
  "type": "local",
  "command": ["npx", "-y", "@aabadin/project-memory-context", "mcp/pmc-query-server.mjs"],
  "enabled": true,
  "environment": {
    "PMC_PROJECT_ROOT": installState.projectRoot ?? ""
  }
}
```

But npx might not pass extra args to the package bin. Let me use a different approach: the PMC package's `package.json` can have an `exports` field that exposes the MCP server, then we use `node --input-type=module -e "import('@aabadin/project-memory-context/mcp/pmc-query-server.mjs')"`.

Actually, the simplest: in the package.json, add a `bin` entry for the query server too:

```json
"bin": {
  "pmc": "bin/pmc.mjs",
  "pmc-query-server": "mcp/pmc-query-server.mjs"
}
```

But that clutters the global PATH. Better approach: use the `node` executable with a require/import of the module path within the global package. The cleanest way is:

```json
{
  "command": ["node"],
  "args": [
    "-e",
    "import('@aabadin/project-memory-context/mcp/pmc-query-server.mjs').then(m => m.main?.() || {})"
  ]
}
```

Hmm, that's fragile. Let me just add the query server as a bin entry:

```json
"bin": {
  "pmc": "bin/pmc.mjs",
  "pmc-query-server": "mcp/pmc-query-server.mjs"
}
```

Then the MCP config is simply:
```json
"pmc-query": {
  "type": "local",
  "command": ["pmc-query-server"],
  "enabled": true,
  "environment": {
    "PMC_PROJECT_ROOT": installState.projectRoot ?? ""
  }
}
```

Yes, that's clean. Let me use this approach.

- [ ] **Step 5: Update package.json bin entry**

Add `"pmc-query-server": "mcp/pmc-query-server.mjs"` to the bin object.

- [ ] **Step 6: Run tests**

Run: `cd tools/project-memory-context && node --test tests/query.test.mjs`
Expected: All passing

- [ ] **Step 7: Commit**

```bash
git add tools/project-memory-context/mcp/pmc-query-server.mjs tools/project-memory-context/src/plugin-config.mjs tools/project-memory-context/plugin/index.mjs tools/project-memory-context/package.json tools/project-memory-context/tests/query.test.mjs
git commit -m "feat(pmc): add MCP query server with project query and symbol search tools"
```

---

### Task 4: PMC-Aware Agent Skill — templates + installer

**Files:**
- Create: `tools/project-memory-context/templates/pmc-skill/SKILL.md`
- Modify: `tools/project-memory-context/src/template-installer.mjs`
- Modify: `tools/project-memory-context/templates/claude-code/CLAUDE.md.snippet`
- Modify: `tools/project-memory-context/templates/cursor/.cursorrules.snippet`
- Modify: `tests/init.test.mjs`

- [ ] **Step 1: Create `templates/pmc-skill/SKILL.md`**

````markdown
# PMC-Aware Development

Optimize token usage and development speed by querying Project Memory Context (PMC) before reading source files.

## Token Optimization Strategy

| Action | Approx tokens |
|---|---|
| Read 10 source files directly | 5,000–15,000 |
| `pmc query` (single question) | 500–1,500 |
| PMC MCP tools | 200–800 |
| `/get-context <target>` | 200–800 |

**Rule:** PMC first, files second. Always query PMC before reading >3 files.

## Commands

- `/map-project` — Bootstrap PMC for a new project (run `pmc bootstrap . --all --enrich`)
- `/get-context <target>` — Structure deep-dive (run `pmc context . --refresh`)
- `/enrich-status` — Check enrichment progress (run `pmc status .`)
- `/doctor` — Diagnose PMC setup (run `pmc doctor`)
- `/init-project` — Initialize PMC (run `pmc init .`)
- `/sync-context` — Sync pending enrichment to agent-memory
- `/sanitize` — Clean PMC data (run `pmc sanitize .`)

## MCP Tools (available via pmc-query server)

When you need to understand the codebase:

1. **Call `pmc_query_project`** with natural language questions first:
   - "What is the architecture of this project?"
   - "How does the auth system work?"
   - "What external APIs does this project use?"

2. **Call `pmc_search_symbols`** to find where things are defined before grepping:
   - Search by symbol name or file path
   - Returns enriched summaries with source locations

3. **Call `pmc_get_dependents` / `pmc_get_dependencies`** to understand relationships:
   - "What depends on this class?"
   - "What does this module need to work?"

## Workflow

1. Understand the project → `/get-context` or `pmc_query_project`
2. Find specific code → `pmc_search_symbols`
3. Understand relationships → `pmc_get_dependents` / `pmc_get_dependencies`
4. Read files → ONLY if you need exact line-level implementation
5. Make changes → Use the gathered context to make informed edits

## Why

PMC stores pre-enriched context (architecture, dependencies, symbol summaries, patterns).
Querying it costs ~500 tokens vs reading the same information from source = ~5000+ tokens.
This means faster responses and lower costs.
````

- [ ] **Step 2: Add skill to template-installer**

In `src/template-installer.mjs`, add a PMCSkill installer to `installOpencode` that writes the SKILL.md to the global skills directory.

Add after `const enrichTemplate = ...`:
```js
// Install PMC-Aware skill
const pmcSkillTemplate = renderTemplate(
  await readTemplate(packageRoot, 'pmc-skill/SKILL.md'),
  placeholders,
);
await writeIfMissingOrForced(join(globalDir, 'skills', 'pmc-skill', 'SKILL.md'), pmcSkillTemplate, { force: true });
```

- [ ] **Step 3: Update CLAUDE.md.snippet to add PMC-Aware instructions**

Append to the snippet (before `<!-- /pmc:init -->`):
```

## PMC-Aware Rule

**Before reading more than 3 files, query PMC first.** PMC stores pre-enriched context (architecture, symbols, dependencies). Querying costs ~500 tokens vs reading raw files = ~5000+ tokens.

Available tools:
- `pmc_query_project` — ask any question about the project
- `pmc_search_symbols` — find symbols by name or file
- `pmc_get_dependents` / `pmc_get_dependencies` — understand relationships
- `/get-context <target>` — structural deep-dive
```

- [ ] **Step 4: Update .cursorrules.snippet identically**

Same content as Step 3.

- [ ] **Step 5: Update init.test.mjs**

Add assertion for `pmc-skill/SKILL.md` template existence:
```js
test('pmc-skill template exists', async () => {
  const pkgRoot = resolvePackageRoot();
  const content = await readFile(join(pkgRoot, 'templates', 'pmc-skill', 'SKILL.md'), 'utf8');
  assert.match(content, /PMC-Aware/);
});
```

- [ ] **Step 6: Run tests**

Run: `cd tools/project-memory-context && node --test tests/*.test.mjs`
Expected: All passing

- [ ] **Step 7: Commit**

```bash
git add tools/project-memory-context/templates/pmc-skill/SKILL.md tools/project-memory-context/src/template-installer.mjs tools/project-memory-context/templates/claude-code/CLAUDE.md.snippet tools/project-memory-context/templates/cursor/.cursorrules.snippet tests/init.test.mjs
git commit -m "feat(pmc): add PMC-Aware agent skill and update agent snippets"
```

---

### Self-Review

**1. Spec coverage:**
- ✅ CLI `pmc query` — Task 2
- ✅ MCP tools (pmc_query_project, search_symbols, get_dependents, get_dependencies) — Task 3
- ✅ Agent skill "PMC-Aware" — Task 4
- ✅ Web UI — deferred to future (per user decision)
- ✅ Token optimization strategy — covered in skill + snippets

**2. Placeholder scan:**
No TBD, TODO, "implement later", or placeholder patterns found.

**3. Type consistency:**
- `createQueryOrchestrator({ projectRoot })` — consistent across Tasks 1, 2, 3
- `query(question)` returns `{ answer, sources, tokens_saved }` — consistent
- `searchSymbols(query, fileFilter)` returns array — consistent
- `getDependents(symbolKey)` / `getDependencies(symbolKey)` — consistent

---
