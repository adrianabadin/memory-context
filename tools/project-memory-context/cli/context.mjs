#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJsonArtifact } from '../src/artifacts.mjs';
import { createQueryEngine, focusToEdgeTypes } from '../src/retrieval/query-engine.mjs';
import { resolveTarget } from '../src/retrieval/target-resolver.mjs';
import { renderTargetContext } from '../src/retrieval/context-renderer-v1.mjs';

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function findProjectRoot(startDir = process.cwd()) {
  let currentDir = resolve(startDir);

  while (true) {
    const installPath = join(currentDir, '.planning', 'project-memory-context', 'install.json');
    if (existsSync(installPath)) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

async function markContext(projectRoot, nodeIds) {
  if (!nodeIds || nodeIds.length === 0) return;
  const trackerPath = join(projectRoot, '.planning', 'project-memory-context', 'context-tracker.json');
  let tracker = { activeNodeIds: [] };
  try {
    if (existsSync(trackerPath)) {
      tracker = JSON.parse(readFileSync(trackerPath, 'utf-8'));
    }
  } catch {}
  const existing = new Set(tracker.activeNodeIds || []);
  nodeIds.forEach((id) => existing.add(id));
  tracker.activeNodeIds = [...existing];
  const dir = dirname(trackerPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(trackerPath, JSON.stringify(tracker, null, 2));
}

export function parseArgs(args) {
  const DEPTH_VALUES = ['compact', 'extended', 'deep', 'disk'];
  const FOCUS_VALUES = ['dependencies', 'callers', 'containment', 'impact', 'all'];
  const EXPLICIT_MODES = ['symbol', 'file', 'query'];

  let explicitMode = null;
  let target = undefined;
  let depth = 'compact';
  let focus = 'all';
  let refresh = false;
  let help = false;
  const positional = [];

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }

    if (arg === '--refresh') {
      refresh = true;
      continue;
    }

    if (EXPLICIT_MODES.includes(arg) && explicitMode === null && positional.length === 0) {
      explicitMode = arg;
      continue;
    }

    if (DEPTH_VALUES.includes(arg)) {
      depth = arg;
      continue;
    }

    if (FOCUS_VALUES.includes(arg)) {
      focus = arg;
      continue;
    }

    positional.push(arg);
  }

  if (positional.length > 0) {
    target = positional[0];
  }

  return { explicitMode, target, depth, focus, refresh, help };
}

export async function loadArtifacts(projectRoot) {
  const pmcRoot = join(projectRoot, '.planning', 'project-memory-context');
  try {
    const [graph, symbolIndex, worklist] = await Promise.all([
      readJsonArtifact(join(pmcRoot, 'graph', 'graph.json'), { nodes: [], links: [] }),
      readJsonArtifact(join(pmcRoot, 'enrichment', 'symbol-index.json'), {}),
      readJsonArtifact(join(pmcRoot, 'enrichment', 'worklist.json'), []),
    ]);
    return { graph, symbolIndex, worklist };
  } catch (error) {
    throw new Error(`Failed to load PMC artifacts from ${pmcRoot}: ${error.message}`);
  }
}

function groupEdges(edges, edgeTypes) {
  const byKind = new Map();
  for (const edge of edges) {
    if (!edgeTypes.includes(edge.relation)) continue;
    const kind = edge.relation;
    const arr = byKind.get(kind);
    if (arr) {
      arr.push(edge.target);
    } else {
      byKind.set(kind, [edge.target]);
    }
  }

  const result = [];
  for (const [kind, items] of byKind) {
    result.push({ kind, items });
  }

  return result;
}

export function buildRenderInput(engine, resolved, { depth, focus }) {
  const edgeTypes = focusToEdgeTypes(focus);
  let summary = [];
  let target = {};
  let relevant = [];
  let relations = [];
  let nextReads = [];

  switch (resolved.mode) {
    case 'symbol': {
      const ctx = engine.querySymbolContext({ symbolKey: resolved.symbolKey, depth });
      target = { mode: 'symbol', name: ctx.target?.name, filePath: ctx.target?.filePath };
      summary = [`Symbol: ${ctx.target?.name || resolved.target} (${ctx.target?.kind || 'unknown'})`];
      relevant = (ctx.neighbors || []).map((n) => ({
        label: n.name || n.label || 'unknown',
        filePath: n.filePath || undefined,
      }));
      relations = groupEdges(ctx.edges || [], edgeTypes);
      nextReads = relevant.map((r) => r.filePath).filter(Boolean);
      break;
    }
    case 'symbol-ambiguous': {
      target = { mode: 'symbol-ambiguous', name: resolved.target };
      summary = [`Multiple symbols match "${resolved.target}".`];
      relevant = (resolved.symbolKeys || []).map((sk) => {
        const parts = sk.split('|');
        return {
          label: parts.length >= 6 ? parts[parts.length - 2] : sk,
          filePath: parts.length >= 2 ? parts[1] : undefined,
        };
      });
      break;
    }
    case 'file': {
      const ctx = engine.queryFileContext({ filePath: resolved.target, depth });
      target = { mode: 'file', filePath: resolved.target };
      summary = ctx.symbols && ctx.symbols.length > 0
        ? ctx.symbols.map((s) => `${s.name || 'unknown'} (${s.kind || 'symbol'})`)
        : [`File: ${resolved.target}`];
      relevant = (ctx.neighbors || []).map((n) => ({
        label: n.name || n.label || 'unknown',
        filePath: n.filePath || undefined,
      }));
      relations = groupEdges(ctx.edges || [], edgeTypes);
      nextReads = relevant.map((r) => r.filePath).filter(Boolean);
      break;
    }
    case 'query':
      target = { mode: 'query', value: resolved.target };
      summary = [`Query: ${resolved.target} (no structural context available)`];
      break;
    case 'symbol-missing':
      target = { mode: 'symbol-missing', name: resolved.target };
      summary = [`Symbol "${resolved.target}" not found in project index.`];
      break;
    default:
      target = { mode: resolved.mode || 'unknown', value: resolved.target };
      summary = [`Unrecognized target mode: ${resolved.mode}`];
      break;
  }

  return {
    summary,
    target,
    relevant,
    relations,
    nextReads,
    metadata: { depth, focus },
  };
}

export async function runTargetContext({ projectRoot, target, explicitMode, depth, focus, artifacts }) {
  const artfs = artifacts ?? await loadArtifacts(projectRoot);
  const engine = createQueryEngine({
    graph: artfs.graph,
    symbolIndex: artfs.symbolIndex,
    worklist: artfs.worklist,
    enrichmentDir: join(projectRoot, '.planning', 'project-memory-context', 'enrichment'),
    projectSlug: 'project',
  });

  const resolved = resolveTarget({ engine, explicitMode, target });

  const input = buildRenderInput(engine, resolved, { depth, focus });
  const output = renderTargetContext(input);

  return { output, resolved, input, artifacts: artfs };
}

export async function runProjectContext(projectRoot = process.cwd(), refresh = false) {
  const mod = await import('./project-context.mjs');
  if (typeof mod.runProjectContextCli === 'function') {
    return mod.runProjectContextCli(projectRoot, { refresh });
  }

  return null;
}

function printHelp() {
  console.log('Usage: pmc context [options] [<target>]');
  console.log('       pmc context {symbol|file|query} <target> [depth] [focus]');
  console.log('');
  console.log('Get structural context about symbols, files, or free-text queries');
  console.log('from the PMC project graph.');
  console.log('');
  console.log('Modes:');
  console.log('  symbol   Resolve a symbol by name');
  console.log('  file     Query context for a file path');
  console.log('  query    Free-text query (structural only)');
  console.log('');
  console.log('Options:');
  console.log('  depth    compact (default), extended, deep, disk');
  console.log('  focus    all (default), dependencies, callers, containment, impact');
  console.log('  --refresh  Run project-context detection and materialization');
  console.log('  --help, -h Show this help');
  console.log('');
  console.log('Examples:');
  console.log('  pmc context createQueryEngine');
  console.log('  pmc context symbol MyFunc extended dependencies');
  console.log('  pmc context file src/auth.ts deep callers');
  console.log('  pmc context query "how auth works"');
  console.log('  pmc context . --refresh');
}

export async function main(args = process.argv.slice(2)) {
  const parsed = parseArgs(args);

  if (parsed.help) {
    printHelp();
    return 0;
  }

  if (parsed.refresh) {
    let projectRoot;

    if (parsed.target && parsed.target !== '.') {
      const looksValid = /^[A-Za-z]:[\\/]/.test(parsed.target)
        || /^[\\/]/.test(parsed.target)
        || /^\.{2}[\\/]?/.test(parsed.target);

      if (looksValid) {
        projectRoot = resolve(parsed.target);
      } else {
        console.error(
          `[context] --refresh does not accept a non-path target "${parsed.target}".`,
          'Use . --refresh to refresh from cwd, or omit the target entirely.',
        );
        return 1;
      }
    } else {
      projectRoot = await findProjectRoot();
    }

    if (!projectRoot) {
      console.error('[context] Not inside a PMC-enabled project.');
      return 1;
    }

    try {
      return await runProjectContext(projectRoot, true);
    } catch (error) {
      console.error(`[context] Refresh failed: ${error.message}`);
      return 1;
    }
  }

  if (!parsed.target) {
    if (parsed.explicitMode) {
      console.error(`[context] Missing target for ${parsed.explicitMode} mode.`);
      return 1;
    }

    printHelp();
    return 0;
  }

  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    console.error('[context] Not inside a PMC-enabled project (no install.json found).');
    return 1;
  }

  const artifacts = await loadArtifacts(projectRoot);
  const { output, resolved } = await runTargetContext({
    projectRoot,
    target: parsed.target,
    explicitMode: parsed.explicitMode,
    depth: parsed.depth,
    focus: parsed.focus,
  });

  const nodeIdsToMark = [];
  if (resolved.symbolKey) {
    const entry = artifacts.symbolIndex[resolved.symbolKey];
    if (entry?.graphNodeId) nodeIdsToMark.push(entry.graphNodeId);
  } else if (resolved.target && (resolved.mode === 'file' || resolved.mode === 'symbol-missing')) {
    const fileNodeId = resolved.target.replace(/[/\\]/g, '_').replace(/[:.]/g, '_');
    nodeIdsToMark.push(fileNodeId);
  }

  await markContext(projectRoot, nodeIdsToMark);

  console.log(output);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main().catch((error) => {
    console.error('[context] FATAL:', error.message);
    return 1;
  });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
