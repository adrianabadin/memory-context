// Prompt v2 (accepted plan 3.3 / spec S9): narrative prompts are assembled
// exclusively from caller-owned, authoritative context — GraphStore reads,
// symbol-index entries and declared project rules supplied by the caller.
// This module performs no I/O and never derives AST or graph facts from names.
import { NARRATIVE_SCHEMA } from './narrative-schema.mjs';

// Exported for narrativeHash computation (plan 3.5) and queue/subagent transport.
export const PROMPT_VERSION = 'v2';

const ENGLISH_INSTRUCTION =
  'Write all descriptive explanation fields in English, regardless of source comments or conversation language. Preserve code, identifiers, paths, tags and structured keys exactly.';

const MAX_TOP_CALLERS = 5;

/**
 * Canonical symbol-key recognition mirrors src/symbol-keys.mjs `buildSymbolKey`
 * structurally and never rewrites a key:
 *   generic: language|filePath|kind|exportScope|name|arity   (6 parts, numeric arity)
 *   csharp:  csharp|filePath|namespace|containerName|kind|name|signature (7 parts)
 * In the csharp form `namespace` and `containerName` are optional builder
 * fields: an explicit empty string survives `?? 'global'` / `?? 'none'`
 * byte-exact, so those two parts may be empty. Every other part is required.
 * Raw Graphify IDs (numeric or `node_*` strings), other unstructured strings,
 * and keys with edge whitespace are not canonical symbol keys.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCanonicalSymbolKey(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.trim() !== value) return false;

  const parts = value.split('|');
  if (parts.length === 6) {
    const [language, filePath, kind, exportScope, name, arity] = parts;
    return Boolean(language && filePath && kind && exportScope && name) && /^\d+$/.test(arity);
  }
  if (parts.length === 7 && parts[0] === 'csharp') {
    const filePath = parts[1];
    const kind = parts[4];
    const name = parts[5];
    const signature = parts[6];
    return Boolean(filePath && kind && name && signature);
  }
  return false;
}

/**
 * Explicitly supplied context lists must be arrays. Absent (`undefined`) lists
 * stay optional; a present but malformed shape rejects instead of silently
 * rendering as an empty section (N3 correction B3).
 */
function requireList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError(`narrativeContext.${field} must be an array`);
  }
  return value;
}

function usableEntry(entry) {
  return Boolean(entry) && typeof entry === 'object' && !entry.ambiguous;
}

function firstLine(value) {
  const [line = ''] = String(value).split('\n');
  return line.trim();
}

/**
 * Normalize the caller-supplied authoritative symbol-key collection.
 * Absent keys normalize to an empty set (fail-closed for mention checks);
 * explicit null, non-list shapes, and non-canonical entries (raw graph IDs,
 * numeric IDs, whitespace-munged keys) reject before any generation or
 * persistence instead of being silently accepted or dropped.
 *
 * @param {Set<string>|string[]|undefined} value
 * @returns {Set<string>}
 */
export function normalizeSymbolKeys(value) {
  if (value === undefined) return new Set();
  const list = value instanceof Set ? [...value] : Array.isArray(value) ? [...value] : null;
  if (!list) {
    throw new TypeError('symbolKeys must be a Set or an array of canonical graph symbol keys');
  }
  for (const key of list) {
    if (typeof key !== 'string' || !key) {
      throw new TypeError('symbolKeys entries must be non-empty strings');
    }
    if (!isCanonicalSymbolKey(key)) {
      throw new TypeError(`symbolKeys entries must be canonical graph symbol keys: ${key}`);
    }
  }
  return new Set(list);
}

function renderRole(role) {
  if (!role || typeof role !== 'object' || Array.isArray(role) || role.ambiguous) {
    return 'Role: (unclassified)';
  }
  if (typeof role.role !== 'string' || !role.role.trim()) {
    return 'Role: (unclassified)';
  }
  const parts = [];
  if (typeof role.layer === 'string' && role.layer.trim()) parts.push(`layer: ${role.layer}`);
  if (typeof role.confidence === 'number') parts.push(`confidence: ${role.confidence}`);
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `Role: ${role.role.trim()}${suffix}`;
}

