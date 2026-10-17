// tools/project-memory-context/src/walk-ignores.mjs
//
// Single source of truth for which project directories should be skipped by
// file walkers (file-hash-store, structure-extractor, sanitize, bootstrap, watcher).
//
// Two rules:
//   1. ALWAYS_IGNORED — explicit name match (works for hidden and non-hidden dirs)
//   2. Hidden-directory default — anything starting with `.` is ignored UNLESS it
//      appears in ALLOWED_HIDDEN_DIRS.
//
// The allowlist exists because PMC indexes configuration from:
//   .opencode   — opencode agent / MCP / plugin configuration
// Non-source scopes like `.planning/**`, `.worktrees/**`, `.git/**`, `graphify-out/**`,
// build outputs, and vendor directories are excluded from code walkers.

const ALWAYS_IGNORED = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'bin',
  'obj',
  'target',
  '.next',
  '.turbo',
  '.vercel',
  'graphify-out',
  '.worktrees',
  '.planning',
  '.git',
]);

const ALLOWED_HIDDEN_DIRS = new Set([
  '.opencode',
]);

export function shouldIgnoreDir(name) {
  if (ALWAYS_IGNORED.has(name)) return true;
  if (name.startsWith('.')) return !ALLOWED_HIDDEN_DIRS.has(name);
  return false;
}

export function isGraphifyScope(name) {
  if (name === 'graphify-out') return true;
  if (name.startsWith('.graphify_')) return true;
  return false;
}

export const IGNORED_DIRS = ALWAYS_IGNORED;
export const ALLOWED_HIDDEN_DIRS_NAMES = ALLOWED_HIDDEN_DIRS;
