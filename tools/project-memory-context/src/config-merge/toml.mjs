import { readFile } from 'node:fs/promises';
import { parse, stringify } from 'smol-toml';

import { writeAtomic } from './atomic-write.mjs';

const START_MARKER_PREFIX = '# pmc:';
const END_MARKER_PREFIX = '# /pmc:';

export function isParseFailure(err) {
  if (!err) return false;
  if (err instanceof Error) {
    if (err.name === 'TomlError' || err.name === 'SyntaxError') return true;
    return typeof err.message === 'string' && /TOML/i.test(err.message);
  }
  return false;
}

export function parseToml(text) {
  return parse(text);
}

export function stringifyToml(value) {
  return stringify(value);
}

function findMarkerRange(content, markerName) {
  const startToken = `${START_MARKER_PREFIX}${markerName}`;
  const endToken = `${END_MARKER_PREFIX}${markerName}`;

  // Anchor each match on its own line so unrelated `# pmc:` comments cannot be confused.
  const startRe = new RegExp(`^${escapeRegExp(startToken)}\\s*$`, 'm');
  const endRe = new RegExp(`^${escapeRegExp(endToken)}\\s*$`, 'm');

  const startMatch = startRe.exec(content);
  if (!startMatch) return { exists: false };
  const startIndex = startMatch.index;

  const endMatch = endRe.exec(content);
  if (!endMatch) return { exists: false };

  const endIndex = endMatch.index;
  if (endIndex < startIndex) return { exists: false };

  return {
    exists: true,
    startIndex,
    endIndex,
    endTokenLength: endToken.length,
    leading: content.slice(0, startIndex),
    trailing: content.slice(endIndex + endToken.length),
  };
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wrapBlock(markerName, blockBody) {
  const trimmed = blockBody.replace(/^\n+/, '').replace(/\n+$/, '');
  return `${START_MARKER_PREFIX}${markerName}\n${trimmed}\n${END_MARKER_PREFIX}${markerName}\n`;
}

/**
 * spliceBlockIntoMarker replaces (or appends) a `# pmc:<marker>` … `# /pmc:<marker>`
 * delimited block while preserving every byte outside the block.
 *
 * Returns the candidate new content. Caller is responsible for atomic write and for
 * validating that the candidate still parses as TOML.
 */
export function spliceBlockIntoMarker(existingContent, blockBody, markerName) {
  const range = findMarkerRange(existingContent, markerName);

  if (range.exists) {
    const block = wrapBlock(markerName, blockBody);
    return `${range.leading}${block}${range.trailing.replace(/^\n+/, '')}`;
  }

  if (existingContent.trim().length === 0) {
    return wrapBlock(markerName, blockBody);
  }

  const separator = existingContent.endsWith('\n') ? '' : '\n';
  return `${existingContent}${separator}\n${wrapBlock(markerName, blockBody)}`;
}

async function readUtf8Safe(filePath) {
  try {
    return { content: await readFile(filePath, 'utf8') };
  } catch (err) {
    if (err?.code === 'ENOENT') return { content: '' };
    throw err;
  }
}

function validateParsesOrThrow(text) {
  // A throw from smol-toml is the validation signal; we re-raise the same error
  // so callers can use `isParseFailure` to decide between malformed / IO failure.
  return parse(text);
}

/**
 * mergeTomlConfig replaces the PMC-owned marker block in `filePath` with a
 * freshly stringified version of `ownedValue` (typically the full PMC section,
 * e.g. `{ mcp_servers: { 'pmc-query': {...} } }`). The merge guarantees:
 *   - Malformed existing TOML is reported via `{ malformed: true }` and never
 *     overwritten (byte-identical preserved).
 *   - Unowned keys, comments, ordering, and unrelated `[tables]` outside the
 *     PMC-owned block survive verbatim.
 *   - The post-splice content is re-parsed through smol-toml; a parse failure
 *     surfaces as `{ malformed: true }` (defensive — should not happen given
 *     we stringify via smol-toml).
 *   - Second merge with identical input returns `{ status: 'unchanged' }`.
 */
export async function mergeTomlConfig(filePath, ownedValue, markerName = 'mcp') {
  const existing = await readUtf8Safe(filePath);
  if (existing.content.length > 0) {
    try {
      validateParsesOrThrow(existing.content);
    } catch (err) {
      return { malformed: true };
    }
  }

  const blockBody = stringify(ownedValue ?? {});
  const candidate = spliceBlockIntoMarker(existing.content, blockBody, markerName);

  try {
    validateParsesOrThrow(candidate);
  } catch (err) {
    return { malformed: true };
  }

  if (candidate === existing.content) {
    return { status: 'unchanged' };
  }

  await writeAtomic(filePath, candidate);
  return { status: 'installed' };
}

/**
 * mergeTomlBlock splices a verbatim (already-rendered) block into the marker,
 * preserving the same isolation guarantees as mergeTomlConfig. Useful when the
 * caller wants full control of the rendered TOML (e.g. hooks writer).
 */
export async function mergeTomlBlock(filePath, blockBody, markerName = 'mcp') {
  const existing = await readUtf8Safe(filePath);
  if (existing.content.length > 0) {
    try {
      validateParsesOrThrow(existing.content);
    } catch (err) {
      return { malformed: true };
    }
  }

  const candidate = spliceBlockIntoMarker(existing.content, blockBody, markerName);

  try {
    validateParsesOrThrow(candidate);
  } catch (err) {
    return { malformed: true };
  }

  if (candidate === existing.content) {
    return { status: 'unchanged' };
  }

  await writeAtomic(filePath, candidate);
  return { status: 'installed' };
}
