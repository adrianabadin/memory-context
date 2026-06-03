# PMC Portable NPM Package Design

**Date:** 2026-05-18
**Status:** Approved
**Scope:** Cross-platform (Windows/Linux/macOS) + cross-agent (opencode, Claude Code, Cursor, generic)

## Goal

Publish PMC as two npm packages that work on any OS and any AI coding agent:

- `@brain/project-memory-context` -- the main PMC engine + CLI + agent templates
- `@brain/agent-memory-mcp` -- fork of agent-memory-mcp with bge-m3 embedder

After `npm install -g @brain/project-memory-context @brain/agent-memory-mcp`, a user on any platform can run:

```bash
pmc init --agent opencode    # or claude-code, cursor, generic
pmc bootstrap .              # graphify + worklist + materialize 9 memories
pmc enrich .                 # batch enrichment with fallback chain
```

And then use `/new-project` (or equivalent agent command) to activate PMC in any repo.

## Package 1: `@brain/project-memory-context`

### Package Identity

```json
{
  "name": "@brain/project-memory-context",
  "version": "1.0.0",
  "description": "Persistent structured memory for AI coding agents. Graph-based symbol enrichment, 9 base project memories, cross-platform CLI.",
  "type": "module",
  "bin": { "pmc": "bin/pmc.mjs" },
  "exports": {
    ".": "./src/index.mjs",
    "./platform": "./src/platform.mjs",
    "./retrieval": "./src/retrieval/query-engine.mjs"
  },
  "files": ["bin/", "src/", "cli/", "templates/", "README.md", "LICENSE"],
  "engines": { "node": ">= 18.0.0" },
  "peerDependencies": {
    "@brain/agent-memory-mcp": ">=2.0.0"
  },
  "peerDependenciesMeta": {
    "@brain/agent-memory-mcp": { "optional": true }
  },
  "publishConfig": { "access": "public" }
}
```

### Directory Structure

```
@brain/project-memory-context/
  bin/
    pmc.mjs                         -- CLI entry point, routes subcommands
  src/
    platform.mjs                    -- NEW: cross-platform utilities
    enrichment-driver.mjs
    enrichment-config.mjs
    enrichment-errors.mjs
    enrichment-attempts.mjs
    sync-manifest.mjs
    symbol-index.mjs
    symbol-extractor.mjs
    symbol-keys.mjs
    graph-node-resolver.mjs
    materializer.mjs
    project-context-schema.mjs
    invalidation-matrix.mjs
    extractors/
      structure-extractor.mjs
      stack-extractor.mjs
      dependencies-extractor.mjs
      integrations-extractor.mjs
      architecture-extractor.mjs
      rules-extractor.mjs
    providers/
      local-model-provider.mjs      -- Ollama native API
      cloud-api-provider.mjs        -- OpenAI-compatible API
    retrieval/
      query-engine.mjs
      context-renderer.mjs
  cli/
    bootstrap.mjs                   -- renamed from new-project.mjs
    enrich.mjs                      -- renamed from enrich-queue.mjs
    sanitize.mjs
    context.mjs                     -- renamed from project-context.mjs
    init.mjs                        -- NEW: agent integration installer
    status.mjs                      -- NEW: show enrichment progress
  templates/
    opencode/
      commands/
        new-project.md
        get-context.md
        sync-context.md
        sanitize.md
      agent/
        enrich.md
      autostart-snippet.md
    claude-code/
      claude-md-snippet.md
    cursor/
      cursorrules-snippet.md
    generic/
      README-SETUP.md
  tests/
    platform.test.mjs               -- NEW
    ... (existing tests, adapted)
```

### CLI Binary: `bin/pmc.mjs`

Single entry point that routes to subcommands:

```
pmc init [--agent opencode|claude-code|cursor|generic]
    Install agent-specific integration files (commands, agents, autostart).
    Detects agent type from existing config dirs if --agent not specified.

pmc bootstrap [dir] [--all] [--enrich]
    Run graphify, build worklist, materialize 9 base memories, write sync-manifest.
    Equivalent to current /new-project command.
    If --enrich, launches background enrichment after bootstrap.

pmc enrich [dir] [--concurrency N]
    Run batch enrichment with fallback chain (local-model -> cloud-api -> agent-subagent).
    Equivalent to current enrich-queue.mjs.

pmc sanitize [dir]
    Re-run graphify, diff symbols, mark stale/removed, delete orphans.
    Optionally starts background enrichment for pending items.

pmc context [dir] [--refresh]
    Materialize/refresh the 9 base project-context memories.

pmc status [dir]
    Show enrichment progress: total, enriched, pending, stale, errors.
```

