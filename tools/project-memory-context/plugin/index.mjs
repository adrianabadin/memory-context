// tools/project-memory-context/plugin/index.mjs
// OpenCode plugin entrypoint. OpenCode auto-loads named exports from
// .opencode/plugins/*.mjs; the generated wrapper there re-exports PMCPlugin.
//
// The plugin has TWO responsibilities that run side by side every session:
//   1. (W1) Session-start runtime — reads disk state, spawns detached
//      enrichment / refresh / watcher processes, and writes the session-start
//      snapshot. This MUST continue to work unchanged alongside capture.
//   2. Session capture — builds OpenCode hooks (`chat.message`,
//      `tool.execute.after`) that synchronously append prompts and tool calls
//      to a JSONL queue, then spawns a detached `capture-drain.mjs` process
//      that persists the queue to the agent-memory session ledger off the
//      agent's hot path.
//
// Startup only reads disk state and spawns detached processes — it must never
// block or break OpenCode initialization. The capture spawn is also detached
// and `unref`'d (see `spawnBackground`), so it never blocks the plugin return.
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runSessionStartRuntime } from '../src/session-start-runtime.mjs';
import { spawnBackground } from '../src/platform.mjs';
import { buildHooks as defaultBuildHooks } from '../src/session-capture.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRAINER_PATH = join(__dirname, '..', 'cli', 'capture-drain.mjs');

/**
 * OpenCode PMC plugin.
 *
 * Wires together the existing session-start runtime (W1 — preserved) with the
 * session-capture hooks + background drainer. Returns `{ hooks }` so OpenCode
 * registers `chat.message` and `tool.execute.after` handlers that append to
 * `.opencode/pmc-capture-queue.jsonl`; a detached `capture-drain.mjs` process
 * later persists the queue to the agent-memory session ledger.
 *
 * @param {object} [input]
 * @param {string} [input.directory] - Project root (legacy alias of `projectRoot`).
 * @param {string} [input.projectRoot] - Project root (preferred).
 * @param {string} [input.sessionId] - Active session id (defaults to `OPENCODE_SESSION_ID`).
 * @param {string} [input.projectId] - Project id (defaults to `basename(projectRoot)`).
 * @param {object} [input.__testOverrides] - Injectables for tests.
 * @param {Function} [input.__testOverrides.runSessionStartRuntime]
 * @param {Function} [input.__testOverrides.spawnBackground]
 * @param {Function} [input.__testOverrides.buildHooks]
 * @returns {Promise<{ hooks: { 'chat.message': Function, 'tool.execute.after': Function } }>}
 *   On any capture-side failure, returns `{}` so OpenCode startup is never broken.
 */
export const PMCPlugin = async (input = {}) => {
  const {
    directory,
    projectRoot: projectRootInput,
    sessionId,
    projectId,
    __testOverrides = {},
  } = input;

  const projectRoot = projectRootInput ?? directory ?? process.cwd();
  const runStartup = __testOverrides.runSessionStartRuntime ?? runSessionStartRuntime;
  const spawn = __testOverrides.spawnBackground ?? spawnBackground;
  const buildHooks = __testOverrides.buildHooks ?? defaultBuildHooks;

  // W1: Preserve existing session-start behavior. Run it first; swallow errors
  // so PMC startup never blocks OpenCode.
  const startupPromise = (async () => {
    try {
      await runStartup(projectRoot, { mode: 'opencode-plugin' });
    } catch {
      // Silent by design: PMC startup must never block OpenCode startup.
    }
  })();

  // Session capture setup.
  const sid = sessionId || process.env.OPENCODE_SESSION_ID || 'unknown';
  const pid = projectId || basename(projectRoot);
  const queuePath = join(projectRoot, '.opencode', 'pmc-capture-queue.jsonl');

  let hooks = {};
  try {
    hooks = buildHooks(sid, pid, queuePath);
  } catch {
    // Capture must never break startup — fall through with empty hooks.
    hooks = {};
  }

  // Spawn the drainer in the background (detached + unref'd via spawnBackground).
  try {
    spawn(process.execPath, [DRAINER_PATH, projectRoot], { cwd: projectRoot });
  } catch {
    // Best-effort: a failed spawn is not fatal; the next session retries.
  }

  // Wait for session start to complete before returning so the snapshot is
  // written by the time OpenCode finishes plugin init.
  await startupPromise;

  return { hooks };
};
// No default export on purpose: OpenCode's loader may invoke every function
// export (including `default`), which would run startup twice per session.
