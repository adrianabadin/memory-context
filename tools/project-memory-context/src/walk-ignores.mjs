// tools/project-memory-context/src/walk-ignores.mjs
//
// Single source of truth for which project directories should be skipped by
// file walkers (file-hash-store, structure-extractor, and any future walker).
//
// Two rules:
//   1. ALWAYS_IGNORED — explicit name match (works for hidden and non-hidden dirs)
//   2. Hidden-directory default — anything starting with `.` is ignored UNLESS it
//      appears in ALLOWED_HIDDEN_DIRS.
//
// The allowlist exists because PMC indexes source code from these hidden roots:
//   .opencode   — opencode agent / MCP / plugin configuration
//   .planning   — PMC planning artifacts (specs, designs, base memories)
// Anything else starting with `.` (`.git`, `.worktrees`, `.next`, `.vscode`,
// `.idea`, `.playwright-mcp`, etc.) is treated as noise and skipped.

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
]);

const ALLOWED_HIDDEN_DIRS = new Set([
  '.opencode',
  '.planning',
]);

export function shouldIgnoreDir(name) {
  if (ALWAYS_IGNORED.has(name)) return true;
  if (name.startsWith('.')) return !ALLOWED_HIDDEN_DIRS.has(name);
  return false;
}

export const IGNORED_DIRS = ALWAYS_IGNORED;
export const ALLOWED_HIDDEN_DIRS_NAMES = ALLOWED_HIDDEN_DIRS;
