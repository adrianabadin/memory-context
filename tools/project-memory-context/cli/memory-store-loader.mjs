// cli/memory-store-loader.mjs
//
// Opens a read-only handle over the agent-memory SQLite database and exposes
// the single method the get-context composition path needs: `getBySymbol`.
//
// Why a bespoke reader instead of importing the compiled agent-memory store?
//   - `getBySymbol` for `sources: ['memory']` is a pure SQL read against the
//     `memories` table — no embedder, no model download, no write path.
//   - The agent-memory `dist/` build can lag behind source (and its full `tsc`
//     build is gated by unrelated CLI files), so importing the compiled store
//     is brittle. `node:sqlite` (already used by graph-db.mjs) is built-in and
//     always available.
//   - Legacy databases that predate the v7 `symbol_key` migration must NOT
//     crash `pmc get-context`; this reader degrades to an empty result set.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Resolve the agent-memory SQLite file path from a project's `.mcp.json`.
 *
 * Path convention (matches agent-memory's createStore): the configured
 * `MEMORY_DB_PATH` is a BASE path; the SQLite file appends `.db`.
 *
 * @param {string} projectRoot
 * @returns {Promise<string|null>} absolute `.db` path, or null when unconfigured.
 */
export async function resolveMemoryDbPath(projectRoot) {
  const mcpPath = resolve(projectRoot, '.mcp.json');
  let raw;
  try {
    raw = JSON.parse(await readFile(mcpPath, 'utf8'));
  } catch {
    return null;
  }

  const base = raw?.mcpServers?.['agent-memory']?.env?.MEMORY_DB_PATH;
  if (!base || typeof base !== 'string') return null;

  return base.endsWith('.db') ? base : `${base}.db`;
}

/**
 * Build a minimal read-only memory store exposing `getBySymbol` + `close`,
 * backed directly by `node:sqlite`.
 *
 * @param {string} dbPath - absolute path to the agent-memory `.db` file.
 * @returns {{ getBySymbol: (symbolKey: string, opts?: { sources?: string[]; limit?: number }) => Promise<Array<{id:string;source:string;symbolKey:string;content:string;createdAt:string}>>, close: () => void }}
 */
export function createSqliteSymbolReader(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  // Tolerate transient WAL lock contention with the main agent process.
  try { db.exec('PRAGMA busy_timeout = 5000'); } catch { /* readonly handles still honor this */ }

  // Detect the v7 `symbol_key` column once. Legacy (pre-v7) databases lack it,
  // in which case getBySymbol returns [] rather than throwing.
  let hasSymbolKey = false;
  try {
    const cols = db.prepare("PRAGMA table_info('memories')").all();
    hasSymbolKey = cols.some((c) => c.name === 'symbol_key');
  } catch {
    hasSymbolKey = false;
  }

  return {
    async getBySymbol(symbolKey, opts = {}) {
      const sources = opts.sources ?? ['memory'];
      const limit = opts.limit ?? 50;
      if (!hasSymbolKey || !sources.includes('memory')) return [];

      try {
        const rows = db
          .prepare('SELECT id, content, created_at FROM memories WHERE symbol_key = ? LIMIT ?')
          .all(symbolKey, limit);
        return rows.map((row) => ({
          id: row.id,
          source: 'memory',
          symbolKey,
          content: row.content,
          createdAt: row.created_at,
        }));
      } catch {
        return [];
      }
    },
    close() {
      try { db.close(); } catch { /* idempotent */ }
    },
  };
}

/**
 * Default production loader: resolve the project's memory DB and open a
 * read-only symbol reader over it.
 *
 * Never throws: when there is no `.mcp.json`, no `MEMORY_DB_PATH`, or the DB
 * file is missing, it returns null so `pmc get-context` runs without a
 * Semantic Memory section instead of failing.
 *
 * @param {string} projectRoot
 * @returns {Promise<{ getBySymbol: Function, close: () => void } | null>}
 */
export async function loadMemoryStore(projectRoot) {
  try {
    const dbPath = await resolveMemoryDbPath(projectRoot);
    if (!dbPath || !existsSync(dbPath)) return null;
    return createSqliteSymbolReader(dbPath);
  } catch {
    return null;
  }
}
