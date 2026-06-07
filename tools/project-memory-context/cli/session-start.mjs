#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  launchEnrichmentIfNeeded,
  runSessionStartRuntime,
} from '../src/session-start-runtime.mjs';

// Re-exported for backwards compatibility with any external consumer
// (e.g. the OpenCode plugin before Task 3 lands) that imports this
// helper from the CLI module path.
export { launchEnrichmentIfNeeded };

function parseArgs(args) {
  const nonFlags = args.filter((arg) => !arg.startsWith('-'));
  const projectRoot = nonFlags[0] ? resolve(nonFlags[0]) : resolve(process.cwd());
  const formatArg = args.find((arg) => arg.startsWith('--format='));
  const format = formatArg ? formatArg.replace('--format=', '') : 'text';
  return { projectRoot, format };
}

export function formatSessionStartText(result) {
  const parts = [];
  const worklist = result.status?.worklist;

  if (worklist) {
    const details = [];
    if (worklist.pending > 0) details.push(`${worklist.pending} pending`);
    if (worklist.errors > 0) details.push(`${worklist.errors} errors`);
    const detailText = details.length ? ` · ${details.join(', ')}` : '';
    parts.push(`**PMC enrichment:** ${worklist.enriched} symbols enriched${detailText} · queue: ${result.status.state}`);
  } else {
    parts.push('**PMC:** no enrichment data (run `/map-project` to bootstrap)');
  }

  if (result.launch?.launchedEnrichment || result.launch?.launchedWatchdog) {
    parts.push(`**Launch:** background enrich/watchdog started via ${result.launch.backend}.`);
  }

  if (result.syncPending > 0) {
    parts.push(`**Sync:** ${result.syncPending} pending → run \`/sync-context\` to persist to agent-memory.`);
  }

  if (result.subagentPending > 0) {
    parts.push(`**Subagent queue:** ${result.subagentPending} large symbols need LLM enrichment → dispatch the \`enrich\` subagent.`);
  }

  if (result.overview.length > 0) {
    parts.push('');
    parts.push('## Project context');
    for (const entry of result.overview) {
      parts.push(`**${entry.title}:** ${entry.summary}`);
    }
  }

  if (result.warnings.length > 0) {
    parts.push('');
    for (const warning of result.warnings) {
      parts.push(`**Warning:** ${warning}`);
    }
  }

  if (result.snapshot) {
    parts.push(`**Snapshot:** ${result.snapshot.jsonPath}`);
  }

  parts.push('');
  parts.push('> **Workflow:** `pmc get-context <target>` BEFORE reading files · `pmc refresh-context --enrich` after changes.');
  return parts.join('\n');
}

export async function runSessionStart(args = process.argv.slice(2), deps = {}) {
  const { projectRoot, format } = parseArgs(args);
  const runRuntime = deps.runSessionStartRuntime ?? runSessionStartRuntime;
  const stdout = deps.stdout ?? process.stdout;

  const result = await runRuntime(projectRoot, deps);
  if (!result.hasPmc) return 0;

  const text = formatSessionStartText(result);
  if (format === 'claude-code') {
    stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: text,
      },
    }) + '\n');
  } else {
    stdout.write(text + '\n');
  }

  return 0;
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write('Usage: pmc session-start [project-dir] [--format=<claude-code|text>]\n');
    return 0;
  }

  return runSessionStart(process.argv.slice(2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main().catch(() => 0);
  if (exitCode !== 0) process.exit(exitCode);
}