function renderCallees(value) {
  const lines = [];
  for (const entry of requireList(value, 'callees')) {
    if (!usableEntry(entry)) continue;
    if (!isCanonicalSymbolKey(entry.key)) continue;
    if (typeof entry.summary !== 'string' || !entry.summary.trim()) continue;
    lines.push(`- ${entry.key}: ${firstLine(entry.summary)}`);
  }
  return lines;
}

function renderCallers(value) {
  const lines = [];
  for (const entry of requireList(value, 'callers')) {
    if (lines.length >= MAX_TOP_CALLERS) break;
    if (!usableEntry(entry)) continue;
    if (!isCanonicalSymbolKey(entry.key)) continue;
    if (typeof entry.name !== 'string' || !entry.name.trim()) continue;
    const role = typeof entry.role === 'string' && entry.role.trim() ? entry.role.trim() : 'unclassified';
    lines.push(`- ${entry.name.trim()} — role: ${role}`);
  }
  return lines;
}

function renderRules(value) {
  return requireList(value, 'projectRules')
    .filter((rule) => typeof rule === 'string' && rule.trim())
    .map((rule) => `- ${rule.trim()}`);
}

/**
 * Build the v2 narrative prompt from explicit caller-owned context.
 *
 * Every rendered context entry must carry a canonical symbol key; unkeyed,
 * raw-ID, ambiguous or malformed nodes are withheld rather than guessed.
 * Malformed explicit list shapes and non-canonical authoritative key
 * collections reject with TypeError before any generation or persistence.
 * Callers keep their supplied deterministic order, honestly labeled as not
 * semantically ranked, and at most {@link MAX_TOP_CALLERS} are rendered.
 *
 * @param {object} input
 * @param {object} input.symbol           - worklist symbol entry (name/kind/language/filePath/range)
 * @param {string} input.codeSection      - exact source slice for the symbol range
 * @param {string} [input.importsSection] - import lines above the symbol
 * @param {object} input.narrativeContext - authoritative caller-supplied context
 * @returns {{promptVersion: string, prompt: string}}
 */
export function buildNarrativePromptV2({ symbol, codeSection = '', importsSection = '', narrativeContext } = {}) {
  if (!narrativeContext || typeof narrativeContext !== 'object' || Array.isArray(narrativeContext)) {
    throw new TypeError('narrativeContext must be an object');
  }

  const context = narrativeContext;
  const signature = typeof context.signature === 'string' && context.signature.trim()
    ? context.signature.trim()
    : firstLine(codeSection) || '(not available)';
  const fileCardSummary = typeof context.fileCardSummary === 'string' && context.fileCardSummary.trim()
    ? context.fileCardSummary.trim()
    : '(not available)';

  const calleeLines = renderCallees(context.callees);
  const callerLines = renderCallers(context.callers);
  const ruleLines = renderRules(context.projectRules);
  const mentionableKeys = [...normalizeSymbolKeys(context.symbolKeys)];

  const prompt = [
    `Symbol: ${symbol.name}`,
    `Kind: ${symbol.kind}`,
    `Language: ${symbol.language}`,
    `Location: ${symbol.filePath}:${symbol.range.startLine}-${symbol.range.endLine}`,
    `Prompt version: ${PROMPT_VERSION}`,
    renderRole(context.role),
    `Signature: ${signature}`,
    '',
    'Callee one-line summaries (canonical symbol keys):',
    calleeLines.length > 0 ? calleeLines.join('\n') : '(none)',
    '',
    `Top callers (at most ${MAX_TOP_CALLERS}; caller-supplied deterministic order, not ranked by semantic importance):`,
    callerLines.length > 0 ? callerLines.join('\n') : '(none)',
    '',
    'File card summary:',
    fileCardSummary,
    '',
    'Relevant project rules:',
    ruleLines.length > 0 ? ruleLines.join('\n') : '(none declared)',
    '',
    'Context (imports):',
    importsSection || '(none)',
    '',
    'Code:',
    codeSection,
    '',
    'Output contract: reply with a single JSON object that matches this schema exactly (no prose outside JSON):',
    JSON.stringify(NARRATIVE_SCHEMA, null, 2),
    '',
    'Mentionable symbol keys (every "mentions" entry must be one of these canonical keys):',
    mentionableKeys.length > 0 ? mentionableKeys.map((key) => `- ${key}`).join('\n') : '(none)',
    '',
    ENGLISH_INSTRUCTION,
  ].join('\n');

  return { promptVersion: PROMPT_VERSION, prompt };
}
