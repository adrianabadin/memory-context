// tools/project-memory-context/plugin/index.mjs
// OpenCode plugin entrypoint. OpenCode auto-loads named exports from
// .opencode/plugins/*.mjs; the generated wrapper there re-exports PMCPlugin.
// Startup only reads disk state and spawns detached processes — it must
// never block or break OpenCode initialization.
import { runSessionStartRuntime } from '../src/session-start-runtime.mjs';

export const PMCPlugin = async ({ directory, __testOverrides } = {}) => {
  const runStartup = __testOverrides?.runSessionStartRuntime ?? runSessionStartRuntime;

  try {
    await runStartup(directory ?? process.cwd(), { mode: 'opencode-plugin' });
  } catch {
    // Silent by design: PMC startup must never block OpenCode startup.
  }

  return {};
};
// No default export on purpose: OpenCode's loader may invoke every function
// export (including `default`), which would run startup twice per session.
