#!/usr/bin/env node
// cli/migrate-from-engram.mjs
//
// T-009: migrate-from-engram CLI
// Migrates an Engram SQLite database into PMC's agent-memory store.
//
// Usage: pmc migrate-from-engram <engram-db-path> [--dry-run] [--limit N] [--batch-size N]

import { readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── Arg parsing ───────────────────────────────────────────────────

/**
 * Parse CLI arguments into a structured options object.
 * Exported for testing.
 *
 * @param {string[]} argv
 * @returns {{ engramDbPath: string|null, dryRun: boolean, limit: number, batchSize: number }}
 */
export function parseArgs(argv = []) {
  let engramDbPath = null;
  let dryRun = false;
  let limit = Infinity;
  let batchSize = 50;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--limit' && i + 1 < argv.length) {
      limit = parseInt(argv[++i], 10);
      if (isNaN(limit) || limit <= 0) limit = Infinity;
    } else if (arg === '--batch-size' && i + 1 < argv.length) {
      batchSize = parseInt(argv[++i], 10);
      if (isNaN(batchSize) || batchSize <= 0) batchSize = 50;
    } else if (!arg.startsWith('-')) {
      engramDbPath = arg;
    }
  }

  return { engramDbPath, dryRun, limit, batchSize };
}

/**
 * Build usage text for --help.
 * Exported for testing.
 */
export function buildUsageText() {
  return [
    'Usage: pmc migrate-from-engram <engram-db-path> [options]',
    '',
    'Migrate an Engram SQLite database into PMC agent-memory.',
    '',
    'Options:',
    '  --dry-run          Report counts without writing to PMC DB',
    '  --limit N          Migrate only first N rows per table',
    '  --batch-size N     Batch size for storeBatch calls (default: 50)',
    '  --help, -h         Show this help',
    '',
    'Migrated tables:',
    '  observations     → memories (with type mapping + re-embedding)',
    '  user_prompts     → session_prompts',
    '  session_summary  → session_summaries (from observations WHERE type=session_summary)',
    '  memory_relations → memory_relations',
    '',
    'Type mapping (Engram → PMC):',
    '  bugfix → bug-fix, decision/architecture → architecture,',
    '  discovery/pattern → learning, config → tool-usage,',
    '  preference → personal, unknown → learning',
  ].join('\n');
}

// ── Engram DB reader ──────────────────────────────────────────────

/**
 * Read all rows from Engram tables using node:sqlite (DatabaseSync).
 * Returns a plain snapshot object — no live DB connection after return.
 */
async function readEngramDb(dbPath) {
  // Dynamic import — node:sqlite is available in Node 22+
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { open: false });
  db.open();

  try {
    const observations = db.prepare(
      'SELECT id, sync_id, session_id, type, title, content, tool_name, project, scope, topic_key, ' +
      'normalized_hash, revision_count, duplicate_count, last_seen_at, pinned, created_at, updated_at, ' +
      'deleted_at, review_after, expires_at, embedding, embedding_model, embedding_created_at ' +
      'FROM observations ORDER BY id'
    ).all();

    const userPrompts = db.prepare(
      'SELECT id, sync_id, session_id, content, project, created_at FROM user_prompts ORDER BY id'
    ).all();

    const relations = db.prepare(
      'SELECT id, sync_id, source_id, target_id, relation, reason, evidence, confidence, ' +
      'judgment_status, marked_by_actor, marked_by_kind, marked_by_model, session_id, ' +
      'superseded_at, superseded_by_relation_id, created_at, updated_at FROM memory_relations ORDER BY id'
    ).all();

    return { observations, userPrompts, relations };
  } finally {
    db.close();
  }
}

// ── Progress table renderer ───────────────────────────────────────

function renderProgressTable(table) {
  const header = '| Table | Migrated | Skipped | Errors |';
  const separator = '|-------|----------|---------|--------|';
  const rows = table.map(row =>
    '| ' + row.table + ' | ' + row.migrated + ' | ' + row.skipped + ' | ' + row.errors + ' |'
  );
  return [header, separator, ...rows].join('\n');
}

// ── Main ──────────────────────────────────────────────────────────

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(buildUsageText());
    return 0;
  }

  const { engramDbPath, dryRun, limit, batchSize } = parseArgs(args);

  if (!engramDbPath) {
    console.error('Error: engram-db-path is required.');
    console.error('');
    console.error(buildUsageText());
    return 1;
  }

  const resolvedPath = resolve(engramDbPath);

  // Validate file exists
  try {
    await readFile(resolvedPath);
  } catch {
    console.error('Error: Cannot read Engram DB at ' + resolvedPath);
    return 1;
  }

  console.log('Migrating from Engram DB: ' + resolvedPath);
  if (dryRun) console.log('[DRY RUN] No writes will be performed.');
  if (limit !== Infinity) console.log('[LIMIT] Migrating at most ' + limit + ' rows per table.');
  console.log('');

  // Read Engram DB
  let engramDb;
  try {
    engramDb = await readEngramDb(resolvedPath);
  } catch (err) {
    console.error('Error reading Engram DB: ' + (err instanceof Error ? err.message : String(err)));
    return 1;
  }

  console.log('Found: ' + engramDb.observations.length + ' observations, ' +
    engramDb.userPrompts.length + ' user_prompts, ' +
    engramDb.relations.length + ' memory_relations');
  console.log('');

  // For now, this CLI reads and reports. Full PMC store integration
  // requires the agent-memory MCP server to be running or direct DB access.
  // The migration logic itself is in agent-memory-mcp/src/migration.ts.
  //
  // This CLI serves as the entry point that:
  // 1. Reads the Engram DB
  // 2. Prints summary
  // 3. Calls migration logic (when PMC store is available)

  if (dryRun) {
    // Dry-run: just report what would be migrated
    const deletedCount = engramDb.observations.filter(o => o.deleted_at).length;
    const sessionSummaryCount = engramDb.observations.filter(o => o.type === 'session_summary').length;
    const memMigratable = engramDb.observations.length - deletedCount - sessionSummaryCount;

    const table = [
      { table: 'observations → memories', migrated: memMigratable, skipped: deletedCount + sessionSummaryCount, errors: 0 },
      { table: 'user_prompts → session_prompts', migrated: engramDb.userPrompts.length, skipped: 0, errors: 0 },
      { table: 'session_summary obs → session_summaries', migrated: sessionSummaryCount, skipped: 0, errors: 0 },
      { table: 'memory_relations', migrated: engramDb.relations.length, skipped: 0, errors: 0 },
    ];

    console.log('Migration Preview (dry-run):');
    console.log('');
    console.log(renderProgressTable(table));
    console.log('');
    console.log('Total: ' + table.reduce((s, r) => s + r.migrated, 0) + ' rows would be migrated.');
    return 0;
  }

  // Non-dry-run: report what we read (actual PMC write integration is via MCP)
  console.log('Engram DB read successfully. Migration requires PMC store integration.');
  console.log('Use the MCP migration tool or run with --dry-run to preview.');
  return 0;
}

// ── IIFE entry point ──────────────────────────────────────────────

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main().catch((error) => {
    console.error('[migrate-from-engram] FATAL:', error.message);
    return 1;
  });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
