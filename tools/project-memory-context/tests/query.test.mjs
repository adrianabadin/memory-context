import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { resolveCommand } from '../src/command-dispatch.mjs';
import { buildInjectedPmcConfig } from '../src/plugin-config.mjs';
import { createQueryOrchestrator } from '../src/query/orchestrator.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(TEST_DIR, '..');
const BIN_PATH = resolve(PACKAGE_ROOT, 'bin', 'pmc.mjs');

async function createFixtureProject({
  memories = [],
  symbolIndex = {},
  graph = { nodes: [], edges: [] },
} = {}) {
  const projectRoot = await mkdtemp(join(os.tmpdir(), 'pmc-query-'));
  const pmcRoot = join(projectRoot, '.planning', 'project-memory-context');
  const materializedDir = join(pmcRoot, 'project-context', 'materialized');
  const enrichmentDir = join(pmcRoot, 'enrichment');
  const graphDir = join(pmcRoot, 'graph');

  await mkdir(materializedDir, { recursive: true });
  await mkdir(enrichmentDir, { recursive: true });
  await mkdir(graphDir, { recursive: true });
  await writeFile(
    join(pmcRoot, 'install.json'),
    JSON.stringify({ installedAt: '2026-05-19T00:00:00.000Z', version: '0.1.0' }, null, 2),
    'utf8',
  );

  for (const memory of memories) {
    await writeFile(
      join(materializedDir, memory.fileName),
      JSON.stringify(memory.content, null, 2),
      'utf8',
    );
  }

  await writeFile(
    join(enrichmentDir, 'symbol-index.json'),
    JSON.stringify(symbolIndex, null, 2),
    'utf8',
  );
  await writeFile(join(graphDir, 'graph.json'), JSON.stringify(graph, null, 2), 'utf8');

  return projectRoot;
}

async function runCli(args, { cwd } = {}) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`CLI exited from signal ${signal}`));
        return;
      }

      resolvePromise({ code: code ?? 0, stdout, stderr });
    });
  });
}

test('resolveCommand maps query to cli/query.mjs', () => {
  const command = resolveCommand(['query']);
  assert.equal(command.name, 'query');
  assert.equal(command.modulePath, resolve(PACKAGE_ROOT, 'cli', 'query.mjs'));
  assert.deepEqual(command.args, []);
});

test('package metadata exposes pmc-query-server bin', async () => {
  const packageJson = JSON.parse(await readFile(resolve(PACKAGE_ROOT, 'package.json'), 'utf8'));

  assert.equal(packageJson.bin['pmc-query-server'], 'mcp/pmc-query-server.mjs');
});

test('buildInjectedPmcConfig injects pmc-query with PMC_PROJECT_ROOT', () => {
  const injected = buildInjectedPmcConfig({
    installState: {
      projectRoot: '/tmp/project',
      memoryDbPath: '/tmp/db',
    },
  });

  assert.deepEqual(injected.mcp['pmc-query'].command, [
    'npx',
    '--yes',
    '--package',
    '@aabadin/project-memory-context',
    'pmc-query-server',
  ]);
  assert.equal(injected.mcp['pmc-query'].enabled, true);
  assert.equal(injected.mcp['pmc-query'].environment.PMC_PROJECT_ROOT, '/tmp/project');
});

