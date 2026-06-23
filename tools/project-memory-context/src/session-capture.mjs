// tools/project-memory-context/src/session-capture.mjs
// OpenCode session-capture hooks + synchronous JSONL queue.
//
// Secret-redaction patterns (applied BEFORE any queue write):
//   1. Chat content: `<private>...</private>` segments are replaced with the
//      literal `[REDACTED]` (case-insensitive, dot-all). This matches the
//      convention used by agents that wrap sensitive spans in <private> tags.
//   2. Tool args: every key whose lowercase name CONTAINS one of the sensitive
//      fragments — `authorization`, `api_key`, `apikey`, `password`, `secret`,
//      `token` — has its value replaced with `***REDACTED***`. Matching is
//      recursive (arrays + nested objects) and depth-capped at 5 to bound
//      traversal. A JSON-string `args` value is parsed first; a non-JSON
//      string is passed through untouched (never throws).
//   3. Tool results: bounded to a 200-char `resultSummary`; the full result is
//      NOT queued, so large/secrets-bearing payloads are truncated before they
//      ever reach disk.
//
// The queue file (`pmc-capture-queue.jsonl`) is appended synchronously
// (`appendFileSync`) so a process crash mid-session cannot lose already-captured
// rows. Rotation triggers at 1 MiB: the live file is renamed to
// `pmc-capture-queue.<timestamp>.jsonl` and a fresh live file starts. The
// drainer reads rotated archives oldest-first (see cli/capture-drain.mjs).
import { appendFileSync, statSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Build OpenCode capture hooks for a session.
 *
 * @param {string} sessionId - Active session identifier.
 * @param {string} projectId - Project identifier (falls back to 'unknown').
 * @param {string} queuePath - Absolute path to the JSONL queue file.
 * @returns {{ 'chat.message': Function, 'tool.execute.after': Function }}
 */
export function buildHooks(sessionId, projectId, queuePath) {
  const sid = sessionId || 'unknown';
  const pid = projectId || 'unknown';
  return {
    'chat.message': (event) => {
      const content = sanitizeContent(event.content || '');
      appendToQueue(queuePath, {
        type: 'prompt',
        ts: Date.now(),
        sessionId: sid,
        projectId: pid,
        content,
        role: event.role || 'user',
      });
    },
    'tool.execute.after': (event) => {
      appendToQueue(queuePath, {
        type: 'tool_call',
        ts: Date.now(),
        sessionId: sid,
        projectId: pid,
        toolName: event.tool || event.toolName,
        argsSafe: sanitizeArgs(event.args || {}),
        resultSummary: summarize(event.result, 200),
        durationMs: event.durationMs || 0,
        importance: event.importance || 'normal',
      });
    },
  };
}

/**
 * Append a capture entry to the JSONL queue, rotating when size >= 1MB.
 *
 * @param {string} queuePath - Path to `pmc-capture-queue.jsonl`.
 * @param {object} entry - Capture entry object.
 */
export function appendToQueue(queuePath, entry) {
  const dir = dirname(queuePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (existsSync(queuePath)) {
    const size = statSync(queuePath).size;
    if (size >= 1_048_576) {
      const ts = Date.now();
      renameSync(queuePath, queuePath.replace('.jsonl', `.${ts}.jsonl`));
    }
  }
  appendFileSync(queuePath, JSON.stringify(entry) + '\n');
}

/**
 * Strip `<private>...</private>` segments from chat content.
 *
 * @param {string} text - Raw message content.
 * @returns {string} Content with private segments replaced by `[REDACTED]`.
 */
export function sanitizeContent(text) {
  return String(text).replace(/<private>[\s\S]*?<\/private>/gi, '[REDACTED]');
}

/**
 * Sanitize tool arguments by masking sensitive fields recursively.
 *
 * @param {object|string} args - Tool arguments (object or JSON string).
 * @returns {string} JSON string with sensitive values redacted.
 */
export function sanitizeArgs(args) {
  const sensitive = ['authorization', 'api_key', 'apikey', 'password', 'secret', 'token'];
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return args;
    }
  }
  return JSON.stringify(maskSensitive(args, sensitive));
}

/**
 * Recursively mask sensitive keys in an object tree (depth-capped).
 *
 * @param {object} obj - Value to mask.
 * @param {string[]} keys - Lowercase sensitive key fragments.
 * @param {number} depth - Current nesting depth.
 * @returns {object} Masked copy.
 */
function maskSensitive(obj, keys, depth = 0) {
  if (depth > 5 || !obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((v) => maskSensitive(v, keys, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (keys.some((sk) => k.toLowerCase().includes(sk))) {
      out[k] = '***REDACTED***';
    } else {
      out[k] = maskSensitive(v, keys, depth + 1);
    }
  }
  return out;
}

/**
 * Produce a bounded summary string of a tool result.
 *
 * @param {string|object} result - Tool result.
 * @param {number} maxLen - Maximum length before truncation.
 * @returns {string}
 */
function summarize(result, maxLen) {
  const s = typeof result === 'string' ? result : JSON.stringify(result);
  return s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
}