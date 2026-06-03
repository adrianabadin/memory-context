#!/usr/bin/env node
/**
 * pmc session-start — zero-token session initializer.
 *
 * Designed to run as a SessionStart hook (outside the LLM context window):
 *   • checks enrichment state and launches background enrich + watchdog if needed
 *   • reads sync-manifest for pending sync count
 *   • loads project context overview from materialized disk artifacts (no MCP round-trip)
 *   • reports if the subagent drain queue has pending entries
 *   • emits a compact summary in the requested format
 *
 * Formats:
 *   --format=claude-code   JSON { hookSpecificOutput: { hookEventName, additionalContext } }
 *   --format=text          plain text (default; suitable for opencode / antigravity stdout injection)
 *
 * Exit codes: 0 always (failures are silent; never block agent startup).
 *
 * Usage: pmc session-start [project-dir] [--format=<claude-code|text>]
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildStatusReport } from './status.mjs';
import { spawnBackground } from '../src/platform.mjs';
import { readSyncManifest, getPendingEntries } from '../src/sync-manifest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENRICH_SCRIPT = join(__dirname, 'enrich-queue.mjs');
const WATCHDOG_SCRIPT = join(__dirname, 'enrich-watchdog.mjs');

/** Kinds to include in the context overview, in priority order. */
const OVERVIEW_KINDS = [
  'architecture-current',
  'module-minimap',
  'structure-summary',
  'stack-runtime',
  'dependencies-summary',
];

function parseArgs(args) {
  const nonFlags = args.filter((a) => !a.startsWith('-'));
  const projectRoot = nonFlags[0] ? resolve(nonFlags[0]) : resolve(process.cwd());
  const formatArg = args.find((a) => a.startsWith('--format='));
  const format = formatArg ? formatArg.replace('--format=', '') : 'text';
  return { projectRoot, format };
}

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read materialized project-context chunks from disk and build a compact overview.
 * This replaces the `agent-memory_search "project context overview"` call in the old autostart.
 * No MCP, no network, no tokens — pure filesystem read.
 */
async function loadContextOverview(projectRoot) {
  const materializedDir = join(
    projectRoot,
    '.planning',
    'project-memory-context',
    'project-context',
    'materialized',
  );

  const lines = [];
  for (const kind of OVERVIEW_KINDS) {
    const data = await readJsonSafe(join(materializedDir, `${kind}.json`));
    if (data?.title && data?.summary) {
      lines.push(`**${data.title}:** ${data.summary}`);
    }
  }

  return lines.join('\n');
}

function buildOutput({ status, syncPending, overview }) {
  const parts = [];

  // ── Status line ──────────────────────────────────────────────────────────
  const w = status.worklist;
  if (w) {
    const details = [];
    if (w.pending > 0) details.push(`${w.pending} pending`);
    if (w.errors > 0) details.push(`${w.errors} errors`);
    const detailStr = details.length ? ` · ${details.join(', ')}` : '';
    parts.push(
      `**PMC enrichment:** ${w.enriched} symbols enriched${detailStr} · queue: ${status.state}`,
    );
  } else {
    parts.push(`**PMC:** no enrichment data (run \`/map-project\` to bootstrap)`);
  }

  // ── Sync pending ─────────────────────────────────────────────────────────
  if (syncPending > 0) {
    parts.push(`**Sync:** ${syncPending} pending → run \`/sync-context\` to persist to agent-memory.`);
  }

  // ── Subagent drain ───────────────────────────────────────────────────────
  const subagentPending = status.subagentQueue?.pending ?? 0;
  if (subagentPending > 0) {
    parts.push(
      `**Subagent queue:** ${subagentPending} large symbols need LLM enrichment → dispatch the \`enrich\` subagent.`,
    );
  }

  // ── Project context overview from disk ───────────────────────────────────
  if (overview) {
    parts.push('');
    parts.push('## Project context');
    parts.push(overview);
  }

  // ── Workflow reminder ─────────────────────────────────────────────────────
  parts.push('');
  parts.push(
    '> **Workflow:** `pmc get-context <target>` BEFORE reading files · `pmc refresh-context --enrich` after changes.',
  );

  return parts.join('\n');
}

export async function runSessionStart(args = process.argv.slice(2)) {
  const { projectRoot, format } = parseArgs(args);
  const pmcDir = join(projectRoot, '.planning', 'project-memory-context');

  // ── No-op: project has no PMC ────────────────────────────────────────────
  if (!existsSync(pmcDir)) {
    return 0;
  }

  // ── Status report (reuses buildStatusReport from cli/status.mjs) ─────────
  let status;
  try {
    status = await buildStatusReport({ projectRoot });
  } catch {
    return 0; // Don't block startup on status failure
  }

  // ── Launch enrich + watchdog if needed ───────────────────────────────────
  const pending = status.worklist?.pending ?? 0;
  if (pending > 0 && status.state !== 'running') {
    // Detached: inherits full PATH from user shell (unlike Start-Process -WindowStyle Hidden)
    spawnBackground(process.execPath, [ENRICH_SCRIPT, projectRoot], { cwd: projectRoot });
    spawnBackground(process.execPath, [WATCHDOG_SCRIPT, projectRoot], { cwd: projectRoot });
  }

  // ── Sync manifest ─────────────────────────────────────────────────────────
  const enrichmentDir = join(pmcDir, 'enrichment');
  let syncPending = 0;
  try {
    const syncManifest = await readSyncManifest(enrichmentDir);
    syncPending = getPendingEntries(syncManifest).length;
  } catch {}

  // ── Context overview from disk ────────────────────────────────────────────
  const overview = await loadContextOverview(projectRoot).catch(() => '');

  const text = buildOutput({ status, syncPending, overview });

  // ── Emit output ───────────────────────────────────────────────────────────
  if (format === 'claude-code') {
    const payload = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: text,
      },
    };
    process.stdout.write(JSON.stringify(payload) + '\n');
  } else {
    process.stdout.write(text + '\n');
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
  const exitCode = await main().catch(() => 0); // Always exit 0 — never block agent startup
  if (exitCode !== 0) process.exit(exitCode);
}