### New Module: `src/platform.mjs`

Centralizes all platform-specific code in one place.

#### `spawnBackground(command, args, cwd)`

Replaces all `start /B cmd /c` occurrences.

```js
import { spawn } from 'child_process';

export function spawnBackground(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    shell: process.platform === 'win32'
  });
  child.unref();
  return child.pid;
}
```

Used in: `cli/bootstrap.mjs` (--enrich flag), `cli/sanitize.mjs` (auto-enrich), templates (autostart).

#### `resolveGraphify()`

Replaces 3 duplicate `getGraphifyExe()` functions (in new-project.mjs, sanitize.mjs, setup.mjs).

```js
import { execSync } from 'child_process';

export function resolveGraphify() {
  // 1. PMC_GRAPHIFY_PATH env override
  if (process.env.PMC_GRAPHIFY_PATH) return process.env.PMC_GRAPHIFY_PATH;
  
  // 2. Try to find on PATH via which/where
  try {
    const cmd = process.platform === 'win32' ? 'where graphify' : 'which graphify';
    return execSync(cmd, { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {}
  
  // 3. Try common pip install locations
  // ... platform-specific search ...
  
  throw new Error(
    'graphify not found. Install it with: pip install graphifyy\n' +
    'Or set PMC_GRAPHIFY_PATH environment variable.'
  );
}
```

#### `resolveConfigDirs(projectRoot)`

Replaces hardcoded `.opencode/` and `~/.config/opencode/` paths.

```js
import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';

const PROJECT_CONFIG_DIRS = ['.pmc', '.opencode', '.claude', '.cursor'];
const GLOBAL_CONFIG_DIRS = [
  join(homedir(), '.config', 'pmc'),
  join(homedir(), '.config', 'opencode'),
  join(homedir(), '.claude')
];

export function resolveConfigDirs(projectRoot) {
  // PMC_CONFIG_DIR env override
  if (process.env.PMC_CONFIG_DIR) {
    return {
      projectConfig: join(projectRoot, process.env.PMC_CONFIG_DIR),
      globalConfig: join(homedir(), '.config', 'pmc')
    };
  }
  
  // Auto-detect from existing dirs
  const projectConfig = PROJECT_CONFIG_DIRS
    .map(d => join(projectRoot, d))
    .find(d => existsSync(d)) || join(projectRoot, '.pmc');
    
  const globalConfig = GLOBAL_CONFIG_DIRS
    .find(d => existsSync(d)) || join(homedir(), '.config', 'pmc');
    
  return { projectConfig, globalConfig };
}
```

#### `resolveAgentInstructionFiles()`

Replaces hardcoded `AGENTS.md` check in `invalidation-matrix.mjs`.

```js
const INSTRUCTION_FILES = [
  'AGENTS.md',      // opencode
  'CLAUDE.md',      // Claude Code
  'GEMINI.md',      // Gemini CLI
  '.cursorrules',   // Cursor
  '.windsurfrules'  // Windsurf
];

export function isAgentInstructionFile(filePath) {
  return INSTRUCTION_FILES.some(f => filePath.endsWith(f));
}
```

#### `resolvePythonBin()`

Replaces duplicated Python binary detection.

```js
export function resolvePythonBin() {
  if (process.platform === 'win32') return 'python';
  // Try python3 first on Unix
  try { execSync('python3 --version', { stdio: 'ignore' }); return 'python3'; } catch {}
  return 'python';
}
```

### Agent Integration: `cli/init.mjs`

The `pmc init --agent <type>` command installs agent-specific integration files.

**Scope:** `pmc init` performs both global operations (copying commands/agents to `~/.config/opencode/`) and project-level operations (writing config to `.opencode/` or `.pmc/`). It must be run from inside a project directory. Global files are installed once and shared across all projects; project-level config is per-project. Re-running `pmc init` is idempotent -- it overwrites templates with latest versions but preserves user-modified config files (checks for a `"userModified": true` marker).

