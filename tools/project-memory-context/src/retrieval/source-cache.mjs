import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sliceLines } from '../semantic-unit.mjs';

// ── Persistence ────────────────────────────────────────────────────

const CACHE_FILENAME = 'source-cache.json';

/**
 * Load the persisted source-cache from disk.
 * Returns { entries: Record<codeHash, { code, filePath, cachedAt }> }.
 */
export async function loadSourceCache(enrichmentDir) {
  try {
    const raw = await readFile(join(enrichmentDir, CACHE_FILENAME), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed.entries ?? {};
  } catch {
    return {};
  }
}

async function saveSourceCache(enrichmentDir, entries) {
  const path = join(enrichmentDir, CACHE_FILENAME);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ entries, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
}

// ── In-process memoization ─────────────────────────────────────────
// Key: `${filePath}:${startLine}-${endLine}:${mtime}`
const inProcessCache = new Map();

function memoKey(filePath, range, mtime) {
  return `${filePath}:${range.startLine}-${range.endLine}:${mtime}`;
}

// ── Hash ────────────────────────────────────────────────────────────

/**
 * Compute the sha1 hash for a symbol slice — matches regex-extractor.mjs
 * exactly so the hash is comparable to worklist codeHash values.
 */
export function computeCodeHash(code) {
  return createHash('sha1').update(code).digest('hex');
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Get the source code for a symbol, with staleness detection.
 *
 * Modes:
 *  - verified (default): reads the file, slices by range, hashes and compares
 *    to `codeHash`. Persists the result. Returns `{ source: 'disk' }`.
 *  - trust (opt-in via trust: true): looks up the persisted cache by `codeHash`.
 *    If hit, skips the disk read. Returns `{ source: 'cache', verified: false }`.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {string} opts.filePath        — relative to projectRoot
 * @param {{ startLine: number, endLine: number }} opts.range
 * @param {string|null} opts.codeHash   — last-known hash from the worklist
 * @param {string} opts.enrichmentDir   — .planning/.../enrichment dir
 * @param {boolean} [opts.trust]        — use cache without disk read
 *
 * @returns {Promise<SourceResult>}
 */
export async function getSymbolSource({ projectRoot, filePath, range, codeHash, enrichmentDir, trust = false }) {
  if (!filePath || !range) {
    return { code: null, error: 'missing filePath or range', source: null };
  }

  // ── Trust / cache-first path ───────────────────────────────────
  if (trust && codeHash) {
    const entries = await loadSourceCache(enrichmentDir);
    const hit = entries[codeHash];
    if (hit) {
      return {
        code: hit.code,
        currentHash: codeHash,
        expectedHash: codeHash,
        fresh: null,    // not verified against disk
        verified: false,
        source: 'cache',
        filePath,
        range,
      };
    }
    // cache miss in trust mode — fall through to disk read
  }

  // ── Verified / disk path ───────────────────────────────────────
  const absPath = join(projectRoot, filePath);

  let content;
  let mtime;
  try {
    const [fileContent, fileStat] = await Promise.all([
      readFile(absPath, 'utf-8'),
      stat(absPath),
    ]);
    content = fileContent;
    mtime = fileStat.mtimeMs;
  } catch (err) {
    return { code: null, error: `cannot read ${filePath}: ${err.message}`, source: 'disk', filePath, range };
  }

  // In-process memo
  const key = memoKey(filePath, range, mtime);
  if (inProcessCache.has(key)) {
    return inProcessCache.get(key);
  }

  const totalLines = content.split('\n').length;
  if (range.startLine < 1 || range.endLine > totalLines || range.startLine > range.endLine) {
    return {
      code: null,
      error: `range ${range.startLine}-${range.endLine} out of bounds (file has ${totalLines} lines)`,
      source: 'disk',
      filePath,
      range,
    };
  }

  const code = sliceLines(content, range.startLine, range.endLine);
  const currentHash = computeCodeHash(code);
  const fresh = codeHash != null ? currentHash === codeHash : null;

  const result = {
    code,
    currentHash,
    expectedHash: codeHash ?? null,
    fresh,
    verified: true,
    source: 'disk',
    filePath,
    range,
  };

  // Persist to disk cache
  try {
    const entries = await loadSourceCache(enrichmentDir);
    entries[currentHash] = { code, filePath, range, cachedAt: new Date().toISOString() };
    await saveSourceCache(enrichmentDir, entries);
  } catch {
    // Non-fatal — cache is best-effort
  }

  // Memoize in-process
  inProcessCache.set(key, result);

  return result;
}

/**
 * Clear the in-process memoization cache. Mainly for tests.
 */
export function clearInProcessCache() {
  inProcessCache.clear();
}
