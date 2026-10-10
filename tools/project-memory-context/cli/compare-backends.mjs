#!/usr/bin/env node
// cli/compare-backends.mjs
//
// T-010: compare-backends CLI
// Validates migration completeness by comparing Engram and PMC databases.
//
// Usage: pmc compare-backends --engram-db <path> --pmc-db <path> [--window-minutes N] [--query <csv>]

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Arg parsing ───────────────────────────────────────────────────

/**
 * Parse CLI arguments into a structured options object.
 * Exported for testing.
 *
 * @param {string[]} argv
 * @returns {{ engramDbPath: string|null, pmcDbPath: string|null, windowMinutes: number|null, queries: string[] }}
 */
export function parseArgs(argv = []) {
  let engramDbPath = null;
  let pmcDbPath = null;
  let windowMinutes = null;
  let queries = ['auth', 'config', 'fix', 'decision', 'error'];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--engram-db' && i + 1 < argv.length) {
      engramDbPath = argv[++i];
    } else if (arg === '--pmc-db' && i + 1 < argv.length) {
      pmcDbPath = argv[++i];
    } else if (arg === '--window-minutes' && i + 1 < argv.length) {
      const val = parseInt(argv[++i], 10);
      if (!isNaN(val) && val > 0) windowMinutes = val;
    } else if (arg === '--query' && i + 1 < argv.length) {
      queries = argv[++i].split(',').map(q => q.trim()).filter(Boolean);
    }
  }

  return { engramDbPath, pmcDbPath, windowMinutes, queries };
}

/**
 * Build usage text for --help.
 * Exported for testing.
 */
export function buildUsageText() {
  return [
    'Usage: pmc compare-backends --engram-db <path> --pmc-db <path> [options]',
    '',
    'Compare Engram and PMC databases to validate migration completeness.',
    '',
    'Options:',
    '  --engram-db <path>       Path to Engram SQLite database',
    '  --pmc-db <path>          Path to PMC agent-memory SQLite database',
    '  --window-minutes N       Only compare memories created in last N minutes',
    '  --query <csv>            Comma-separated search queries (default: auth,config,fix,decision,error)',
    '  --help, -h               Show this help',
    '',
    'Output:',
    '  Structured drift report with overlap count, drift counts,',
    '  average cosine similarity of matched pairs, and side-by-side',
    '  top-5 results for each query.',
    '',
    'Examples:',
    '  pmc compare-backends --engram-db ~/.engram/engram.db --pmc-db ~/.pmc/memory.db',
    '  pmc compare-backends --engram-db e.db --pmc-db p.db --window-minutes 60',
    '  pmc compare-backends --engram-db e.db --pmc-db p.db --query "auth,jwt,token"',
  ].join('\n');
}

// ── Comparison logic (inline — avoids cross-package import issues) ─

const COSINE_MATCH_THRESHOLD = 0.7;
const TOP_K = 5;

function embeddingToVec(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const view = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(view);
}

function cosineDistance(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return magA && magB ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
}

function queryEngram(db, query, windowMinutes) {
  let sql = `SELECT id, content, embedding, title, created_at FROM observations WHERE deleted_at IS NULL AND type != 'session_summary'`;
  const params = [];

  if (windowMinutes != null) {
    const cutoff = new Date(Date.now() - windowMinutes * 60_000).toISOString();
    sql += ` AND created_at > ?`;
    params.push(cutoff);
  }

  if (query && query.trim()) {
    sql += ` AND (content LIKE ? OR title LIKE ?)`;
    const pattern = `%${query}%`;
    params.push(pattern, pattern);
  }

  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(TOP_K * 3);

  return db.prepare(sql).all(...params);
}

function queryPmc(db, query, windowMinutes) {
  let sql = `SELECT m.id, m.content, e.embedding, m.created_at
             FROM memories m
             LEFT JOIN memory_embeddings e ON e.id = m.id
             WHERE m.status = 'active'`;
  const params = [];

  if (windowMinutes != null) {
    const cutoff = new Date(Date.now() - windowMinutes * 60_000).toISOString();
    sql += ` AND m.created_at > ?`;
    params.push(cutoff);
  }

  if (query && query.trim()) {
    sql += ` AND m.content LIKE ?`;
    params.push(`%${query}%`);
  }

  sql += ` ORDER BY m.created_at DESC LIMIT ?`;
  params.push(TOP_K * 3);

  return db.prepare(sql).all(...params);
}

function countMemories(db, windowMinutes, isEngram) {
  let sql;
  const params = [];

  if (isEngram) {
    sql = `SELECT COUNT(*) as cnt FROM observations WHERE deleted_at IS NULL AND type != 'session_summary'`;
    if (windowMinutes != null) {
      const cutoff = new Date(Date.now() - windowMinutes * 60_000).toISOString();
      sql += ` AND created_at > ?`;
      params.push(cutoff);
    }
  } else {
    sql = `SELECT COUNT(*) as cnt FROM memories WHERE status = 'active'`;
    if (windowMinutes != null) {
      const cutoff = new Date(Date.now() - windowMinutes * 60_000).toISOString();
      sql += ` AND created_at > ?`;
      params.push(cutoff);
    }
  }

  return db.prepare(sql).get(...params).cnt;
}