#### What it does per agent type:

**opencode:**
1. Copies `templates/opencode/commands/*.md` → `~/.config/opencode/commands/`
2. Copies `templates/opencode/agent/enrich.md` → `~/.config/opencode/agent/`
3. Appends autostart block to `AGENTS.md` (if not already present)
4. Registers `@brain/agent-memory-mcp` in `.opencode/opencode.json` MCP config
5. Writes enrichment config to `.opencode/project-memory-context.json`

**claude-code:**
1. Appends PMC instructions to `CLAUDE.md` (commands as natural language instructions)
2. No custom commands (Claude Code doesn't support them) -- uses CLAUDE.md instructions
3. Agent-memory-mcp configured via `.mcp.json`

**cursor:**
1. Appends PMC instructions to `.cursorrules`
2. No custom commands -- uses .cursorrules instructions

**generic:**
1. Creates `.pmc/config.json` with enrichment config
2. Writes `README-SETUP.md` with manual integration guide
3. PMC works purely via CLI (`pmc bootstrap`, `pmc enrich`, etc.)

#### Template placeholders

Templates use `{{PLACEHOLDER}}` syntax resolved at init time:

| Placeholder | Resolved to |
|-------------|-------------|
| `{{PMC_BIN}}` | Absolute path to `pmc` CLI binary |
| `{{AGENT_MEMORY_CMD}}` | `agent-memory-mcp` or full path |
| `{{PROJECT_ROOT}}` | Current project directory |
| `{{CONFIG_DIR}}` | Agent-specific config directory |

### Config Resolution (updated)

The enrichment config file is always named `project-memory-context.json`. The directory where it lives depends on the detected agent:

```
Resolution order:
1. PMC_CONFIG_DIR env var (explicit override)
2. .pmc/project-memory-context.json (PMC-native)
3. .opencode/project-memory-context.json (opencode)
4. .claude/project-memory-context.json (Claude Code)
5. .cursor/project-memory-context.json (Cursor)
```

Global config:
```
1. PMC_GLOBAL_CONFIG env var
2. ~/.config/pmc/project-memory-context.json
3. ~/.config/opencode/project-memory-context.json
```

### Deprecated Scripts

The following legacy scripts remain in the codebase but are NOT published:
- `enrich-batch.mjs`, `batch-enrich.mjs`, `enrich-orchestrator.mjs`, `enrich-sync.mjs`
- `setup.mjs` (replaced by `cli/init.mjs`)
- `install-pmc.mjs` (replaced by npm install + `pmc init`)

### opencode Plugin Compatibility

The `plugin/index.mjs` file is preserved for backward compatibility with existing opencode installations that have `opencode-project-memory-context` in their plugin list. It delegates to the new CLI structure.

However, `pmc init --agent opencode` is the new recommended path and does not use the plugin system.

## Package 2: `@brain/agent-memory-mcp`

### Changes from current `@adamrdrew/agent-memory-mcp`

1. **Package name**: `@brain/agent-memory-mcp`
2. **Version**: `2.0.0` (breaking: scope change)
3. **Fix `server.ts:8`**: version string from `'1.0.0'` to dynamic or `'2.0.0'`
4. **README**: Updated with install instructions, model download size warning, supported platforms
5. **No code changes needed**: The codebase is already clean (zero hardcoded paths, zero platform-specific code)

### Embedder Configuration

Already configurable via env vars:
- `EMBEDDING_MODEL` (default: `Xenova/bge-m3`)
- `EMBEDDING_DIMENSIONS` (default: `1024`)
- `EMBEDDING_POOLING` (default: `cls`)

### Platform Support

LanceDB native addon supports: Linux x64/arm64, macOS x64/arm64, Windows x64.
Document in README.

## Refactoring Map

### Files to modify (existing → new behavior):

| Current file | Change | Reason |
|-------------|--------|--------|
| `cli/new-project.mjs` → `cli/bootstrap.mjs` | Import `platform.mjs` for `resolveGraphify`, `spawnBackground`, `resolveConfigDirs`, `resolvePythonBin`. Remove `getGraphifyExe()`, `installGraphify()`, `registerPlugin()`. | Cross-platform, decouple from opencode |
| `cli/enrich-queue.mjs` → `cli/enrich.mjs` | Import `resolveConfigDirs` from `platform.mjs`. Remove hardcoded `.opencode/` and `~/.config/opencode/` paths. | Config dir abstraction |
| `cli/sanitize.mjs` | Import `resolveGraphify`, `spawnBackground`, `resolveConfigDirs` from `platform.mjs`. Remove duplicate `getGraphifyExe()`. | Cross-platform, DRY |
| `cli/project-context.mjs` → `cli/context.mjs` | Minimal changes (already portable). | Rename for CLI consistency |
| `src/invalidation-matrix.mjs` | Replace `file.endsWith('AGENTS.md')` with `isAgentInstructionFile(file)`. | Multi-agent support |
| `src/enrichment-config.mjs` | Use `resolveConfigDirs()` instead of hardcoded paths. | Config dir abstraction |
| `src/setup-bootstrap.mjs` | Use `resolveConfigDirs()`. Remove `opencode.json` schema reference. | Decouple from opencode |
| `package.json` | New name, bin, files, dependency on `@brain/agent-memory-mcp`. | Publication |

### Files to create:

| File | Purpose |
|------|---------|
| `bin/pmc.mjs` | CLI router |
| `src/platform.mjs` | Cross-platform utilities |
| `cli/init.mjs` | Agent integration installer |
| `cli/status.mjs` | Enrichment progress display |
| `templates/opencode/commands/*.md` | opencode command templates |
| `templates/opencode/agent/enrich.md` | opencode subagent template |
| `templates/opencode/autostart-snippet.md` | AGENTS.md block template |
| `templates/claude-code/claude-md-snippet.md` | CLAUDE.md instructions |
| `templates/cursor/cursorrules-snippet.md` | .cursorrules instructions |
| `templates/generic/README-SETUP.md` | Manual setup guide |

### Files to delete or deprecate:

| File | Action |
|------|--------|
| `cli/install-pmc.mjs` | Deprecate (replaced by `npm install -g` + `pmc init`) |
| `cli/setup.mjs` | Deprecate (replaced by `pmc init`) |
| `mcp/agent-memory-wrapper.mjs` | Remove (replaced by direct `@brain/agent-memory-mcp` dependency) |
| `mcp/local-model-server.mjs` | Keep (standalone MCP server for local model, but unused in new flow) |
| `plugin/index.mjs` | Keep for backward compat, but not the primary path |

## User Flow

### New user, fresh machine

```bash
# 1. Install globally
npm install -g @brain/project-memory-context @brain/agent-memory-mcp

# 2. Install Python dependency
pip install graphifyy

# 3. Navigate to project
cd my-project

# 4. Initialize for your agent
pmc init --agent opencode    # auto-detects if --agent omitted

# 5. Bootstrap the project
pmc bootstrap . --all --enrich

# 6. In your agent session, run /sync-context to push to agent-memory
```

### Existing PMC user upgrading

```bash
# 1. Install new packages
npm install -g @brain/project-memory-context @brain/agent-memory-mcp

# 2. Re-init (preserves existing .planning/ data)
pmc init --agent opencode

# 3. Existing worklist.json, symbol-index.json, enrichments all preserved
# 4. Templates updated to latest versions
```

## Testing Strategy

All existing 135 tests continue to work. New tests needed:

| Test file | Tests |
|-----------|-------|
| `tests/platform.test.mjs` | `spawnBackground` (mock), `resolveGraphify` (mock PATH), `resolveConfigDirs` (multiple agent types), `isAgentInstructionFile`, `resolvePythonBin` |
| `tests/init.test.mjs` | Template copying, placeholder resolution, idempotency (re-init), each agent type |
| `tests/pmc-cli.test.mjs` | CLI router dispatches correctly, --help, unknown subcommand |

## Non-Goals

- **No runtime memory store abstraction**: The sync-manifest bridge pattern works. CLI writes to disk, agent consumes via its own tools. No need for a `MemoryStore` interface in the JS code.
- **No graphify replacement**: graphify (Python) remains an external dependency. A future JS-based AST parser could replace it, but that's out of scope.
- **No automated agent-memory migration**: Users on `@adamrdrew/agent-memory-mcp` need to manually switch to `@brain/agent-memory-mcp` and re-bootstrap.
- **No cloud-hosted memory option**: All storage remains local (LanceDB + disk files).