test('pmc query server file exists and registers the v1 query tools', async () => {
  const serverPath = resolve(PACKAGE_ROOT, 'mcp', 'pmc-query-server.mjs');
  await access(serverPath, fsConstants.F_OK);

  const source = await readFile(serverPath, 'utf8');

  assert.match(source, /createQueryOrchestrator\(\{\s*projectRoot\s*\}\)/);
  assert.match(source, /PMC_PROJECT_ROOT \|\| process\.cwd\(\)/);
  assert.match(source, /server\.tool\(\s*'pmc_query_project'/);
  assert.match(source, /server\.tool\(\s*'pmc_search_symbols'/);
  assert.match(source, /server\.tool\(\s*'pmc_get_dependents'/);
  assert.match(source, /server\.tool\(\s*'pmc_get_dependencies'/);
});

test('pmc query server exposes the four v1 tools over MCP stdio', async () => {
  const serverPath = resolve(PACKAGE_ROOT, 'mcp', 'pmc-query-server.mjs');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      PMC_PROJECT_ROOT: PACKAGE_ROOT,
    },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const client = new Client({ name: 'pmc-query-test', version: '1.0.0' });

  try {
    await client.connect(transport);
    const result = await client.listTools();

    assert.deepEqual(
      result.tools.map((tool) => tool.name).sort(),
      ['pmc_get_dependencies', 'pmc_get_dependents', 'pmc_query_project', 'pmc_search_symbols'].sort(),
    );
    assert.equal(stderr, '');
  } finally {
    await transport.close();
  }
});

test('pmc query --help prints usage text', async () => {
  const result = await runCli(['query', '--help'], { cwd: PACKAGE_ROOT });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: pmc query <question>/i);
  assert.match(result.stdout, /--format json/i);
  assert.equal(result.stderr, '');
});

test('pmc query fails clearly outside a PMC-enabled project', async () => {
  const cwd = await mkdtemp(join(os.tmpdir(), 'pmc-query-outside-'));

  try {
    const result = await runCli(['query', 'What uses Next.js?'], { cwd });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /PMC-enabled project/i);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('pmc query rejects unknown flags', async () => {
  const projectRoot = await createFixtureProject();

  try {
    const result = await runCli(['query', 'Next.js', '--bogus'], { cwd: projectRoot });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown flag: --bogus/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('pmc query reports a clear error when --format has no value', async () => {
  const projectRoot = await createFixtureProject();

  try {
    const result = await runCli(['query', 'Next.js', '--format'], { cwd: projectRoot });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Missing value for --format/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('pmc query walks upward to the PMC project root and supports json output', async () => {
  const projectRoot = await createFixtureProject({
    memories: [
      {
        fileName: 'stack-runtime.json',
        content: {
          kind: 'stack-runtime',
          title: 'Project stack and runtime',
          summary: 'Frameworks: Next.js, React.',
          body: 'The app uses the Next.js App Router with React Server Components.',
          tags: ['project-context', 'react', 'nextjs'],
        },
      },
    ],
  });
  const nestedCwd = join(projectRoot, 'src', 'features');
  await mkdir(nestedCwd, { recursive: true });

  try {
    const result = await runCli(['query', 'Which framework uses app router?', '--format', 'json'], { cwd: nestedCwd });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');

    const payload = JSON.parse(result.stdout);
    assert.match(payload.answer, /Next\.js App Router/i);
    assert.ok(
      payload.sources.some((source) => String(source.path).endsWith('project-context/materialized/stack-runtime.json')),
    );
    assert.equal(typeof payload.tokens_saved, 'number');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('pmc query prints default text output with answer, sources, and tokens saved', async () => {
  const projectRoot = await createFixtureProject({
    memories: [
      {
        fileName: 'stack-runtime.json',
        content: {
          kind: 'stack-runtime',
          title: 'Project stack and runtime',
          summary: 'Frameworks: Next.js, React.',
          body: 'The app uses the Next.js App Router with React Server Components.',
          tags: ['project-context', 'react', 'nextjs'],
        },
      },
    ],
  });

  try {
    const result = await runCli(['query', 'Which framework uses app router?'], { cwd: projectRoot });

    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /Next\.js App Router/i);
    assert.match(result.stdout, /Sources:/);
    assert.match(result.stdout, /\[project-context\].*stack-runtime\.json/i);
    assert.match(result.stdout, /tokens_saved:\s*\d+/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('query returns empty result for empty question', async () => {
  const projectRoot = await createFixtureProject();

  try {
    const orchestrator = createQueryOrchestrator({ projectRoot });

    assert.deepEqual(await orchestrator.query(''), {
      answer: '',
      sources: [],
      tokens_saved: 0,
    });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('query finds a materialized base memory by keyword', async () => {
  const projectRoot = await createFixtureProject({
    memories: [
      {
        fileName: 'stack-runtime.json',
        content: {
          kind: 'stack-runtime',
          title: 'Project stack and runtime',
          summary: 'Frameworks: Next.js, React.',
          body: 'The app uses the Next.js App Router with React Server Components.',
          tags: ['project-context', 'react', 'nextjs'],
        },
      },
    ],
  });

  try {
    const orchestrator = createQueryOrchestrator({ projectRoot });
    const result = await orchestrator.query('Which framework uses app router?');

    assert.match(result.answer, /Next\.js App Router/i);
    assert.ok(
      result.sources.some((source) => source.path.endsWith('project-context/materialized/stack-runtime.json')),
    );
    assert.ok(result.tokens_saved >= 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('query allows tokens_saved to be zero when answer is not shorter than sources', async () => {
  const projectRoot = await createFixtureProject({
    memories: [
      {
        fileName: 'stack-runtime.json',
        content: {
          kind: 'stack-runtime',
          title: 'Stack runtime memory',
          summary: '',
          body: 'React runtime.',
          tags: ['project-context', 'react'],
        },
      },
    ],
  });

  try {
    const orchestrator = createQueryOrchestrator({ projectRoot });
    const result = await orchestrator.query('react runtime');

    assert.match(result.answer, /React runtime/i);
    assert.equal(result.tokens_saved, 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('searchSymbols finds graph metadata summaries through normalized symbols', async () => {
  const symbolKey = 'ts|src/profile.ts|function|exported|buildUserProfile|1';
  const projectRoot = await createFixtureProject({
    symbolIndex: {
      [symbolKey]: {
        graphNodeId: 'symbol-buildUserProfile',
        memoryId: 'mem-1',
        status: 'enriched',
      },
    },
    graph: {
      nodes: [
        {
          id: 'symbol-buildUserProfile',
          label: 'buildUserProfile',
          source_file: 'src/profile.ts',
          metadata: {
            semanticSummary: 'Builds a user profile view model from account and preference records.',
          },
        },
      ],
      edges: [],
    },
  });

  try {
    const orchestrator = createQueryOrchestrator({ projectRoot });
    const matches = await orchestrator.searchSymbols('view model', 'src/profile.ts');

    assert.equal(matches.length, 1);
    assert.equal(matches[0].symbolKey, symbolKey);
    assert.match(matches[0].semanticSummary, /view model/i);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('dependency helpers traverse normalized edges', async () => {
  const symbolKey = 'ts|src/profile.ts|function|exported|buildUserProfile|1';
  const dependencyKey = 'ts|src/data.ts|function|exported|loadAccount|1';
  const dependentKey = 'ts|src/page.ts|function|exported|renderProfilePage|1';
  const projectRoot = await createFixtureProject({
    symbolIndex: {
      [symbolKey]: { graphNodeId: 'build-node', status: 'enriched' },
      [dependencyKey]: { graphNodeId: 'load-node', status: 'enriched' },
      [dependentKey]: { graphNodeId: 'page-node', status: 'enriched' },
    },
    graph: {
      nodes: [
        { id: 'build-node', label: 'buildUserProfile', source_file: 'src/profile.ts' },
        { id: 'load-node', label: 'loadAccount', source_file: 'src/data.ts' },
        { id: 'page-node', label: 'renderProfilePage', source_file: 'src/page.ts' },
      ],
      edges: [
        { source: 'build-node', target: 'load-node', relation: 'calls' },
        { source: 'page-node', target: 'build-node', relation: 'calls' },
      ],
    },
  });

  try {
    const orchestrator = createQueryOrchestrator({ projectRoot });
    const dependencies = await orchestrator.getDependencies(symbolKey);
    const dependents = await orchestrator.getDependents(symbolKey);

    assert.deepEqual(dependencies.map((item) => item.symbolKey), [dependencyKey]);
    assert.deepEqual(dependents.map((item) => item.symbolKey), [dependentKey]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('query loads artifacts once per non-empty question', async () => {
  let loadCount = 0;
  const orchestrator = createQueryOrchestrator({
    projectRoot: 'unused',
    loadArtifacts: async () => {
      loadCount += 1;
      return {
        memories: [
          {
            path: 'project-context/materialized/stack-runtime.json',
            title: 'Project stack and runtime',
            summary: 'Frameworks: Next.js, React.',
            body: 'The app uses the Next.js App Router with React Server Components.',
            tags: ['project-context', 'react', 'nextjs'],
          },
        ],
        symbols: [
          {
            symbolKey: 'ts|src/profile.ts|function|exported|buildUserProfile|1',
            name: 'buildUserProfile',
            filePath: 'src/profile.ts',
            graphNodeId: 'symbol-buildUserProfile',
            memoryId: 'mem-1',
            status: 'enriched',
            semanticSummary: 'Builds a user profile view model from account and preference records.',
          },
        ],
        nodes: [],
        edges: [],
      };
    },
  });

  const result = await orchestrator.query('Which framework builds the view model?');

  assert.equal(loadCount, 1);
  assert.match(result.answer, /Next\.js App Router/i);
  assert.match(result.answer, /buildUserProfile/i);
});