function matchPairs(engramRows, pmcRows) {
  const matchedPmc = new Set();
  let overlap = 0;
  let totalCosine = 0;
  let pairs = 0;

  for (const eRow of engramRows) {
    if (!eRow.embedding) continue;
    const eVec = embeddingToVec(eRow.embedding);
    let bestSim = 0;
    let bestIdx = -1;

    for (let i = 0; i < pmcRows.length; i++) {
      if (matchedPmc.has(i)) continue;
      const pRow = pmcRows[i];
      if (!pRow.embedding) continue;
      const pVec = embeddingToVec(pRow.embedding);
      const sim = cosineDistance(eVec, pVec);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }

    if (bestSim >= COSINE_MATCH_THRESHOLD && bestIdx >= 0) {
      overlap++;
      matchedPmc.add(bestIdx);
      totalCosine += bestSim;
      pairs++;
    }
  }

  return {
    overlap,
    engramOnly: engramRows.length - overlap,
    pmcOnly: pmcRows.length - matchedPmc.size,
    avgCosine: totalCosine,
    pairs,
  };
}

function renderTable(result) {
  const lines = [];
  lines.push('╔══════════════════════════════════════════════════════════╗');
  lines.push('║           Backend Comparison — Drift Report             ║');
  lines.push('╠══════════════════════════════════════════════════════════╣');
  lines.push(`║ Engram memories:  ${String(result.total_engram_memories).padStart(6)}                             ║`);
  lines.push(`║ PMC memories:     ${String(result.total_pmc_memories).padStart(6)}                             ║`);
  lines.push('╠══════════════════════════════════════════════════════════╣');
  lines.push(`║ Overlap (matched):   ${String(result.overlap_count).padStart(4)}                             ║`);
  lines.push(`║ Engram-only (drift): ${String(result.engram_only_count).padStart(4)}                             ║`);
  lines.push(`║ PMC-only (new):      ${String(result.pmc_only_count).padStart(4)}                             ║`);
  lines.push(`║ Avg cosine matched:  ${result.avg_cosine_matched.toFixed(4).padStart(6)}                           ║`);
  lines.push('╚══════════════════════════════════════════════════════════╝');
  lines.push('');

  for (const qr of result.results) {
    lines.push(`── Query: "${qr.query}" ──`);
    lines.push(`  Matched in both: ${qr.matched_in_both}`);
    lines.push('  Engram top-5:');
    for (let i = 0; i < qr.engram_top5.length; i++) {
      const r = qr.engram_top5[i];
      lines.push(`    ${i + 1}. [${r.id}] ${r.content.slice(0, 80)}...`);
    }
    lines.push('  PMC top-5:');
    for (let i = 0; i < qr.pmc_top5.length; i++) {
      const r = qr.pmc_top5[i];
      lines.push(`    ${i + 1}. [${r.id}] ${r.content.slice(0, 80)}...`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(buildUsageText());
    return 0;
  }

  const { engramDbPath, pmcDbPath, windowMinutes, queries } = parseArgs(args);

  if (!engramDbPath) {
    console.error('Error: --engram-db is required.');
    console.error('');
    console.error(buildUsageText());
    return 1;
  }

  if (!pmcDbPath) {
    console.error('Error: --pmc-db is required.');
    console.error('');
    console.error(buildUsageText());
    return 1;
  }

  // Validate files exist
  const engramResolved = resolve(engramDbPath);
  const pmcResolved = resolve(pmcDbPath);

  try {
    await readFile(engramResolved);
  } catch {
    console.error('Error: Cannot read Engram DB at ' + engramResolved);
    return 1;
  }

  try {
    await readFile(pmcResolved);
  } catch {
    console.error('Error: Cannot read PMC DB at ' + pmcResolved);
    return 1;
  }

  console.log('Comparing backends:');
  console.log('  Engram: ' + engramResolved);
  console.log('  PMC:    ' + pmcResolved);
  if (windowMinutes) console.log('  Window: last ' + windowMinutes + ' minutes');
  console.log('  Queries: ' + queries.join(', '));
  console.log('');

  // Open both DBs
  const { DatabaseSync } = await import('node:sqlite');
  const engramDb = new DatabaseSync(engramResolved, { open: false });
  engramDb.open();
  const pmcDb = new DatabaseSync(pmcResolved, { open: false });
  pmcDb.open();

  try {
    const totalEngram = countMemories(engramDb, windowMinutes, true);
    const totalPmc = countMemories(pmcDb, windowMinutes, false);

    let totalOverlap = 0;
    let totalEngramOnly = 0;
    let totalPmcOnly = 0;
    let totalCosine = 0;
    let totalPairs = 0;
    const queryResults = [];

    for (const query of queries) {
      const engramRows = queryEngram(engramDb, query, windowMinutes);
      const pmcRows = queryPmc(pmcDb, query, windowMinutes);

      const matched = matchPairs(engramRows.slice(0, TOP_K), pmcRows.slice(0, TOP_K));
      totalOverlap += matched.overlap;
      totalEngramOnly += matched.engramOnly;
      totalPmcOnly += matched.pmcOnly;
      totalCosine += matched.avgCosine;
      totalPairs += matched.pairs;

      queryResults.push({
        query,
        engram_top5: engramRows.slice(0, TOP_K).map(r => ({
          id: String(r.id),
          content: (r.content || '').slice(0, 200),
          score: 1.0,
        })),
        pmc_top5: pmcRows.slice(0, TOP_K).map(r => ({
          id: r.id,
          content: (r.content || '').slice(0, 200),
          score: 1.0,
        })),
        matched_in_both: matched.overlap,
      });
    }

    const result = {
      total_engram_memories: totalEngram,
      total_pmc_memories: totalPmc,
      overlap_count: totalOverlap,
      engram_only_count: totalEngramOnly,
      pmc_only_count: totalPmcOnly,
      avg_cosine_matched: totalPairs > 0 ? totalCosine / totalPairs : 0,
      results: queryResults,
    };

    console.log(renderTable(result));
    return 0;
  } finally {
    engramDb.close();
    pmcDb.close();
  }
}

// ── IIFE entry point ──────────────────────────────────────────────

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await main().catch((error) => {
    console.error('[compare-backends] FATAL:', error.message);
    return 1;
  });

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
