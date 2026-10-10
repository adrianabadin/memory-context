import { readFile, writeFile, rename, copyFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

/**
 * Extract every complete top-level JSON document from a raw string.
 *
 * A corrupted sync-manifest can contain a valid JSON document followed by
 * leftover bytes from an earlier, non-atomic write ("Unexpected non-whitespace
 * character after JSON at position N"). This scanner walks the string tracking
 * bracket depth while respecting string literals and escapes, returning each
 * fully-closed top-level value. A trailing incomplete or malformed value is
 * ignored rather than throwing.
 *
 * @param {string} raw
 * @returns {Array<unknown>}
 */
export function parseConcatenatedManifests(raw) {
  const docs = [];
  const n = raw.length;
  let i = 0;

  while (i < n) {
    while (i < n && isWhitespace(raw[i])) i++;
    if (i >= n) break;

    const startCh = raw[i];
    if (startCh !== '{' && startCh !== '[') {
      // Non-JSON content where a value was expected — cannot recover further.
      break;
    }

    const start = i;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (; i < n; i++) {
      const ch = raw[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{' || ch === '[') {
        depth++;
      } else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }

    if (end === -1) {
      // Unterminated trailing document — stop.
      break;
    }

    try {
      docs.push(JSON.parse(raw.slice(start, end)));
    } catch {
      // A complete-looking slice that still fails to parse means the structure
      // is not trustworthy; stop to avoid misinterpreting data.
      break;
    }
    i = end;
  }

  return docs;
}

function isWhitespace(ch) {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t';
}

function documentEntries(doc) {
  if (Array.isArray(doc)) return doc;
  if (doc && typeof doc === 'object' && Array.isArray(doc.entries)) return doc.entries;
  return null;
}

/**
 * Recover a de-duplicated entry list from a raw (possibly corrupted) manifest.
 *
 * Entries are merged across all recovered documents. Entries sharing an `id`
 * are de-duplicated with last-occurrence winning, so the freshest state for a
 * given entry is preserved. Entries lacking an `id` are kept as-is.
 *
 * @param {string} raw
 * @returns {Array<object>}
 */
export function recoverManifestEntries(raw) {
  const docs = parseConcatenatedManifests(raw);
  const byId = new Map();
  const withoutId = [];
  let sawEntries = false;

  for (const doc of docs) {
    const entries = documentEntries(doc);
    if (!entries) continue;
    sawEntries = true;
    for (const entry of entries) {
      if (entry && typeof entry === 'object' && entry.id != null) {
        byId.set(entry.id, entry);
      } else if (entry && typeof entry === 'object') {
        withoutId.push(entry);
      }
    }
  }

  if (!sawEntries) {
    throw new Error('No recoverable manifest document found in input');
  }

  return [...byId.values(), ...withoutId];
}

/**
 * Repair a sync-manifest file in place.
 *
 * - If the file already parses as a valid manifest, returns without mutation.
 * - Otherwise recovers entries, writes a timestamped backup of the original,
 *   then atomically replaces the file with a single valid manifest.
 * - If nothing can be recovered, throws WITHOUT touching the file.
 *
 * @param {string} filePath
 * @param {object} [deps] injectable fs + clock for testing
 * @returns {Promise<{ repaired: boolean, recovered: number, backupPath: string|null }>}
 */
export async function repairManifestFile(filePath, deps = {}) {
  const readFileImpl = deps.readFile ?? readFile;
  const writeFileImpl = deps.writeFile ?? writeFile;
  const renameImpl = deps.rename ?? rename;
  const copyFileImpl = deps.copyFile ?? copyFile;
  const now = deps.now ?? (() => new Date());

  const raw = await readFileImpl(filePath, 'utf8');

  try {
    const parsed = JSON.parse(raw);
    const entries = documentEntries(parsed);
    if (entries) {
      return { repaired: false, recovered: entries.length, backupPath: null };
    }
  } catch {
    // Fall through to recovery.
  }

  // Throws without mutation when nothing is recoverable.
  const recovered = recoverManifestEntries(raw);

  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${filePath}.bak-${stamp}`;
  await copyFileImpl(filePath, backupPath);

  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFileImpl(tempPath, `${JSON.stringify({ entries: recovered }, null, 2)}\n`, 'utf8');
  await renameImpl(tempPath, filePath);

  return { repaired: true, recovered: recovered.length, backupPath };
}
