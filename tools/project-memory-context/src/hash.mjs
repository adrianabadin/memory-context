// Lazy singleton — xxhash-wasm initializes once
import xxhash from 'xxhash-wasm';

let _initPromise = null;

async function getH64() {
  if (!_initPromise) {
    _initPromise = xxhash().then(m => m.h64ToString);
  }
  return _initPromise;
}

export async function hashSymbol(fragment) {
  return (await getH64())(String(fragment));
}

export async function hashFile(content) {
  return (await getH64())(String(content));
}

export const HASH_VERSION = 'xxh3-1';

// ── N5A (plan 3.5 / S11): narrative fingerprint helpers ─────────────
// narrativeHash = h(code, signature, role, calleeSummaryHashes, promptVersion)
// Callers, symbol names, facts, graph node IDs and hash-version ambient
// metadata are deliberately excluded so caller edits update facts only.

function compareSymbolKeys(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function canonicalJson(value, seen) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('role contains a non-finite number');
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('role contains a circular reference');
    seen.add(value);
    const out = value.map((item) => canonicalJson(item, seen));
    seen.delete(value);
    return out;
  }
  if (type === 'object') {
    if (seen.has(value)) throw new TypeError('role contains a circular reference');
    seen.add(value);
    // Object.fromEntries defines own properties (DefineOwnProperty semantics),
    // so an own '__proto__' key from valid JSON data becomes a real own
    // property instead of invoking the inherited __proto__ setter; sorted key
    // order keeps ordinary serialized output byte-identical.
    const out = Object.fromEntries(
      Object.keys(value)
        .sort(compareSymbolKeys)
        .map((key) => [key, canonicalJson(value[key], seen)]),
    );
    seen.delete(value);
    return out;
  }
  throw new TypeError(`role contains an unsupported value type: ${type}`);
}

function normalizeCalleePairs(input, { paramName, valueField, allowEmptyText }) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError(`${paramName} must be an array of {symbolKey, ${valueField}} pairs or an object map`);
  }
  const pairs = new Map();
  const entries = Array.isArray(input)
    ? input.map((element) => {
        if (element === null || typeof element !== 'object' || Array.isArray(element)) {
          throw new TypeError(`callee ${valueField} entries must be {symbolKey, ${valueField}} objects`);
        }
        return [element.symbolKey, element[valueField]];
      })
    : Object.entries(input);
  for (const [key, value] of entries) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError('callee symbolKey must be a non-empty string');
    }
    if (typeof value !== 'string' || (!allowEmptyText && value.length === 0)) {
      throw new TypeError(`callee ${valueField} must be ${allowEmptyText ? 'a string' : 'a non-empty string'}`);
    }
    if (pairs.has(key) && pairs.get(key) !== value) {
      throw new TypeError(`conflicting duplicate callee ${valueField} for '${key}'`);
    }
    pairs.set(key, value);
  }
  return [...pairs.entries()].sort((a, b) => compareSymbolKeys(a[0], b[0]));
}

/**
 * Narrow N5B-facing derivation of callee summary hashes from summary TEXT
 * (never callee code, full narrative content or stored hash metadata).
 * Exact summary bytes matter, including whitespace and the empty string.
 * Accepts a `{symbolKey: summaryText}` map or a `{symbolKey, summaryText}`
 * pair array; identical duplicates collapse, conflicting duplicates reject.
 *
 * @param {Record<string, string> | Array<{symbolKey: string, summaryText: string}>} calleeSummaries
 * @returns {Promise<Record<string, string>>} `{symbolKey: hash}` with sorted keys
 */
export async function hashCalleeSummaries(calleeSummaries) {
  const texts = normalizeCalleePairs(calleeSummaries, {
    paramName: 'calleeSummaries',
    valueField: 'summaryText',
    allowEmptyText: true,
  });
  const h64 = await getH64();
  return Object.fromEntries(texts.map(([key, text]) => [key, h64(text)]));
}

/**
 * Deterministic narrative fingerprint (accepted formula, v3.md 48):
 * `narrativeHash = h(code, signature, role, calleeSummaryHashes, promptVersion)`.
 * The payload is a JSON array so per-input boundaries make concatenated
 * splits collide-free; `role` is canonicalized with sorted object keys and
 * callee pairs are sorted by symbolKey. Callers, name, facts, graph node
 * IDs, codeHash and hashVersion are not inputs. All five inputs are
 * required; malformed input rejects with `TypeError` before hashing.
 *
 * @param {{code: string, signature: string | null, role: unknown, calleeSummaryHashes: Record<string, string> | Array<{symbolKey: string, hash: string}>, promptVersion: string}} inputs
 * @returns {Promise<string>}
 */
export async function computeNarrativeHash({ code, signature, role, calleeSummaryHashes, promptVersion } = {}) {
  if (typeof code !== 'string') {
    throw new TypeError('code must be a string');
  }
  if (signature !== null && typeof signature !== 'string') {
    throw new TypeError('signature must be a string or null');
  }
  if (typeof promptVersion !== 'string' || promptVersion.length === 0) {
    throw new TypeError('promptVersion must be a non-empty string');
  }
  const canonicalRole = canonicalJson(role, new Set());
  const calleePairs = normalizeCalleePairs(calleeSummaryHashes, {
    paramName: 'calleeSummaryHashes',
    valueField: 'hash',
    allowEmptyText: false,
  });
  const payload = JSON.stringify([code, signature, canonicalRole, calleePairs, promptVersion]);
  return (await getH64())(payload);
}
